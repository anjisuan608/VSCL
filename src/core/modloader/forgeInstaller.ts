// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 VSCL contributors
//
// 安装流程参考 XMCL `@xmcl/installer`（MIT License，Copyright (c) 2023 ci010）
// 与 HMCL `ForgeNewInstallTask` 的公开实现逻辑，以 VSCL 自有基建（minimalZip/
// downloader）独立编写：install_profile.json 解析、jar 内 maven 释放、BINPATCH
// 数据重写、processor（后处理器）经 Java 执行。
/**
 * Forge / NeoForge 安装引擎（新旧安装器统一：install_profile + processor 模型）。
 *
 * 流程：
 *  ① 下载 `<loader>-installer.jar`（官方 maven，BMCLAPI 可镜像）
 *  ② 解包：jar 内 `maven/` 释放到 `libraries/`；`data/*.lzma` 释放为
 *     `<profile.path>:clientdata/serverdata@lzma` 库并重写 BINPATCH 引用；
 *     `version.json`（或老格式 `versionInfo`）落位 `versions/<id>/`
 *  ③ 下载 `profile.libraries`（maven 布局，容错部分 404）
 *  ④ 执行 `processors`（side=client）：`java -cp <processor jar + libraries>
 *     <Main-Class> <inputs 展开>`（`[maven]` → libraries 路径，`{DATA}` →
 *     data 值递归解析），校验 `outputs` 存在
 *  ⑤ 返回新实例 id
 * 需要本机 Java（processor 为字节码补丁/下载工具，JRE 即可）。
 */
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { DownloadPool, downloadFile, httpGetText } from "../download/downloader";
import { mapUrl } from "../download/mirror";
import { extractZip, readZipEntry } from "../util/minimalZip";

/** Forge 系加载器 */
export type ForgeFamily = "forge" | "neoforge";

/** maven 根（官方源） */
const MAVEN_ROOT: Record<ForgeFamily, string> = {
  forge: "https://maven.minecraftforge.net",
  neoforge: "https://maven.neoforged.net/releases",
};

/** 版本列表项 */
export interface ForgeLoaderVersion {
  version: string;
  stable: boolean;
}

/** install_profile.json（新旧格式统一子集） */
interface InstallProfile {
  spec?: number;
  profile?: string;
  version?: string;
  /** 新格式：jar 内 version json 文件名 */
  json?: string;
  /** 版本库 maven 坐标，如 net.minecraftforge:forge:1.20.1-47.4.0 */
  path?: string;
  minecraft?: string;
  data?: Record<string, { client?: string; server?: string }>;
  processors?: {
    jar?: string;
    sides?: string[];
    inputs?: Record<string, string>;
    outputs?: Record<string, string>;
  }[];
  libraries?: { name: string; url?: string }[];
  /** 老格式（≤1.16）：完整版本 JSON */
  versionInfo?: Record<string, unknown> & { id?: string };
}

/** maven 坐标 → 库相对路径（支持 `:classifier@ext`） */
export function mavenToPath(coord: string): string {
  let c = coord;
  let ext = "jar";
  const at = c.indexOf("@");
  if (at >= 0) {
    ext = c.substring(at + 1);
    c = c.substring(0, at);
  }
  const parts = c.split(":");
  const [g, a, v] = parts;
  if (!g || !a || !v) {
    throw new Error(`无效 maven 坐标：${coord}`);
  }
  const cls = parts[3];
  const file = cls ? `${a}-${v}-${cls}.${ext}` : `${a}-${v}.${ext}`;
  return `${g.replace(/\./g, "/")}/${a}/${v}/${file}`;
}

/** 按坐标推断默认 maven 仓库地址 */
function defaultMavenUrl(name: string, kind: ForgeFamily): string {
  if (name.startsWith("net.minecraftforge:")) {
    return `${MAVEN_ROOT.forge}/`;
  }
  if (name.startsWith("net.neoforged:")) {
    return `${MAVEN_ROOT.neoforge}/`;
  }
  return "https://libraries.minecraft.net/";
}

/** 拉取 loader 版本列表（maven-metadata.xml；BMCLAPI 镜像可用） */
export async function fetchForgeFamilyVersions(kind: ForgeFamily, source: "official" | "bmclapi"): Promise<ForgeLoaderVersion[]> {
  const url =
    kind === "forge"
      ? `${MAVEN_ROOT.forge}/net/minecraftforge/forge/maven-metadata.xml`
      : `${MAVEN_ROOT.neoforge}/net/neoforged/neoforge/maven-metadata.xml`;
  const xml = await httpGetText(mapUrl(url, source));
  const versions = [...xml.matchAll(/<version>([^<]+)<\/version>/g)].map((m) => m[1]);
  return versions
    .reverse()
    .map((v) => ({ version: v, stable: !/-(rc|beta|alpha|pre)/i.test(v) }));
}

