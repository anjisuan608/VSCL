// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 VSCL contributors
/**
 * VSCL 设置读写封装（对应 package.json `contributes.configuration`）。
 * 约定：机器级路径类设置为 `scope: "machine"`，不进入设置同步。
 */
import * as vscode from "vscode";

/** 全局游戏设置（原生设置界面管理的单例配置） */
export interface GlobalGameSettings {
  minMemory: number;
  maxMemory: number;
  jvmArgs: string[];
}

export namespace Settings {
  function cfg(): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration("vscl");
  }

  /** 手动指定的 Java 路径（空串表示未指定） */
  export function javaPath(): string {
    return cfg().get<string>("javaPath", "");
  }

  /** 额外注册的游戏目录 */
  export function gameDirectories(): string[] {
    return cfg().get<string[]>("gameDirectories", []).filter((d) => d.trim().length > 0);
  }

  /** 显式激活的游戏目录（空串表示自动选择） */
  export function activeGameDirectory(): string {
    return cfg().get<string>("activeGameDirectory", "");
  }

  /** 是否使用 VS Code 内置浏览器打开链接 */
  export function useIntegratedBrowser(): boolean {
    return cfg().get<boolean>("useIntegratedBrowser", false);
  }

  /** 下载源 */
  export function downloadSource(): "official" | "bmclapi" {
    return cfg().get<"official" | "bmclapi">("downloadSource", "bmclapi");
  }

  /** 全局游戏设置（vscl.game.*） */
  export function globalGameSettings(): GlobalGameSettings {
    return {
      minMemory: cfg().get<number>("game.minMemory", 512),
      maxMemory: cfg().get<number>("game.maxMemory", 4096),
      jvmArgs: cfg().get<string[]>("game.jvmArgs", []),
    };
  }

  /** 添加游戏目录到注册表（去重） */
  export async function addGameDirectory(dir: string): Promise<void> {
    const list = gameDirectories();
    const normalized = vscode.Uri.file(dir).fsPath;
    if (list.some((d) => vscode.Uri.file(d).fsPath === normalized)) {
      return;
    }
    await cfg().update("gameDirectories", [...list, normalized], vscode.ConfigurationTarget.Global);
  }

  /** 从注册表移除游戏目录 */
  export async function removeGameDirectory(dir: string): Promise<void> {
    const normalized = vscode.Uri.file(dir).fsPath;
    const list = gameDirectories().filter((d) => vscode.Uri.file(d).fsPath !== normalized);
    await cfg().update("gameDirectories", list, vscode.ConfigurationTarget.Global);
  }

  /** 设置显式激活目录（空串 = 恢复自动选择） */
  export async function setActiveGameDirectory(dir: string): Promise<void> {
    await cfg().update("activeGameDirectory", dir, vscode.ConfigurationTarget.Global);
  }
}
