// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 VSCL contributors
/**
 * 启动命令构建（对应 HMCL `DefaultLauncher.generateCommandLine` 的 TS 独立实现）。
 * 职责：OS/架构规则展开、classpath 构建、natives 解压、占位符替换、
 *       JVM/game 参数段组装、内存与 log4j 注入。
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { ArgumentEntry, MergedVersion, RawLibrary } from "./versionMerge";
import { extractZip } from "../util/minimalZip";
import { DownloadPool, downloadWithFallback } from "../download/downloader";
import { mapUrl } from "../download/mirror";

/** 规则匹配所需的上下文特征（含 Mojang 的 features 门控语义） */
export interface RuleFeatures {
  os: "windows" | "osx" | "linux";
  arch: string; // process.arch
  is32: boolean;
  /** 特征门控（is_quick_play_* / has_custom_resolution / is_demo_user），缺省视为 false */
  features: Record<string, boolean>;
}

/** 构建参数 */
export interface BuildRequest {
  merged: MergedVersion;
  gameDir: string; // 游戏根（.minecraft）
  instanceDir: string; // versions/<id>
  javaExe: string;
  identity: { username: string; uuid: string; accessToken: string; userType: string };
  /** 智能内存（HMCL autoMemory 同款）：启用时 minMemory 为下限、上限按系统内存计算；禁用时 maxMemory 为固定上限 */
  autoMemory: boolean;
  minMemory: number;
  maxMemory: number;
  extraJvmArgs: string[];
  quickPlay?: string;
  /** 窗口模式（WINDOWED/FULLSCREEN/MAXIMIZED） */
  windowType?: string;
  width?: number;
  height?: number;
  /** 进程优先级（LOW/BELOW_NORMAL/NORMAL/ABOVE_NORMAL/HIGH） */
  processPriority?: string;
  /** 环境变量（KEY=VALUE 每行一条） */
  environmentVariables?: string;
  /** 启用 debug 日志（-Dlog4j.debug） */
  enableDebugLogOutput?: boolean;
  /** VSCL 内置 log4j2 模板路径（官方配置缺失时的兜底，对应 HMCL 内置模板做法） */
  log4jTemplatePath?: string;
}

/** 构建结果 */
export interface BuildResult {
  command: string;
  args: string[];
  /** 游戏进程环境变量增量 */
  env: Record<string, string>;
  /** Linux 进程优先级 nice 值（1..19；0 表示不调整）；Windows 暂不支持 */
  niceValue: number;
  classpathCount: number;
  warnings: string[];
}

/** Mojang OS 名映射 */
export function currentOs(): RuleFeatures["os"] {
  switch (process.platform) {
    case "win32":
      return "windows";
    case "darwin":
      return "osx";
    default:
      return "linux";
  }
}

/**
 * 规则匹配（Mojang 语义：默认 disallow，逐条应用匹配的规则，最后一条匹配生效）。
 * os 与 features（is_quick_play_* / has_custom_resolution / is_demo_user）均须匹配——
 * 缺 features 匹配会导致 --quickPlay* 等门控参数被全部注入（游戏报
 * "Only one quick play option can be specified"）。
 */
export function rulesAllow(
  rules: { os?: { name?: string; arch?: string }; features?: Record<string, boolean>; action: string }[] | undefined,
  f: RuleFeatures
): boolean {
  if (!rules || rules.length === 0) {
    return true;
  }
  let allowed = false;
  for (const rule of rules) {
    let match = true;
    if (rule.os?.name && rule.os.name !== f.os) {
      match = false;
    }
    if (match && rule.os?.arch) {
      if (rule.os.arch === "x86" !== f.is32) {
        match = false;
      }
    }
    if (match && rule.features) {
      for (const [key, want] of Object.entries(rule.features)) {
        if ((f.features[key] ?? false) !== want) {
          match = false;
          break;
        }
      }
    }
    if (match) {
      allowed = rule.action === "allow";
    }
  }
  return allowed;
}

