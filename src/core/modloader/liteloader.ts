// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 VSCL contributors
//
// 安装结构参考 HMCL `LiteLoaderInstallTask` 的公开实现：launchwrapper 主类 +
// `--tweakClass com.mumfrey.liteloader.launch.LiteLoaderTweaker` + liteloader maven 库。
/**
 * LiteLoader 安装（已停更组件，使用内置静态版本表 resources/liteloader-versions.json，
 * 数据为公开的 Maven 事实信息：坐标/URL/tweakClass）。
 * 生成标准版本 JSON（无 processor），库文件经通用安装器补齐。
 */
import * as fs from "fs";
import * as path from "path";
import { downloadVersionChain, installVersion } from "../download/gameInstaller";

/** 内置表条目 */
export interface LiteLoaderEntry {
  gameVersion: string;
  version: string;
  url: string;
  tweakClass: string;
  libraries: { name: string; url?: string }[];
}

/** 读取内置版本表（按 MC 版本过滤） */
export async function fetchLiteLoaderVersions(tablePath: string, mcVersion: string): Promise<LiteLoaderEntry[]> {
  try {
    const all = JSON.parse(fs.readFileSync(tablePath, "utf8")) as LiteLoaderEntry[];
    return all.filter((e) => e.gameVersion === mcVersion);
  } catch {
    return [];
  }
}

/** 安装选项 */
export interface LiteLoaderInstallOptions {
  gameDir: string;
  /** 基础 MC 版本 */
  gameVersion: string;
  entry: LiteLoaderEntry;
  threads: number;
  source: "official" | "bmclapi";
  /** 自定义实例/客户端名称 */
  customId?: string;
}

/**
 * 安装 LiteLoader，返回新实例 id。
 * 版本 JSON：mainClass=launchwrapper、game args `--tweakClass`、
 * libraries = 表条目库 + `com.mumfrey:liteloader:<version>`（官方仓库直链）。
 */
export async function installLiteLoader(opts: LiteLoaderInstallOptions): Promise<string> {
  const { gameDir, gameVersion, entry } = opts;
  // 基础版本 JSON 就位（含父链）
  await downloadVersionChain(
    gameDir,
    gameVersion,
    () => undefined,
    opts.source
  ).catch((e) => {
    throw new Error(`基础版本 ${gameVersion} 未安装（${e instanceof Error ? e.message : String(e)}），请先在下载中心安装`);
  });

  const newId = opts.customId?.trim() || `${gameVersion}-Liteloader_${entry.version}`;
  const json = {
    id: newId,
    inheritsFrom: gameVersion,
    type: "release",
    mainClass: "net.minecraft.launchwrapper.Launch",
    arguments: { game: ["--tweakClass", entry.tweakClass], jvm: [] },
    libraries: [
      ...(entry.libraries ?? []),
      // liteloader 本体：下方预下载至 libraries 的 maven 路径（无需远端 url）
      { name: `com.mumfrey:liteloader:${entry.version}` },
    ],
  };
  const instanceDir = path.join(gameDir, "versions", newId);
  fs.mkdirSync(instanceDir, { recursive: true });
  fs.writeFileSync(path.join(instanceDir, `${newId}.json`), `${JSON.stringify(json, null, 2)}\n`, "utf8");

  // 补齐依赖库（liteloader 本体的 lib.url 目录下按 maven 布局推导会失败——
  // 直接预下载该 jar 到 libraries 的 maven 路径）
  const libRel = mavenPath("com.mumfrey", "liteloader", entry.version);
  const dest = path.join(gameDir, "libraries", libRel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const { downloadFile } = await import("../download/downloader");
  await downloadFile(entry.url, dest, { retries: 2 });

  await installVersion({ gameDir, versionId: newId, source: opts.source, threads: opts.threads });
  return newId;
}

/** maven 坐标 → 库相对路径 */
function mavenPath(group: string, artifact: string, version: string): string {
  return `${group.replace(/\./g, "/")}/${artifact}/${version}/${artifact}-${version}.jar`;
}
