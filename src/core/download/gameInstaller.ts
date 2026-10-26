// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 VSCL contributors
/**
 * 游戏版本安装（对应 HMCL `GameDownloadTask` / `GameAssetDownloadTask` / `GameLibrariesTask`）。
 * 流程：版本 JSON（含继承链）→ 客户端 jar → 资源索引 + 资源对象 → 库（含 natives classifier）→ log4j 配置。
 * 全程 SHA-1 校验 + 已存在跳过 + 并发池限流。
 */
import * as fs from "fs";
import * as path from "path";
import { DownloadPool, downloadFile, downloadWithFallback, httpGetJson, httpGetText } from "./downloader";
import { mapUrl } from "./mirror";
import { mergeVersion, readJson, DetailedVersionJson } from "../launch/versionMerge";
import { InstallSession, InstallCancelledError } from "./installSession";

/** 安装进度 */
export interface InstallProgress {
  phase: string;
  done: number;
  total: number;
}

/** 安装选项 */
export interface InstallOptions {
  gameDir: string;
  versionId: string;
  /** 每个文件完成后的聚合进度回调 */
  onProgress?: (p: InstallProgress) => void;
  /** 下载并发数 */
  threads: number;
  /** URL 映射 */
  source: "official" | "bmclapi";
  /** 安装会话（逐文件进度/取消埋点；可选） */
  tracker?: InstallSession;
}

/** 客户端 jar 下载信息（版本 JSON downloads.client） */
interface DownloadRef {
  sha1?: string;
  size?: number;
  url?: string;
}

/** 资源索引 */
interface AssetIndex {
  objects: Record<string, { hash: string; size: number }>;
}

/** 阶段进度跟踪器 */
class PhaseProgress {
  constructor(
    private readonly emit: InstallOptions["onProgress"],
    public phase: string,
    public total: number
  ) {}
  done = 0;
  step(): void {
    this.done++;
    this.emit?.({ phase: this.phase, done: this.done, total: this.total });
  }
}

/**
 * 安装指定游戏版本（幂等：全部文件按 SHA-1 校验，已存在且匹配则跳过）。
 */