/** `group:artifact:version[:classifier]` → 库文件相对路径 */
function libraryPath(name: string, classifier?: string): string | undefined {
  const parts = name.split(":");
  if (parts.length < 3) {
    return undefined;
  }
  const [group, artifact, version] = parts;
  const cls = classifier ?? parts[3];
  const file = cls ? `${artifact}-${version}-${cls}.jar` : `${artifact}-${version}.jar`;
  return `${group.replace(/\./g, "/")}/${artifact}/${version}/${file}`;
}

/** natives classifier 名（${arch} 替换；32 位 JVM → x86） */
function nativesClassifier(template: string, f: RuleFeatures): string {
  return template.replace(/\$\{arch\}/g, f.is32 ? "x86" : "x86");
}

/** 展开 arguments 段（rules + string|string[] value），并做占位符替换 */
function expandArgs(entries: ArgumentEntry[] | undefined, f: RuleFeatures, vars: Record<string, string>): string[] {
  const out: string[] = [];
  for (const entry of entries ?? []) {
    if (typeof entry === "string") {
      out.push(replaceVars(entry, vars));
      continue;
    }
    if (!rulesAllow(entry.rules, f)) {
      continue;
    }
    const values = typeof entry.value === "string" ? [entry.value] : entry.value ?? [];
    for (const v of values) {
      out.push(replaceVars(v, vars));
    }
  }
  return out;
}

/** 占位符替换 */
function replaceVars(text: string, vars: Record<string, string>): string {
  return text.replace(/\$\{(\w+)\}/g, (m, key: string) => (key in vars ? vars[key] : m));
}

/** 旧版（≤1.12）minecraftArguments 拆分 */
function splitLegacyArgs(commandLine: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(commandLine)) !== null) {
    out.push(m[1] ?? m[2] ?? m[3]);
  }
  return out;
}

/**
 * 解压 natives classifier jar 到官方位置 `<instanceDir>/<jarId>-natives`。
 * 目录已存在则跳过；缺失 jar 时返回警告（不中断启动——部分新版本无 natives 亦可运行）。
 */
export function prepareNatives(merged: MergedVersion, gameDir: string, instanceDir: string, f: RuleFeatures): { dir: string; warnings: string[] } {
  const warnings: string[] = [];
  const nativesDir = path.join(instanceDir, `${merged.jarId}-natives`);
  const targets: { lib: RawLibrary; classifier: string }[] = [];
  for (const lib of merged.libraries) {
    if (!lib.natives) {
      continue;
    }
    const key = f.os in lib.natives ? f.os : Object.keys(lib.natives).includes(f.os) ? f.os : undefined;
    const template = lib.natives[key ?? f.os];
    if (!template || !rulesAllow(lib.rules, f)) {
      continue;
    }
    targets.push({ lib, classifier: nativesClassifier(template, f) });
  }
  if (targets.length === 0) {
    return { dir: nativesDir, warnings };
  }
  // 已解压且非空 → 跳过
  try {
    if (fs.existsSync(nativesDir) && fs.readdirSync(nativesDir).length > 0) {
      return { dir: nativesDir, warnings };
    }
  } catch {
    /* 继续解压 */
  }
  fs.mkdirSync(nativesDir, { recursive: true });
  for (const { lib, classifier } of targets) {
    const rel =
      lib.downloads?.classifiers?.[classifier]?.path ??
      libraryPath(lib.name ?? "", classifier.split("-").pop()); // 兼容 natives-windows-${arch} 简单推导
    const relPath = rel ?? (lib.name ? libraryPath(lib.name, classifier) : undefined);
    if (!relPath) {
      continue;
    }
    const jarPath = path.join(gameDir, "libraries", relPath);
    if (!fs.existsSync(jarPath)) {
      warnings.push(`natives 缺失：${relPath}（可在设置中重新校验/安装组件）`);
      continue;
    }
    try {
      extractZip(jarPath, nativesDir);
    } catch (e) {
      warnings.push(`natives 解压失败：${relPath}（${e instanceof Error ? e.message : String(e)}）`);
    }
  }
  return { dir: nativesDir, warnings };
}

