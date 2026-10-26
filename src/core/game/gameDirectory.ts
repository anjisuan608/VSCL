// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 VSCL contributors
/**
 * 游戏目录解析（设计基线 5.4 / 5.9）。
 *
 * 优先级链：显式设置 > 工作区文件夹（特征检测命中）> 注册表激活目录 > 官方启动器目录。
 * 防误判：工作区文件夹必须通过特征检测（versions/saves/mods/assets/logs 或含 .minecraft 子目录）
 *        才可作为游戏目录，避免把普通代码目录误判为游戏数据目录。
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { DirectorySource } from "../state/store";

/** 特征检测结果 */
export interface DirectoryProbe {
  /** 该路径本身是游戏目录 */
  isGameDir: boolean;
  /** 该路径下嵌套的 .minecraft 目录（工作区根包含 .minecraft 时给出） */
  nestedMinecraft?: string;
}

/** 特征目录名（存在任一即认为具备游戏目录特征） */
const MARKERS = ["versions", "saves", "mods", "assets", "logs"];

/** 官方启动器默认游戏目录（Windows / macOS / Linux） */
export function officialGameDirectory(): string {
  const home = os.homedir();
  switch (process.platform) {
    case "win32":
      return path.join(process.env["APPDATA"] ?? path.join(home, "AppData", "Roaming"), ".minecraft");
    case "darwin":
      return path.join(home, "Library", "Application Support", "minecraft");
    default:
      return path.join(process.env["XDG_DATA_HOME"] ?? path.join(home, ".local", "share"), ".minecraft");
  }
}

/** 对路径做游戏目录特征检测 */
export function probeGameDirectory(dir: string): DirectoryProbe {
  const result: DirectoryProbe = { isGameDir: false };
  let stat: fs.Stats;
  try {
    stat = fs.statSync(dir);
  } catch {
    return result;
  }
  if (!stat.isDirectory()) {
    return result;
  }
  // 本身含特征目录
  for (const marker of MARKERS) {
    if (fs.existsSync(path.join(dir, marker))) {
      result.isGameDir = true;
      return result;
    }
  }
  // 嵌套 .minecraft 子目录
  const nested = path.join(dir, ".minecraft");
  if (fs.existsSync(nested)) {
    try {
      if (fs.statSync(nested).isDirectory()) {
        result.nestedMinecraft = nested;
      }
    } catch {
      /* 忽略 */
    }
  }
  return result;
}

/** 目录解析结果 */
export interface ResolvedDirectory {
  dir: string;
  source: DirectorySource;
  /** source === "workspace" 时，是否经过特征检测确认 */
  confirmed: boolean;
}

export interface ResolveContext {
  /** 当前工作区文件夹根路径列表 */
  workspaceRoots: string[];
  /** 注册表目录（vscl.gameDirectories） */
  registered: string[];
  /** 显式激活目录（vscl.activeGameDirectory，可空） */
  activeSetting: string;
}

function samePath(a: string, b: string): boolean {
  const norm = (p: string) => path.normalize(p).replace(/[\\/]+$/, "").toLowerCase();
  return norm(a) === norm(b);
}

/**
 * 按优先级链解析当前游戏目录。
 * 注：工作区文件夹未命中特征检测时**不**作为游戏目录（confirmed=false 由上层决定是否询问用户）。
 */
export function resolveActiveDirectory(ctx: ResolveContext): ResolvedDirectory {
  // ① 显式设置（存在即用，信任用户）
  if (ctx.activeSetting.trim().length > 0 && fs.existsSync(ctx.activeSetting)) {
    return { dir: ctx.activeSetting, source: "registered", confirmed: true };
  }

  // ② 工作区文件夹（特征检测命中：本身是游戏目录，或嵌套 .minecraft）
  for (const root of ctx.workspaceRoots) {
    const probe = probeGameDirectory(root);
    if (probe.isGameDir) {
      return { dir: root, source: "workspace", confirmed: true };
    }
    if (probe.nestedMinecraft) {
      return { dir: probe.nestedMinecraft, source: "workspace", confirmed: true };
    }
  }

  // ③ 注册表中第一个存在的目录
  for (const dir of ctx.registered) {
    if (fs.existsSync(dir)) {
      return { dir, source: "registered", confirmed: true };
    }
  }

  // ④ 官方启动器目录（默认兜底；不存在也返回，由上层决定是否引导创建/添加）
  const official = officialGameDirectory();
  return { dir: official, source: "official", confirmed: fs.existsSync(official) };
}

/** 判断路径是否等于指定目录（用于 UI 侧的目录切换比较） */
export function isSameDirectory(a: string, b: string): boolean {
  return samePath(a, b);
}
