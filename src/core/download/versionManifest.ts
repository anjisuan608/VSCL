// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 VSCL contributors
/** Mojang 版本清单（version_manifest_v2）获取与内存+磁盘缓存。 */
import * as fs from "fs";
import * as path from "path";
import { httpGetJson } from "./downloader";
import { mapUrl, VERSION_MANIFEST_URL } from "./mirror";

export interface RemoteVersionEntry {
  id: string;
  type: "release" | "snapshot" | "old_beta" | "old_alpha" | string;
  url: string;
  time: string;
  releaseTime: string;
  sha1?: string;
}

export interface VersionManifest {
  latest: { release: string; snapshot: string };
  versions: RemoteVersionEntry[];
}

/** 清单缓存有效期（5 分钟） */
const CACHE_TTL_MS = 5 * 60 * 1000;

export class VersionManifestSource {
  private cache?: { manifest: VersionManifest; fetchedAt: number };

  constructor(
    private readonly cacheDir: string,
    private readonly source: () => "official" | "bmclapi"
  ) {}

  /** 获取清单（先内存、再磁盘、最后网络） */
  async fetch(force = false): Promise<VersionManifest> {
    const now = Date.now();
    if (!force && this.cache && now - this.cache.fetchedAt < CACHE_TTL_MS) {
      return this.cache.manifest;
    }
    const cacheFile = path.join(this.cacheDir, "version_manifest_v2.json");
    // 磁盘缓存（15 分钟内直接用）
    if (!force && fs.existsSync(cacheFile)) {
      try {
        const stat = fs.statSync(cacheFile);
        if (now - stat.mtimeMs < 15 * 60 * 1000) {
          const manifest = JSON.parse(fs.readFileSync(cacheFile, "utf8")) as VersionManifest;
          this.cache = { manifest, fetchedAt: now };
          return manifest;
        }
      } catch {
        /* 走网络 */
      }
    }
    const url = mapUrl(VERSION_MANIFEST_URL, this.source());
    const manifest = await httpGetJson<VersionManifest>(url);
    try {
      fs.mkdirSync(this.cacheDir, { recursive: true });
      fs.writeFileSync(cacheFile, JSON.stringify(manifest), "utf8");
    } catch {
      /* 缓存写失败不影响使用 */
    }
    this.cache = { manifest, fetchedAt: now };
    return manifest;
  }

  /** 按 id 查找版本条目 */
  async find(versionId: string): Promise<RemoteVersionEntry | undefined> {
    const manifest = await this.fetch();
    return manifest.versions.find((v) => v.id === versionId);
  }
}