export async function installVersion(opts: InstallOptions): Promise<void> {
  const { gameDir, versionId, source, threads } = opts;
  // ① 前置：版本 JSON（含父链）应已由 downloadVersionChain 就位

  const merged = mergeVersion(gameDir, versionId);
  if (!merged) {
    throw new Error(`无法解析版本 ${versionId}（JSON 缺失或损坏）`);
  }

  const pool = new DownloadPool(Math.max(1, threads));
  const map = (url: string) => mapUrl(url, source);
  const tasks: Promise<unknown>[] = [];

  // ② 客户端 jar（downloads.client 定义在基础版本 JSON 中，按 jarId 读取）
  const jarJson = readJson(gameDir, merged.jarId) as (DetailedVersionJson & { downloads?: { client?: DownloadRef } }) | undefined;
  const clientRef = jarJson?.downloads?.client;
  if (clientRef?.url) {
    opts.tracker?.checkCancelled();
    opts.tracker?.setPhase("安装 Minecraft 客户端", 1);
    const dest = path.join(gameDir, "versions", merged.jarId, `${merged.jarId}.jar`);
    tasks.push(
      pool
        .run(() => {
          opts.tracker?.itemStart("client-jar", `client.jar (${merged.jarId})`, clientRef.size ?? 0);
          return downloadWithFallback(
            map(clientRef.url!),
            clientRef.url!,
            dest,
            {
              sha1: clientRef.sha1,
              onProgress: (received, total) => opts.tracker?.itemProgress("client-jar", received, total),
            }
          );
        })
        .then(() => {
          opts.tracker?.itemDone("client-jar");
          opts.onProgress?.({ phase: "客户端", done: 1, total: 1 });
        })
    );
  }

  // ③ 资源索引与资源对象
  if (merged.assetIndexId && merged.assetIndexUrl) {
    const indexFile = path.join(gameDir, "assets", "indexes", `${merged.assetIndexId}.json`);
    tasks.push(
      (async () => {
        await pool.run(() => downloadWithFallback(map(merged.assetIndexUrl!), merged.assetIndexUrl!, indexFile, { sha1: merged.assetIndexSha1 }));
        let index: AssetIndex;
        try {
          index = JSON.parse(fs.readFileSync(indexFile, "utf8")) as AssetIndex;
        } catch {
          return;
        }
        const objects = Object.values(index.objects ?? {});
        const prog = new PhaseProgress(opts.onProgress, "资源", objects.length);
        opts.tracker?.setPhase("安装资源文件", objects.length);
        for (const obj of objects) {
          const dest = path.join(gameDir, "assets", "objects", obj.hash.slice(0, 2), obj.hash);
          const officialUrl = `https://resources.download.minecraft.net/${obj.hash.slice(0, 2)}/${obj.hash}`;
          const key = `asset-${obj.hash}`;
          tasks.push(
            pool
              .run(async () => {
                opts.tracker?.checkCancelled();
                opts.tracker?.itemStart(key, `assets/${obj.hash.slice(0, 2)}/${obj.hash}`, obj.size ?? 0);
                await downloadWithFallback(map(officialUrl), officialUrl, dest, { sha1: obj.hash, retries: 2, onProgress: (r, t) => opts.tracker?.itemProgress(key, r, t) });
              })
              .then(() => {
                opts.tracker?.itemDone(key);
                prog.step();
              })
              .catch(() => {
                opts.tracker?.itemDone(key); // 失败也计数（阶段进度不卡住）
                prog.step();
              }) // 单个资源失败不中断整体（游戏可能仍可运行）
          );
        }
      })()
    );
  }

  // ④ 库（artifacts + maven 推导 + natives classifiers）与 log4j
  const libPhase = new PhaseProgress(opts.onProgress, "依赖库", merged.libraries.length);
  /** 库相对路径：downloads.artifact.path 优先，其次按 group/artifact/version 推导（maven 布局） */
  const relPathOf = (lib: (typeof merged.libraries)[number]): string | undefined => {
    const parts = (lib.name ?? "").split(":");
    if (parts.length < 3) {
      return undefined;
    }
    const [group, artifact, version] = parts;
    const classifier = parts[3];
    const file = classifier ? `${artifact}-${version}-${classifier}.jar` : `${artifact}-${version}.jar`;
    return `${group.replace(/\./g, "/")}/${artifact}/${version}/${file}`;
  };
  for (const lib of merged.libraries) {
    if (!lib.name) {
      libPhase.total--;
      continue;
    }
    const artifactRef = lib.downloads?.artifact;
    const rel = artifactRef?.path ?? relPathOf(lib);
    /** 统一的库下载任务（含 tracker 埋点/取消检查） */
    const libTask = (key: string, url: string, dest: string, sha1?: string, tolerateMissing = false) =>
      tasks.push(
        pool
          .run(async () => {
            opts.tracker?.checkCancelled();
            opts.tracker?.itemStart(key, `libraries/${rel ?? key}`, 0);
            await downloadWithFallback(map(url), url, dest, { sha1, retries: 2, onProgress: (r, t) => opts.tracker?.itemProgress(key, r, t) });
          })
          .then(() => {
            opts.tracker?.itemDone(key);
            libPhase.step();
          })
          .catch((e) => {
            opts.tracker?.itemDone(key);
            libPhase.step();
            if (!tolerateMissing) {
              throw e;
            } // 官方库无此文件属正常（如仅本地库），不中断
          })
      );
    if (rel && artifactRef?.url) {
      // Mojang 标准格式（含 SHA-1）
      libTask(`lib-${lib.name}`, artifactRef.url!, path.join(gameDir, "libraries", rel), artifactRef.sha1);
    } else if (rel && lib.url) {
      // ModLoader profile 格式（name + maven url，无 SHA-1）
      const base = lib.url.endsWith("/") ? lib.url : `${lib.url}/`;
      libTask(`lib-${lib.name}`, `${base}${rel}`, path.join(gameDir, "libraries", rel));
    } else if (rel) {
      // 无下载地址（如游戏自带/仅本地）：按 maven 布局尝试官方库地址
      libTask(`lib-${lib.name}`, `https://libraries.minecraft.net/${rel}`, path.join(gameDir, "libraries", rel), undefined, true);
    } else {
      libPhase.total--;
      libPhase.done++;
    }
    // natives classifiers（供 prepareNatives 解压）
    for (const [classifier, ref] of Object.entries(lib.downloads?.classifiers ?? {})) {
      if (!ref.url || !ref.path) {
        continue;
      }
      // 仅下载当前平台所需 classifier（模板名含当前 OS 关键字）
      const wanted =
        (process.platform === "win32" && classifier.includes("windows")) ||
        (process.platform === "darwin" && (classifier.includes("osx") || classifier.includes("macos"))) ||
        (process.platform === "linux" && classifier.includes("linux"));
      if (!wanted) {
        continue;
      }
      libTask(`nat-${lib.name}-${classifier}`, ref.url!, path.join(gameDir, "libraries", ref.path!), ref.sha1);
    }
  }

  // log4j 配置
  if (merged.loggingFileId && merged.loggingFileUrl) {
    opts.tracker?.setPhase("安装日志配置", 1);
    const dest = path.join(gameDir, "assets", "log_configs", merged.loggingFileId);
    tasks.push(pool.run(() => downloadWithFallback(map(merged.loggingFileUrl!), merged.loggingFileUrl!, dest, { retries: 2 })));
  }

  await Promise.all(tasks);
}

/**
 * 下载版本 JSON 及其 inheritsFrom 父链（下载中心安装第一步）。
 * @param findEntry 从版本清单按 id 定位远端条目
 */
export async function downloadVersionChain(
  gameDir: string,
  versionId: string,
  findEntry: (id: string) => { url: string; sha1?: string } | undefined,
  source: "official" | "bmclapi",
  depth = 0
): Promise<void> {
  if (depth > 8) {
    return;
  }
  const existing = readJson(gameDir, versionId);
  if (!existing) {
    const entry = findEntry(versionId);
    if (!entry) {
      throw new Error(`版本清单中不存在：${versionId}`);
    }
    await downloadVersionJson(gameDir, versionId, entry.url, entry.sha1, source);
  }
  const json = readJson(gameDir, versionId);
  if (json?.inheritsFrom) {
    await downloadVersionChain(gameDir, json.inheritsFrom, findEntry, source, depth + 1);
  }
}

/** 单个版本 JSON 下载（URL 由清单条目提供） */
export async function downloadVersionJson(gameDir: string, versionId: string, url: string, sha1: string | undefined, source: "official" | "bmclapi"): Promise<void> {
  const dest = path.join(gameDir, "versions", versionId, `${versionId}.json`);
  await downloadFile(mapUrl(url, source), dest, { sha1 });
}
