// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 VSCL contributors
/**
 * 实例列表面板（编辑器区 WebviewPanel，布局对齐下载中心）。
 * 左栏：游戏目录（工作区目录/注册目录/官方目录 + 添加目录），可滚动；
 *      底部固定「全局游戏设置」入口（打开启动器设置-游戏 Tab），不参与滚动。
 * 右栏：当前目录的实例列表（选中/启动/打开实例设置）。
 * 目录操作：点击激活；× 快速删除（注册目录）；添加目录走路径选择对话框。
 */
import * as vscode from "vscode";

/** 目录项 */
export interface InstanceListDirectory {
  /** 工作目录（.minecraft 的上级；激活/删除操作对象） */
  path: string;
  /** 显示名（工作目录名） */
  name: string;
  /** 数据目录完整路径（小字展示：<path>/.minecraft） */
  displayPath: string;
  /** workspace | registered | official */
  kind: string;
  active: boolean;
}

/** 面板状态 */
export interface InstanceListState {
  directories: InstanceListDirectory[];
  activeDir?: string;
  instances: {
    id: string;
    components: string[];
    javaMajor?: number;
    icon?: string;
    running: boolean;
  }[];
  selectedId?: string;
}

export interface InstanceListCallbacks {
  getState(): InstanceListState;
  /** 激活目录（任意路径，含工作区/官方目录） */
  activateDirectory(path: string): Promise<void>;
  /** 移除注册目录（仅注册项） */
  removeDirectory(path: string): Promise<void>;
  /** 添加目录（路径选择对话框） */
  addDirectory(): Promise<void>;
  /** 恢复自动选择 */
  resetAutoDirectory(): Promise<void>;
  /** 启动指定实例 */
  launchInstance(id: string): Promise<void>;
  /** 选中实例（点击行，同步侧栏与启动目标） */
  selectInstance(id: string): void;
  /** 打开实例设置 */
  openInstanceSettings(id: string): Promise<void>;
  /** 打开全局游戏设置（启动器设置-游戏 Tab） */
  openGlobalGameSettings(): void;
  refresh(): void;
}

export class InstanceListPanel {
  public static current: InstanceListPanel | undefined;
  private panel?: vscode.WebviewPanel;

  private constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly callbacks: InstanceListCallbacks
  ) {}

  /** 打开或复用实例列表面板 */
  public static createOrShow(context: vscode.ExtensionContext, callbacks: InstanceListCallbacks): InstanceListPanel {
    if (InstanceListPanel.current) {
      InstanceListPanel.current.panel?.reveal();
      InstanceListPanel.current.pushState();
      return InstanceListPanel.current;
    }
    InstanceListPanel.current = new InstanceListPanel(context, callbacks);
    const panel = vscode.window.createWebviewPanel(
      "vscl.instanceList",
      "实例列表",
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: false,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "media")],
      }
    );
    InstanceListPanel.current.panel = panel;
    panel.webview.html = InstanceListPanel.current.buildHtml(panel.webview);
    panel.onDidDispose(() => {
      InstanceListPanel.current = undefined;
    });
    panel.webview.onDidReceiveMessage(async (msg: { cmd?: string; path?: string; id?: string }) => {
      const self = InstanceListPanel.current;
      if (!self) {
        return;
      }
      try {
        switch (msg.cmd) {
          case "ready":
            self.pushState();
            break;
          case "activateDir":
            if (msg.path) {
              await self.callbacks.activateDirectory(msg.path);
              self.pushState();
            }
            break;
          case "removeDir":
            if (msg.path) {
              await self.callbacks.removeDirectory(msg.path);
              self.pushState();
            }
            break;
          case "addDir":
            await self.callbacks.addDirectory();
            self.pushState();
            break;
          case "resetAuto":
            await self.callbacks.resetAutoDirectory();
            self.pushState();
            break;
          case "launch":
            if (msg.id) {
              await self.callbacks.launchInstance(msg.id);
              self.pushState();
            }
            break;
          case "selectInstance":
            if (msg.id) {
              self.callbacks.selectInstance(msg.id);
              self.pushState();
            }
            break;
          case "openInstance":
            if (msg.id) {
              self.callbacks.openInstanceSettings(msg.id);
            }
            break;
          case "openGlobalSettings":
            self.callbacks.openGlobalGameSettings();
            break;
          default:
            break;
        }
      } catch (e) {
        void vscode.window.showErrorMessage(`VSCL：${e instanceof Error ? e.message : String(e)}`);
      }
    });
    return InstanceListPanel.current;
  }

  /** 状态变更后刷新 */
  public refresh(): void {
    this.pushState();
  }

  private pushState(): void {
    void this.panel?.webview.postMessage({ type: "state", data: this.callbacks.getState() });
  }

  private buildHtml(webview: vscode.Webview): string {
    const media = vscode.Uri.joinPath(this.context.extensionUri, "media");
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(media, "instanceList.js"));
    const iconsUri = webview.asWebviewUri(vscode.Uri.joinPath(media, "icons.js"));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(media, "instanceList.css"));
    const nonce = getNonce();
    return /* html */ `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link href="${styleUri}" rel="stylesheet">
  <title>实例列表</title>
</head>
<body>
  <div class="il-body">
    <nav class="il-side">
      <div class="il-side-scroll">
        <div class="dir-title-row">
          <span>游戏目录</span>
          <button class="icon-btn dir-title-btn" data-cmd="resetAuto" title="恢复自动选择（工作区 > 注册目录 > 官方目录）">
            <span data-icon="refresh"></span>
          </button>
        </div>
        <div id="dir-list"><div class="empty">加载中…</div></div>
        <div class="dir-item" data-cmd="addDir" title="添加游戏目录…">
          <span class="dir-icon" data-icon="add"></span><span class="name">添加目录…</span>
        </div>
      </div>
      <div class="il-side-foot">
        <div class="dir-item" data-cmd="openGlobalSettings" title="打开全局游戏设置">
          <span class="dir-icon" data-icon="settings"></span><span class="name">全局游戏设置</span>
        </div>
      </div>
    </nav>
    <div class="dc-resizer" id="dc-resizer" title="拖拽调整宽度"></div>
    <main class="il-main">
      <header class="il-header">
        <span class="view-title" style="font-size: 14px;" id="dir-current">—</span>
        <button class="tool secondary" data-cmd="refresh">刷新</button>
      </header>
      <div id="inst-list"><div class="dc-empty">加载中…</div></div>
    </main>
  </div>
  <script nonce="${nonce}" src="${iconsUri}"></script>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function getNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let text = "";
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}
