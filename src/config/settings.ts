// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 VSCL contributors
/**
 * 设置读写门面。
 * 数据源分层：
 *  - 游戏/下载/Java/目录等 → 扩展自管 globalStorage/settings.json（ConfigStore）
 *  - vscl.useIntegratedBrowser / vscl.microsoftClientId → VS Code 配置系统（原生界面保留项）
 */
import * as vscode from "vscode";
import type { ConfigStore, VsclSettings } from "../core/configStore";

/** 全局游戏设置（智能内存模型） */
export interface GlobalGameSettings {
  autoMemory: boolean;
  minMemory: number;
  maxMemory: number;
  jvmArgs: string[];
}

let store: ConfigStore | undefined;

export namespace Settings {
  /** 绑定自管存储（activate 最先调用） */
  export function bind(s: ConfigStore): void {
    store = s;
  }

  /** 订阅自管设置变更 */
  export function onDidChange(cb: (s: VsclSettings) => void): vscode.Disposable {
    return (store ?? fail()).event(cb);
  }

  function cfg(): ConfigStore {
    return store ?? fail();
  }

  function fail(): never {
    throw new Error("Settings 尚未初始化（ConfigStore.bind 未调用）");
  }

  function nativeCfg(): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration("vscl");
  }

  // ── 自管设置 ──

  /** 默认 Java（空 = 自动匹配） */
  export function javaPath(): string {
    return cfg().get().javaPath;
  }

  /** 设置默认 Java（空 = 恢复自动匹配） */
  export function setJavaPath(value: string): void {
    cfg().update("javaPath", value);
  }

  /** 注册的游戏目录 */
  export function gameDirectories(): string[] {
    return cfg().get().gameDirectories.filter((d) => d.trim().length > 0);
  }

  /** 激活的游戏目录（空 = 自动选择） */
  export function activeGameDirectory(): string {
    return cfg().get().activeGameDirectory;
  }

  /** 下载源 */
  export function downloadSource(): "official" | "bmclapi" {
    return cfg().get().downloadSource;
  }

  /** 下载并发数 */
  export function downloadThreads(): number {
    return cfg().get().downloadThreads;
  }

  /** 启动时打开日志终端 */
  export function showLogs(): boolean {
    return cfg().get().showLogs;
  }

  /** 全局游戏设置 */
  export function globalGameSettings(): GlobalGameSettings {
    const s = cfg().get();
    return { autoMemory: s.autoMemory, minMemory: s.minMemory, maxMemory: s.maxMemory, jvmArgs: s.jvmArgs };
  }

  /** 添加游戏目录（去重） */
  export function addGameDirectory(dir: string): void {
    const normalized = vscode.Uri.file(dir).fsPath;
    const list = gameDirectories();
    if (list.some((d) => vscode.Uri.file(d).fsPath === normalized)) {
      return;
    }
    cfg().update("gameDirectories", [...list, normalized]);
  }

  /** 移除游戏目录 */
  export function removeGameDirectory(dir: string): void {
    const normalized = vscode.Uri.file(dir).fsPath;
    cfg().update(
      "gameDirectories",
      gameDirectories().filter((d) => vscode.Uri.file(d).fsPath !== normalized)
    );
  }

  /** 设置激活目录（空 = 恢复自动选择） */
  export function setActiveGameDirectory(dir: string): void {
    cfg().update("activeGameDirectory", dir);
  }

  // ── VS Code 原生配置（仅此两项） ──

  /** 是否使用 VS Code 内置浏览器打开链接 */
  export function useIntegratedBrowser(): boolean {
    return nativeCfg().get<boolean>("useIntegratedBrowser", false);
  }

  /** 微软登录 Azure Application client_id */
  export function microsoftClientId(): string {
    return nativeCfg().get<string>("microsoftClientId", "").trim();
  }
}