/**
 * 启动前完整性补全（XMCL diagnose+repair 同思路的启动集成）：
 *  - 资产对象：读本地 asset index，存在性检查（毫秒级，不做全量 hash），仅下载缺失
 *    （修复 HMCL 安装实例的语言文件等资产缺失 → 游戏回退英文）
 *  - classpath 库：逐项存在性检查，缺失者按合并 JSON 的下载源补下（镜像优先、官方回落）
 * 全部文件已就位时快速返回（仅少量 existsSync 开销）。
 */
export async function ensureGameFiles(opts: {
  gameDir: string;
  merged: MergedVersion;
  /** buildLaunchCommand 构建的 classpath 绝对路径列表 */
  classpath: string[];
  source: "official" | "bmclapi";
  threads: number;
  onProgress?: (message: string) => void;
}): Promise<{ missingAssets: number; downloadedAssets: number; missingLibs: number; downloadedLibs: number }> {
  const { gameDir, merged, classpath, source, threads } = opts;
  const map = (url: string) => mapUrl(url, source);
  const tasks: Promise<void>[] = [];
  let downloadedAssets = 0;
  let missingAssets = 0;

  // ── 资产对象（存在性） ──
  const indexFile = merged.assetIndexId ? path.join(gameDir, "assets", "indexes", `${merged.assetIndexId}.json`) : undefined;
  if (indexFile) {
    if (!fs.existsSync(indexFile) && merged.assetIndexUrl) {
      opts.onProgress?.("下载资源索引…");
      await downloadWithFallback(map(merged.assetIndexUrl), merged.assetIndexUrl, indexFile, { sha1: merged.assetIndexSha1 });
    }
    try {
      const index = JSON.parse(fs.readFileSync(indexFile!, "utf8")) as { objects?: Record<string, { hash: string }> };
      const missing: { hash: string }[] = [];
      for (const obj of Object.values(index.objects ?? {})) {
        if (!fs.existsSync(path.join(gameDir, "assets", "objects", obj.hash.slice(0, 2), obj.hash))) {
          missing.push(obj);
        }
      }
      missingAssets = missing.length;
      if (missing.length > 0) {
        opts.onProgress?.(`补齐缺失资源 ${missing.length} 个…`);
        const pool = new DownloadPool(Math.max(1, threads));
        for (const obj of missing) {
          const officialUrl = `https://resources.download.minecraft.net/${obj.hash.slice(0, 2)}/${obj.hash}`;
          tasks.push(
            pool
              .run(() => downloadWithFallback(map(officialUrl), officialUrl, path.join(gameDir, "assets", "objects", obj.hash.slice(0, 2), obj.hash), { sha1: obj.hash, retries: 2 }))
              .then(() => {
                downloadedAssets++;
              })
              .catch(() => {
                /* 单个资源失败不阻断启动 */
              })
          );
        }
      }
    } catch {
      /* index 不可读时跳过（游戏会自行报错） */
    }
  }

  // ── classpath 库（存在性） ──
  const missingLibs = classpath.filter((p) => !fs.existsSync(p));
  if (missingLibs.length > 0) {
    opts.onProgress?.(`补齐缺失依赖库 ${missingLibs.length} 个…`);
    // 按合并 JSON 的库声明推导缺失库的下载地址
    const relRoot = path.join(gameDir, "libraries");
    const libOf = new Map<string, RawLibrary>();
    for (const lib of merged.libraries) {
      if (!lib.name) {
        continue;
      }
      const parts = lib.name.split(":");
      if (parts.length < 3) {
        continue;
      }
      const [g, a, v] = parts;
      const cls = parts[3];
      const file = cls ? `${a}-${v}-${cls}.jar` : `${a}-${v}.jar`;
      libOf.set(path.join(relRoot, g.replace(/\./g, "/"), a, v, file), lib);
    }
    const pool = new DownloadPool(Math.max(1, threads));
    let downloadedLibs = 0;
    for (const p of missingLibs) {
      const lib = libOf.get(path.normalize(p));
      const rel = path.relative(relRoot, p).replace(/\\/g, "/");
      const base =
        lib?.downloads?.artifact?.url ??
        (lib?.url ? `${lib.url.endsWith("/") ? lib.url : `${lib.url}/`}${rel}` : `https://libraries.minecraft.net/${rel}`);
      tasks.push(
        pool
          .run(() => downloadWithFallback(map(base), base, p, { sha1: lib?.downloads?.artifact?.sha1, retries: 2 }))
          .then(() => {
            downloadedLibs++;
          })
          .catch(() => {
            /* 缺失库下载失败时游戏会给出明确报错 */
          })
      );
    }
  }

  await Promise.all(tasks);
  return { missingAssets, downloadedAssets, missingLibs: 0, downloadedLibs: 0 };
}

