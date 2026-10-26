// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 VSCL contributors
/**
 * 实例覆盖配置 `.vscl/config/vsclversion.json`（设计基线 5.9 惰性覆盖模型）。
 *
 * 模型：omit = inherit —— 文件中只存放被覆盖的键；缺失的键继承全局设置。
 *  - 修改某项 → 创建/更新文件中的对应键（首次修改才创建文件）
 *  - 恢复跟随 → 删除对应键；文件变空则删除文件本身（"无文件 = 纯跟随"）
 */
import * as fs from "fs";
import * as path from "path";
import type { GlobalGameSettings } from "../../config/settings";

/** 实例覆盖键集合（与 schemas/vsclversion.schema.json 对应） */
export interface InstanceOverrides {
  parent?: string;
  icon?: string;
  javaPath?: string;
  minMemory?: number;
  maxMemory?: number;
  jvmArgs?: string[];
  quickPlay?: string;
  windowType?: string;
  width?: number;
  height?: number;
  processPriority?: string;
  launcherVisibility?: string;
  environmentVariables?: string;
  preLaunchCommand?: string;
  postExitCommand?: string;
  showLogs?: boolean;
  enableDebugLogOutput?: boolean;
}

/** 可被实例覆盖的配置键 */
export type OverrideKey = "javaPath" | "minMemory" | "maxMemory" | "jvmArgs" | "quickPlay" | "icon";

/** 覆盖配置文件路径：<实例目录>/.vscl/config/vsclversion.json */
export function overrideFilePath(instanceDir: string): string {
  return path.join(instanceDir, ".vscl", "config", "vsclversion.json");
}

/** 读取实例覆盖（文件不存在或损坏时返回空对象） */
export function loadOverrides(instanceDir: string): InstanceOverrides {
  try {
    const text = fs.readFileSync(overrideFilePath(instanceDir), "utf8");
    const obj = JSON.parse(text) as InstanceOverrides;
    return typeof obj === "object" && obj !== null ? obj : {};
  } catch {
    return {};
  }
}

/** 写回覆盖文件；对象为空时删除文件（保持"无文件 = 纯跟随"语义） */
function saveOverrides(instanceDir: string, overrides: InstanceOverrides): void {
  const filePath = overrideFilePath(instanceDir);
  const meaningful = Object.entries(overrides).filter(
    ([k, v]) => k !== "$schema" && v !== undefined && !(Array.isArray(v) && v.length === 0)
  );
  if (meaningful.length === 0) {
    // 文件变空 → 删除（连同空目录尽力清理）
    try {
      fs.rmSync(filePath, { force: true });
      fs.rmSync(path.dirname(filePath), { recursive: true, force: true });
    } catch {
      /* 忽略 */
    }
    return;
  }
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const out: Record<string, unknown> = { parent: overrides.parent ?? "default" };
  for (const [k, v] of meaningful) {
    out[k] = v;
  }
  // 原子写：临时文件 + rename，防止中断产生损坏 JSON
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(out, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, filePath);
}

/** 设置一个覆盖项（value 为 undefined 表示恢复跟随） */
export function setOverride(instanceDir: string, key: OverrideKey, value: InstanceOverrides[OverrideKey]): void {
  const overrides = loadOverrides(instanceDir);
  if (value === undefined) {
    delete overrides[key];
  } else {
    (overrides as Record<string, unknown>)[key] = value;
  }
  saveOverrides(instanceDir, overrides);
}

/** 恢复某项为跟随全局（等价于 setOverride(key, undefined)） */
export function resetOverride(instanceDir: string, key: OverrideKey): void {
  setOverride(instanceDir, key, undefined);
}

/** 全局设置 ⊕ 实例覆盖后的生效设置 */
export interface EffectiveGameSettings {
  minMemory: number;
  maxMemory: number;
  jvmArgs: string[];
  javaPath?: string;
  quickPlay?: string;
  /** 窗口模式（覆盖值） */
  windowType?: string;
  width?: number;
  height?: number;
  processPriority?: string;
  launcherVisibility?: string;
  /** KEY=VALUE 每行一条 */
  environmentVariables?: string;
  preLaunchCommand?: string;
  postExitCommand?: string;
  showLogs?: boolean;
  enableDebugLogOutput?: boolean;
}

/** 全局设置 ⊕ 实例覆盖 → 生效配置（浅合并，数组整体替换） */
export function effectiveSettings(global: GlobalGameSettings, overrides: InstanceOverrides): EffectiveGameSettings {
  return {
    minMemory: overrides.minMemory ?? global.minMemory,
    maxMemory: overrides.maxMemory ?? global.maxMemory,
    jvmArgs: overrides.jvmArgs ?? global.jvmArgs,
    javaPath: overrides.javaPath,
    quickPlay: overrides.quickPlay,
    windowType: overrides.windowType,
    width: overrides.width,
    height: overrides.height,
    processPriority: overrides.processPriority,
    launcherVisibility: overrides.launcherVisibility,
    environmentVariables: overrides.environmentVariables,
    preLaunchCommand: overrides.preLaunchCommand,
    postExitCommand: overrides.postExitCommand,
    showLogs: overrides.showLogs,
    enableDebugLogOutput: overrides.enableDebugLogOutput,
  };
}
