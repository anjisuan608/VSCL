// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 VSCL contributors
/**
 * 工作区级实例选择持久化（<工作区>/.vscode/vscl/config/vsclworkspace.json）。
 * 记录该工作区上一次使用的实例，下次打开工作区时恢复；实例已不存在时忽略。
 * 无工作区（官方目录场景）时不落文件，由 workspaceState 兜底（多窗口隔离）。
 */
import * as fs from "fs";
import * as path from "path";

/** 配置文件结构 */
export interface VsclWorkspaceConfig {
  version: 1;
  selectedInstanceId: string;
}

/** 配置文件路径 */
export function workspaceConfigPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".vscode", "vscl", "config", "vsclworkspace.json");
}

/** 读取工作区上次选中的实例（文件缺失/损坏返回 undefined → 上层回落） */
export function readWorkspaceSelection(workspaceRoot: string): string | undefined {
  try {
    const cfg = JSON.parse(fs.readFileSync(workspaceConfigPath(workspaceRoot), "utf8")) as Partial<VsclWorkspaceConfig>;
    return typeof cfg.selectedInstanceId === "string" && cfg.selectedInstanceId.length > 0
      ? cfg.selectedInstanceId
      : undefined;
  } catch {
    return undefined;
  }
}

/** 实时写入工作区实例选择（切换即写；失败静默——只读工作区等场景回落 workspaceState） */
export function writeWorkspaceSelection(workspaceRoot: string, instanceId: string): void {
  try {
    const file = workspaceConfigPath(workspaceRoot);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const cfg: VsclWorkspaceConfig = { version: 1, selectedInstanceId: instanceId };
    fs.writeFileSync(file, `${JSON.stringify(cfg, null, 2)}\n`, "utf8");
  } catch {
    /* 只读工作区等场景忽略 */
  }
}

/** 清空工作区实例选择（删除配置文件——恢复"未记录"状态） */
export function clearWorkspaceSelection(workspaceRoot: string): void {
  try {
    fs.rmSync(workspaceConfigPath(workspaceRoot), { force: true });
  } catch {
    /* 忽略 */
  }
}

/**
 * 工作区数据目录（<工作区>/.minecraft）是否存在有效实例：
 * versions/ 下存在至少一个含同名版本 JSON 的目录（与 scanInstances 同标准）。
 */
export function hasWorkspaceGameInstances(workspaceRoot: string): boolean {
  const versionsDir = path.join(workspaceRoot, ".minecraft", "versions");
  try {
    return fs
      .readdirSync(versionsDir, { withFileTypes: true })
      .some((d) => d.isDirectory() && fs.existsSync(path.join(versionsDir, d.name, `${d.name}.json`)));
  } catch {
    return false; // versions 不存在/不可读 → 无有效实例
  }
}

/** 当前工作区根（取第一个文件夹；无工作区返回 undefined） */
export function firstWorkspaceRoot(
  folders: readonly { uri: { fsPath: string } }[] | undefined
): string | undefined {
  return folders && folders.length > 0 ? folders[0].uri.fsPath : undefined;
}