/** 从 jar 的 MANIFEST.MF 读取 Main-Class */
function readJarMainClass(jarPath: string): string | undefined {
  const mf = readZipEntry(jarPath, "META-INF/MANIFEST.MF")?.toString("utf8");
  return mf?.match(/^Main-Class:\s*(.+)$/m)?.[1]?.trim();
}

/** 安装选项 */
export interface ForgeInstallOptions {
  kind: ForgeFamily;
  gameDir: string;
  /** 基础 MC 版本 */
  gameVersion: string;
  /** loader 版本（forge 可传 "47.4.0" 或 "1.20.1-47.4.0"；neoforge 传 "21.1.209"） */
  version: string;
  /** 用于执行 processor 的 Java */
  javaExe: string;
  threads: number;
  source: "official" | "bmclapi";
  onProgress?: (message: string) => void;
}

/** 安装 Forge/NeoForge，返回新实例 id */
export async function installForgeFamily(o: ForgeInstallOptions): Promise<string> {
  const fullVer =
    o.kind === "forge" ? (o.version.startsWith(`${o.gameVersion}-`) ? o.version : `${o.gameVersion}-${o.version}`) : o.version;
  const artifactPath =
    o.kind === "forge"
      ? `net/minecraftforge/forge/${fullVer}/forge-${fullVer}-installer.jar`
      : `net/neoforged/neoforge/${fullVer}/neoforge-${fullVer}-installer.jar`;

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `vscl-${o.kind}-`));
  try {
    // ① 下载 installer（镜像优先，失败回落官方源）
    o.onProgress?.("下载安装器…");
    const installerJar = path.join(tmpDir, "installer.jar");
    const installerUrl = `${MAVEN_ROOT[o.kind]}/${artifactPath}`;
    try {
      await downloadFile(mapUrl(installerUrl, o.source), installerJar, { retries: 2 });
    } catch (mirrorError) {
      if (o.source === "bmclapi") {
        o.onProgress?.("镜像失败，回落官方源…");
        await downloadFile(installerUrl, installerJar, { retries: 2 });
      } else {
        throw mirrorError;
      }
    }

    // ② 解包
    o.onProgress?.("解析安装配置…");
    const work = path.join(tmpDir, "work");
    extractZip(installerJar, work);
    const profilePath = path.join(work, "install_profile.json");
    if (!fs.existsSync(profilePath)) {
      throw new Error("无效的安装器（缺少 install_profile.json）");
    }
    const profile = JSON.parse(fs.readFileSync(profilePath, "utf8")) as InstallProfile;
    const librariesDir = path.join(o.gameDir, "libraries");
    const mavenSrc = path.join(work, "maven");
    if (fs.existsSync(mavenSrc)) {
      fs.cpSync(mavenSrc, librariesDir, { recursive: true });
    }

    // 版本 JSON：新格式取 profile.json 指向的文件；老格式用 versionInfo
    let versionId: string;
    if (profile.json) {
      const vjPath = path.join(work, profile.json);
      const versionJson = JSON.parse(fs.readFileSync(vjPath, "utf8")) as Record<string, unknown> & { id?: string };
      versionId = versionJson.id ?? `forge-${fullVer}`;
      versionJson.id = versionId;
      const instanceDir = path.join(o.gameDir, "versions", versionId);
      fs.mkdirSync(instanceDir, { recursive: true });
      fs.writeFileSync(path.join(instanceDir, `${versionId}.json`), `${JSON.stringify(versionJson, null, 2)}\n`, "utf8");
    } else if (profile.versionInfo) {
      versionId = profile.versionInfo.id ?? `forge-${fullVer}`;
      profile.versionInfo.id = versionId;
      const instanceDir = path.join(o.gameDir, "versions", versionId);
      fs.mkdirSync(instanceDir, { recursive: true });
      fs.writeFileSync(
        path.join(instanceDir, `${versionId}.json`),
        `${JSON.stringify(profile.versionInfo, null, 2)}\n`,
        "utf8"
      );
    } else {
      throw new Error("install_profile.json 缺少 version json（json / versionInfo）");
    }
    const instanceDir = path.join(o.gameDir, "versions", versionId);
    fs.writeFileSync(path.join(instanceDir, "install_profile.json"), `${JSON.stringify(profile, null, 2)}\n`, "utf8");

    // data/*.lzma → maven 库释放 + BINPATCH 重写（对齐 XMCL unpackForgeInstaller）
    const baseCoord = profile.path;
    if (baseCoord) {
      const [g, a, v] = baseCoord.split(":");
      const mavenBase = `${g.replace(/\./g, "/")}/${a}/${v}/${a}-${v}`;
      const lzmaMap: Record<string, string> = {};
      const dataDir = path.join(work, "data");
      if (fs.existsSync(dataDir)) {
        for (const name of fs.readdirSync(dataDir)) {
          if (!name.endsWith(".lzma")) {
            continue;
          }
          const classifier = name === "client.lzma" ? "clientdata" : name === "server.lzma" ? "serverdata" : `${name.replace(/\.lzma$/, "")}data`;
          const rel = `${mavenBase}-${classifier}.lzma`;
          fs.mkdirSync(path.dirname(path.join(librariesDir, rel)), { recursive: true });
          fs.copyFileSync(path.join(dataDir, name), path.join(librariesDir, rel));
          lzmaMap[`/data/${name}`] = `[${baseCoord}:${classifier}@lzma]`;
        }
      }
      profile.data = profile.data ?? {};
      profile.data.INSTALLER = { client: `[${baseCoord}:installer]`, server: `[${baseCoord}:installer]` };
      if (profile.data.BINPATCH) {
        for (const side of ["client", "server"] as const) {
          const ref = profile.data.BINPATCH[side];
          if (ref && lzmaMap[ref]) {
            profile.data.BINPATCH[side] = lzmaMap[ref];
          }
        }
      }
    }

    // ③ profile.libraries 下载（部分 server-only 库 404 属正常，settle 容忍）
    o.onProgress?.("下载组件库…");
    const pool = new DownloadPool(Math.max(1, o.threads));
    const libs = (profile.libraries ?? []).filter((l) => l.name);
    await Promise.allSettled(
      libs.map((l) =>
        pool.run(async () => {
          const rel = mavenToPath(l.name);
          const base = l.url ?? defaultMavenUrl(l.name, o.kind);
          const url = `${base.endsWith("/") ? base : `${base}/`}${rel}`;
          await downloadFile(mapUrl(url, o.source), path.join(librariesDir, rel), { retries: 2 });
        })
      )
    );

    // ④ processors（client side）
    const processors = (profile.processors ?? []).filter((p) => !p.sides || p.sides.includes("client"));
    const sep = process.platform === "win32" ? ";" : ":";
    const libPaths = libs.map((l) => path.join(librariesDir, mavenToPath(l.name)));
    const dataVal = (key: string): string => {
      const raw = profile.data?.[key]?.client;
      if (raw === undefined) {
        throw new Error(`install_profile data 缺少 ${key}.client`);
      }
      if (raw.startsWith("[") && raw.endsWith("]")) {
        return path.join(librariesDir, mavenToPath(raw.slice(1, -1)));
      }
      return path.join(o.gameDir, raw);
    };
    let idx = 0;
    for (const p of processors) {
      idx++;
      o.onProgress?.(`后处理 ${idx}/${processors.length}…`);
      if (!p.jar) {
        continue;
      }
      const processorJar = path.join(librariesDir, mavenToPath(p.jar));
      if (!fs.existsSync(processorJar)) {
        throw new Error(`processor 依赖缺失：${p.jar}（maven 下载失败）`);
      }
      const mainClass = readJarMainClass(processorJar);
      if (!mainClass) {
        throw new Error(`processor 缺少 Main-Class：${p.jar}`);
      }
      const expand = (raw: string): string => raw.replace(/\{(\w+)\}/g, (_m, key: string) => dataVal(key));
      const args = Object.values(p.inputs ?? {}).map(expand);
      const outputs = Object.values(p.outputs ?? {}).map(expand);
      const cp = [processorJar, ...libPaths].filter((f) => fs.existsSync(f)).join(sep);
      const r = spawnSync(o.javaExe, ["-cp", cp, mainClass, ...args], {
        cwd: o.gameDir,
        encoding: "utf8",
        timeout: 10 * 60 * 1000,
        windowsHide: true,
      });
      if (r.status !== 0) {
        throw new Error(`后处理器失败（${p.jar}）：${(r.stderr || r.stdout || "").trim().slice(-400) || `exit=${r.status}`}`);
      }
      for (const out of outputs) {
        if (!fs.existsSync(out)) {
          throw new Error(`后处理器输出缺失：${path.basename(out)}`);
        }
      }
    }
    return versionId;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}
