// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 VSCL contributors
/**
 * Modrinth 整合包（.mrpack）安装。
 * 流程：解压 → modrinth.index.json → 依赖基础版本（含 Fabric/Quilt 自动安装）→
 *       按 files 列表下载（SHA-1 校验）→ overrides 覆盖解压。
 * Forge/NeoForge 包暂不支持（需 Java processor，V2 计划）。
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { DownloadPool, downloadFile } from "../download/downloader";
import { extractZip } from "../util/minimalZip";
import { installFabricLike } from "../modloader/fabricFamily";

/** mrpack 的 modrinth.index.json */
export interface MrpackIndex {
  formatVersion: number;
  game: string;
  versionId?: string;
  name?: string;
  summary?: string;
  files: {
    path: string;
    hashes: { sha1?: string; sha512?: string };
    downloads?: string[];
    env?: { client?: string; server?: string };
  }[];
  dependencies: Record<string, string>;
}

/** 读取并校验 mrpack 索引 */
export function readMrpackIndex(mrpackPath: string): { index: MrpackIndex; extractDir: string } {
  const extractDir = fs.mkdtempSync(path.join(os.tmpdir(), "vscl-mrpack-"));
  extractZip(mrpackPath, extractDir);
  const indexPath = path.join(extractDir, "modrinth.index.json");
  if (!fs.existsSync(indexPath)) {
    throw new Error("不是有效的 mrpack（缺少 modrinth.index.json）");
  }
  const index = JSON.parse(fs.readFileSync(indexPath, "utf8")) as MrpackIndex;
  if (index.game !== "minecraft") {
    throw new Error(`不支持的游戏：${index.game}`);
  }
  return { index, extractDir };
}

/** 安装选项 */
export interface MrpackInstallOptions {
  mrpackPath: string;
  gameDir: string;
  threads: number;
  source: "official" | "bmclapi";
  /** 进度：阶段与 计数/总数 */
  onProgress?: (message: string) => void;
}

/** 实例 id 安全化（去除路径非法字符） */
function sanitizeId(raw: string): string {
  return raw.replace(/[\\/:*?"<>|]/g, "_").trim() || `mrpack-${Date.now()}`;
}

/** overlays 目录复制到实例根（overrides / client-overrides） */
function applyOverrides(extractDir: string, instanceDir: string): void {
  for (const sub of ["overrides", "client-overrides"]) {
    const src = path.join(extractDir, sub);
    if (fs.existsSync(src)) {
      fs.cpSync(src, instanceDir, { recursive: true });
    }
  }
}

/**
 * 安装 mrpack。
 * @returns 新实例 id
 */
export async function installMrpack(opts: MrpackInstallOptions): Promise<string> {
  const { index, extractDir } = readMrpackIndex(opts.mrpackPath);
  try {
    const mcVersion = index.dependencies["minecraft"];
    if (!mcVersion) {
      throw new Error("索引缺少 minecraft 依赖版本");
    }
    const fabricLoader = index.dependencies["fabric-loader"];
    const quiltLoader = index.dependencies["quilt-loader"];
    if (index.dependencies["forge"] || index.dependencies["neoforge"]) {
      throw new Error("Forge/NeoForge 整合包暂不支持（需要 Java processor，V2 版本支持）");
    }

    // ① 基础版本 + 加载器
    opts.onProgress?.("准备基础版本…");
    let baseId = mcVersion;
    if (fabricLoader) {
      baseId = await installFabricLike({
        gameDir: opts.gameDir,
        gameVersion: mcVersion,
        loaderVersion: fabricLoader,
        kind: "fabric",
        threads: opts.threads,
        source: opts.source,
      });
    } else if (quiltLoader) {
      baseId = await installFabricLike({
        gameDir: opts.gameDir,
        gameVersion: mcVersion,
        loaderVersion: quiltLoader,
        kind: "quilt",
        threads: opts.threads,
        source: opts.source,
      });
    }

    // ② 实例目录（以 base 版本为模板复制 JSON，形成独立实例）
    const instanceId = sanitizeId(index.versionId ?? index.name ?? baseId);
    const instanceDir = path.join(opts.gameDir, "versions", instanceId);
    if (fs.existsSync(instanceDir)) {
      throw new Error(`实例已存在：${instanceId}`);
    }
    fs.mkdirSync(instanceDir, { recursive: true });
    // 派生 JSON：id 改名 + jar/inheritsFrom 指向 base
    const baseJsonPath = path.join(opts.gameDir, "versions", baseId, `${baseId}.json`);
    const baseJson = JSON.parse(fs.readFileSync(baseJsonPath, "utf8")) as Record<string, unknown>;
    const derived: Record<string, unknown> = { ...baseJson, id: instanceId, inheritsFrom: baseId, jar: baseId };
    delete derived["downloads"];
    delete derived["assetIndex"];
    delete derived["assets"];
    fs.writeFileSync(path.join(instanceDir, `${instanceId}.json`), `${JSON.stringify(derived, null, 2)}\n`, "utf8");

    // ③ 文件下载（仅 client 必需；SHA-1 校验）
    const files = index.files.filter((f) => f.env?.client !== "disabled" && (f.downloads?.length ?? 0) > 0);
    const pool = new DownloadPool(Math.max(1, opts.threads));
    let done = 0;
    await Promise.all(
      files.map((f) =>
        pool.run(async () => {
          const dest = path.join(instanceDir, f.path);
          await downloadFile(f.downloads![0], dest, { sha1: f.hashes.sha1, retries: 2 });
          done++;
          opts.onProgress?.(`文件 ${done}/${files.length}`);
        })
      )
    );

    // ④ overrides 覆盖
    opts.onProgress?.("应用 overrides…");
    applyOverrides(extractDir, instanceDir);
    return instanceId;
  } finally {
    fs.rmSync(extractDir, { recursive: true, force: true });
  }
}
