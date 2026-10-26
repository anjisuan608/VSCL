// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 VSCL contributors
/**
 * 扩展自管配置存储（对齐 HMCL 的 settings 自管文件模式）。
 * 游戏/下载/Java 等设置存 globalStorage/settings.json——不占用 VS Code
 * 原生配置界面（原生仅保留 vscl.useIntegratedBrowser 与 vscl.microsoftClientId）。
 * 变更经 EventEmitter 广播，设置页等 UI 订阅刷新。
 */
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";

/** 自管设置全集 */
export interface VsclSettings {
  /** 默认 Java（空 = 按游戏版本自动匹配） */
  javaPath: string;
  /** 注册的游戏目录 */
  gameDirectories: string[];
  /** 激活的游戏目录（空 = 自动选择） */
  activeGameDirectory: string;
  downloadSource: "official" | "bmclapi";
  downloadThreads: number;
  showLogs: boolean;
  /** 智能内存：启用时 minMemory 为下限、上限按系统内存计算；禁用时 maxMemory 为固定上限 */
  autoMemory: boolean;
  minMemory: number;
  maxMemory: number;
  jvmArgs: string[];
}

/** 默认值 */
export const SETTINGS_DEFAULTS: VsclSettings = {
  javaPath: "",
  gameDirectories: [],
  activeGameDirectory: "",
  downloadSource: "bmclapi",
  downloadThreads: 16,
  showLogs: true,
  autoMemory: true,
  minMemory: 512,
  maxMemory: 4096,
  jvmArgs: [],
};

/** 自管配置存储（globalStorage/settings.json） */
export class ConfigStore extends vscode.EventEmitter<VsclSettings> {
  private cache?: VsclSettings;

  constructor(private readonly file: string) {
    super();
  }

  /** 读取全部设置（带默认值合并与缓存） */
  get(): VsclSettings {
    if (!this.cache) {
      try {
        const raw = JSON.parse(fs.readFileSync(this.file, "utf8")) as Partial<VsclSettings>;
        this.cache = { ...SETTINGS_DEFAULTS, ...raw };
      } catch {
        this.cache = { ...SETTINGS_DEFAULTS };
      }
    }
    return this.cache;
  }

  /** 更新单个设置（持久化 + 广播） */
  update<K extends keyof VsclSettings>(key: K, value: VsclSettings[K]): void {
    this.cache = { ...this.get(), [key]: value };
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, `${JSON.stringify(this.cache, null, 2)}\n`, "utf8");
    } catch (e) {
      void vscode.window.showErrorMessage(`VSCL：设置保存失败——${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    this.fire(this.cache);
  }
}