/** 构建完整启动命令 */
export function buildLaunchCommand(req: BuildRequest): BuildResult {
  const { merged, gameDir, instanceDir } = req;
  const warnings: string[] = [];
  const f: RuleFeatures = {
    os: currentOs(),
    arch: process.arch,
    is32: process.arch === "ia32",
    features: {
      is_demo_user: false,
      // 对齐 HMCL：恒为 false——版本 JSON 中 has_custom_resolution 门控的
      // --width/--height 块（占位符为硬编码值）始终关闭，窗口尺寸由启动器显式传参
      has_custom_resolution: false,
      has_quick_plays_support: !!req.quickPlay,
      is_quick_play_singleplayer: !!req.quickPlay,
      is_quick_play_multiplayer: false,
      is_quick_play_realms: false,
    },
  };

  // —— classpath 与 natives ——
  const classpath: string[] = [];
  for (const lib of merged.libraries) {
    if (!rulesAllow(lib.rules, f) || !lib.name) {
      continue;
    }
    const rel = lib.downloads?.artifact?.path ?? libraryPath(lib.name);
    if (rel) {
      classpath.push(path.join(gameDir, "libraries", rel));
    }
  }
  const clientJar = path.join(gameDir, "versions", merged.jarId, `${merged.jarId}.jar`);
  if (!fs.existsSync(clientJar)) {
    warnings.push(`客户端 jar 缺失：${clientJar}`);
  }
  classpath.push(clientJar);
  const cpValue = classpath.join(process.platform === "win32" ? ";" : ":");

  const { dir: nativesDir, warnings: nativeWarnings } = prepareNatives(merged, gameDir, instanceDir, f);
  warnings.push(...nativeWarnings);

  // —— 占位符变量表 ——
  const assetsRoot = path.join(gameDir, "assets");
  const vars: Record<string, string> = {
    auth_player_name: req.identity.username,
    version_name: merged.id,
    game_directory: instanceDir,
    assets_root: assetsRoot,
    assets_index_name: merged.assetIndexId ?? merged.assets ?? "legacy",
    auth_uuid: req.identity.uuid.replace(/-/g, ""),
    auth_access_token: req.identity.accessToken,
    clientid: "vscl",
    auth_xuid: "0",
    user_type: req.identity.userType,
    version_type: merged.type ?? "release",
    natives_directory: nativesDir,
    launcher_name: "vscl",
    launcher_version: "0.0.1",
    classpath: cpValue,
    classpath_separator: process.platform === "win32" ? ";" : ":",
    library_directory: path.join(gameDir, "libraries"),
    resolution_width: "854",
    resolution_height: "480",
    quickPlaySingleplayer: req.quickPlay ?? "",
    quickPlayMultiplayer: "",
    quickPlayRealms: "",
  };

  // —— JVM 段 ——
  const jvm: string[] = [];
  if (req.autoMemory) {
    // 智能内存（HMCL autoMemory 同款）：填写值为下限，上限按系统内存 1/4 计算
    const totalMB = Math.floor(os.totalmem() / 1024 / 1024);
    const smartMax = Math.max(Math.min(Math.floor(totalMB / 4), 16384), req.minMemory);
    if (req.minMemory > 0) {
      jvm.push(`-Xms${Math.round(req.minMemory)}M`);
    }
    jvm.push(`-Xmx${smartMax}M`);
  } else {
    // 手动：填写值为固定上限（-Xms 交由 JVM 自管）
    if (req.maxMemory > 0) {
      jvm.push(`-Xmx${Math.round(req.maxMemory)}M`);
    }
  }
  // log4j 配置注入：官方文件（版本 JSON logging.client.file）优先；
  // 缺失时兜底使用 VSCL 内置模板（HMCL 同思路，保证日志格式/级别受控）
  if (merged.loggingArgument) {
    let log4jPath = merged.loggingFileId ? path.join(assetsRoot, "log_configs", merged.loggingFileId) : "";
    if (!log4jPath || !fs.existsSync(log4jPath)) {
      if (req.log4jTemplatePath && fs.existsSync(req.log4jTemplatePath)) {
        const fallback = path.join(assetsRoot, "log_configs", "vscl-log4j2.xml");
        fs.mkdirSync(path.dirname(fallback), { recursive: true });
        if (!fs.existsSync(fallback)) {
          fs.copyFileSync(req.log4jTemplatePath, fallback);
        }
        log4jPath = fallback;
      } else {
        warnings.push(`log4j 配置缺失：log_configs/${merged.loggingFileId ?? "?"}（下载中心完整安装后生成）`);
      }
    }
    if (log4jPath && fs.existsSync(log4jPath)) {
      jvm.push(replaceVars(merged.loggingArgument, { path: log4jPath }));
    }
  }
  if (req.enableDebugLogOutput) {
    jvm.push("-Dlog4j.debug");
  }
  jvm.push(...expandArgs(merged.jvmArgs, f, vars));
  if (!jvm.includes("-cp") && !jvm.includes("-classpath")) {
    jvm.push("-cp", cpValue); // 老 Forge JSON 缺省 classpath 段
  }
  jvm.push(...req.extraJvmArgs);

  // —— game 段 ——
  let game: string[];
  if (merged.gameArgs) {
    game = expandArgs(merged.gameArgs, f, vars);
  } else if (merged.minecraftArguments) {
    game = splitLegacyArgs(replaceVars(merged.minecraftArguments, vars));
  } else {
    game = [];
  }
  if (req.quickPlay && !game.includes(req.quickPlay)) {
    // 现代版本经 ${quickPlaySingleplayer} 占位展开；老版本无该参数则忽略（避免非法参数崩溃）
    if (!merged.gameArgs?.some((a) => typeof a !== "string" || a.includes("quickPlay"))) {
      warnings.push("当前游戏版本不支持 Quick Play，已忽略");
    }
  }
  // 窗口参数（对齐 HMCL：由启动器显式传参，不受 JSON 门控）：
  // 宽高有值即注入（windowType 未设置也生效）；全屏另行追加 --fullscreen
  if (merged.gameArgs) {
    if (req.windowType === "FULLSCREEN") {
      game.push("--fullscreen");
    }
    if (req.width && req.height) {
      game.push("--width", String(Math.round(req.width)), "--height", String(Math.round(req.height)));
    }
    // MAXIMIZED 无 CLI 等价参数（由游戏内视频设置处理）
  }

  // 环境变量（KEY=VALUE 每行一条，# 开头为注释）
  const env: Record<string, string> = {};
  for (const line of (req.environmentVariables ?? "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const eq = trimmed.indexOf("=");
    if (eq > 0) {
      env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
    }
  }

  // 进程优先级 → Linux nice 值（正值降低优先级；负值需 root 不采用）。Windows 暂不支持。
  const NICE: Record<string, number> = { LOW: 19, BELOW_NORMAL: 10, NORMAL: 0, ABOVE_NORMAL: 0, HIGH: 0 };
  const niceValue = process.platform === "linux" ? (NICE[req.processPriority ?? ""] ?? 0) : 0;
  if (req.processPriority && process.platform !== "linux" && req.processPriority !== "NORMAL") {
    warnings.push("进程优先级目前仅 Linux 支持，已忽略");
  }

  if (!merged.mainClass) {
    throw new Error(`版本 ${merged.id} 缺少 mainClass`);
  }
  return {
    command: req.javaExe,
    args: [...jvm, merged.mainClass, ...game],
    env,
    niceValue,
    classpathCount: classpath.length,
    warnings,
  };
}
