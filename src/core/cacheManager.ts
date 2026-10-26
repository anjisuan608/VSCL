// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 VSCL contributors
/**
 * 扩展缓存管理（VS Code 扩展最佳实践：可再生数据统一放 globalStorageUri 下，
 * 不写用户工作区；本模块集中管理 globalStorage/cache/ 目录的大小统计与清理）。
 * 缓存内容：版本清单等可再生数据（游戏文件本体在游戏目录，不属于缓存）。
 */
import * as fs from "fs";
import * as path from "path";

/** 缓存根目录（globalStorage/cache） */
export function cacheRoot(globalStoragePath: string): string {
  return path.join(globalStoragePath, "cache");
}

/** 递归统计目录占用（字节）与文件数 */
export function cacheStats(dir: string): { bytes: number; files: number } {
  let bytes = 0;
  let files = 0;
  const walk = (d: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        walk(p);
      } else {
        try {
          bytes += fs.statSync(p).size;
          files++;
        } catch {
          /* 忽略竞态删除 */
        }
      }
    }
  };
  walk(dir);
  return { bytes, files };
}

/** 清空缓存目录（保留目录本身） */
export function clearCache(dir: string): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // 目录不存在
  }
  for (const e of entries) {
    fs.rmSync(path.join(dir, e.name), { recursive: true, force: true });
  }
}

/** 人类可读大小 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
