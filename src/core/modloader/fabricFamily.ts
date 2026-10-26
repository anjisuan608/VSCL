// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 VSCL contributors
/**
 * Fabric / Quilt 安装（对齐 HMCL `FabricInstallTask` / `QuiltInstallTask`）。
 * 采用官方 launcher profile API（profile/json 自带 mainClass 与完整依赖库列表，
 * 含 ASM 等），生成 inheritsFrom 基础版本的补丁 JSON，再经通用安装器补齐库文件。
 */
import * as fs from "fs";
import * as path from "path";
import { httpGetJson } from "../download/downloader";
import { downloadVersionChain, installVersion } from "../download/gameInstaller";

/** Fabric 系加载器 */
export type FabricLike = "fabric" | "quilt";

/** meta 服务端点 */
const META: Record<FabricLike, { versions: string; profile: (mc: string, loader: string) => string }> = {
  fabric: {
    versions: "https://meta.fabricmc.net/v2/versions/loader",
    profile: (mc, loader) => `https://meta.fabricmc.net/v2/versions/loader/${mc}/${loader}/profile/json`,
  },
  quilt: {
    versions: "https://meta.quiltmc.org/v2/versions/loader",
    profile: (mc, loader) => `https://meta.quiltmc.org/v2/versions/loader/${mc}/${loader}/profile/json`,
  },
};

/** loader 版本列表项 */
export interface LoaderVersion {
  version: string;
  stable: boolean;
}

/** 获取 loader 版本列表（stable 优先） */
export async function fetchLoaderVersions(kind: FabricLike): Promise<LoaderVersion[]> {
  const raw = await httpGetJson<{ version: string; stable?: boolean }[]>(META[kind].versions);
  return raw
    .map((x) => ({ version: x.version, stable: !!x.stable }))
    .sort((a, b) => Number(b.stable) - Number(a.stable) || b.version.localeCompare(a.version, undefined, { numeric: true }));
}

/** profile API 返回（官方 installer 的合并产物） */
interface LauncherProfile {
  id: string;
  inheritsFrom?: string;
  type?: string;
  mainClass: string | { client?: string; server?: string };
  arguments?: { game?: unknown[]; jvm?: unknown[] };
  libraries: { name: string; url?: string }[];
}

/** 安装选项 */
export interface InstallLoaderOptions {
  gameDir: string;
  /** 目标基础版本（原版版本 id） */
  gameVersion: string;
  loaderVersion: string;
  kind: FabricLike;
  threads: number;
  source: "official" | "bmclapi";
}

/**
 * 安装 Fabric/Quilt 到指定基础版本。
 * @returns 新实例 id（如 "fabric-loader-0.16.9-1.21.1"）
 */
export async function installFabricLike(opts: InstallLoaderOptions): Promise<string> {
  const { gameDir, gameVersion, loaderVersion, kind } = opts;
  // ① 基础版本 JSON 就位（含父链）
  await downloadVersionChain(
    gameDir,
    gameVersion,
    () => undefined, // 基础版本应在下载中心已安装；未安装时给出明确错误
    opts.source
  ).catch((e) => {
    throw new Error(`基础版本 ${gameVersion} 未安装（${e instanceof Error ? e.message : String(e)}），请先在下载中心安装`);
  });

  // ② 官方 profile
  const profile = await httpGetJson<LauncherProfile>(META[kind].profile(gameVersion, loaderVersion));
  const mainClass = typeof profile.mainClass === "string" ? profile.mainClass : profile.mainClass.client;
  if (!mainClass) {
    throw new Error("profile 缺少 mainClass");
  }
  const newId = profile.id;
  const jsonPath = path.join(gameDir, "versions", newId, `${newId}.json`);
  fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
  fs.writeFileSync(
    jsonPath,
    `${JSON.stringify(
      {
        id: newId,
        inheritsFrom: gameVersion,
        type: "release",
        mainClass,
        arguments: profile.arguments,
        libraries: profile.libraries,
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  // ③ 补齐库文件（profile 库为 maven 布局，通用安装器处理）
  await installVersion({
    gameDir,
    versionId: newId,
    source: opts.source,
    threads: opts.threads,
  });
  return newId;
}
