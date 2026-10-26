// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 VSCL contributors
/**
 * 实例 Mod 目录管理（列目录 / 启用禁用 .disabled 后缀 / 删除）。
 * 对齐 HMCL `ModManager` 的 `.disabled` 语义。
 */
import * as fs from "fs";
import * as path from "path";
import { parseModMeta, ModMeta } from "./modFile";

/** 一个 Mod 文件 */
export interface ModEntry {
  fileName: string;
  path: string;
  size: number;
  /** 是否启用（.disabled 后缀 = 停用） */
  enabled: boolean;
  meta: ModMeta;
}

const MOD_EXT = /\.(jar|zip|litemod)$/i;

/** 列出实例 mods 目录（含停用项） */
export function listMods(instanceDir: string): ModEntry[] {
  const modsDir = path.join(instanceDir, "mods");
  let names: string[];
  try {
    names = fs.readdirSync(modsDir);
  } catch {
    return [];
  }
  const result: ModEntry[] = [];
  for (const name of names) {
    const enabled = !name.toLowerCase().endsWith(".disabled");
    const bareName = enabled ? name : name.slice(0, -".disabled".length);
    if (!MOD_EXT.test(bareName)) {
      continue;
    }
    const filePath = path.join(modsDir, name);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(filePath);
    } catch {
      continue;
    }
    if (!stat.isFile()) {
      continue;
    }
    result.push({ fileName: bareName, path: filePath, size: stat.size, enabled, meta: parseModMeta(filePath) });
  }
  return result.sort((a, b) => a.fileName.localeCompare(b.fileName));
}

/** 启用/停用 Mod（rename 加/去 .disabled 后缀） */
export function setModEnabled(entry: ModEntry, enabled: boolean): void {
  const target = enabled ? entry.path.slice(0, -".disabled".length) : `${entry.path}.disabled`;
  fs.renameSync(entry.path, target);
}

/** 删除 Mod 文件（停用态一并处理） */
export function deleteMod(entry: ModEntry): void {
  fs.rmSync(entry.path, { force: true });
}

/** mods 目录路径 */
export function modsDirOf(instanceDir: string): string {
  return path.join(instanceDir, "mods");
}
