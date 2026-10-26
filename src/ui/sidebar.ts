// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 VSCL contributors
/**
 * 主侧栏 WebviewView（设计基线 5.1：HMCL 式布局）。
 * 布局：账户卡（占位）/ 当前实例卡 / 导航入口 / 底部启动按钮（sticky）。
 * 主题：全部颜色走 `--vscode-*` CSS 变量，自动跟随亮/暗/高对比主题。
 * 通信：webview 只上报意图（postMessage），状态由扩展 Store 广播推送。
 */
import * as vscode from "vscode";
import type { Store } from "../core/state/store";
import type { JavaInstall } from "../core/java/javaDetector";
import { probeInstanceIcon, readIconDataUri } from "../core/game/instanceIcon";

export class SidebarProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "vscl.main";

  private view?: vscode.WebviewView;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly store: Store
  ) {}

  /** 注册并订阅状态广播 */
  register(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
      vscode.window.registerWebviewViewProvider(SidebarProvider.viewType, this, {
        webviewOptions: { retainContextWhenHidden: true },
      }),
      this.store.event(() => this.postState())
    );
  }

  /** 推送最新状态到侧栏（自定义实例图标经 data URI 传输，已通过安全检查且体积受限） */
  public postState(latestJava?: JavaInstall): void {
    if (!this.view) {
      return;
    }
    const s = this.store.state;
    const selected = this.store.selectedInstance;
    let iconUri: string | undefined;
    if (selected?.iconPath) {
      const icon = probeInstanceIcon(selected.dir);
      if (icon) {
        iconUri = readIconDataUri(icon) || undefined;
      }
    }
    void this.view.webview.postMessage({
      type: "state",
      data: {
        activeDirectory: s.activeDirectory,
        activeSource: s.activeSource,
        selected: selected ? { ...selected, iconUri, running: s.runningInstanceIds.includes(selected.id) } : undefined,
        instances: s.instances,
        accountName: this.store.selectedAccount?.username,
        latestJava: latestJava ? { major: latestJava.major, vendor: latestJava.vendor } : undefined,
      },
    });
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    const { webview } = webviewView;
    webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "media")],
    };
    webview.html = this.buildHtml(webview);

    webview.onDidReceiveMessage(async (msg: { cmd?: string; arg?: string }) => {
      try {
        switch (msg.cmd) {
          case "launch":
            await vscode.commands.executeCommand("vscl.launch");
            break;
          case "select":
            await vscode.commands.executeCommand("vscl.selectInstance");
            break;
          case "refresh":
            await vscode.commands.executeCommand("vscl.refresh");
            break;
          case "open-page":
            if (msg.arg === "instance-settings") {
              await vscode.commands.executeCommand("vscl.openInstanceSettings");
            } else if (msg.arg === "settings") {
              // 设置页 = 扩展自建「启动器设置」页
              await vscode.commands.executeCommand("vscl.openLauncherSettings");
            } else if (msg.arg === "account") {
              await vscode.commands.executeCommand("vscl.openAccountPanel");
            } else {
              await vscode.commands.executeCommand(`vscl.openPage.${msg.arg ?? "download"}`);
            }
            break;
          default:
            break;
        }
      } catch (e) {
        void vscode.window.showErrorMessage(`VSCL：${e instanceof Error ? e.message : String(e)}`);
      }
    });

    this.postState();
  }

  private buildHtml(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "sidebar.js"));
    const iconsUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "icons.js"));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "sidebar.css"));
    const nonce = getNonce();
    return /* html */ `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} data:;">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link href="${styleUri}" rel="stylesheet">
  <title>VSCL</title>
</head>
<body>
  <div class="section">
    <p class="section-title">账户</p>
    <div class="account-card" data-cmd="open-page" data-arg="account" title="账户管理（开发中）">
      <div class="account-avatar"><span data-icon="person"></span></div>
      <div>
        <div class="account-name" id="account-name">未登录</div>
        <div class="account-sub" id="account-sub">点击管理账户（微软 / 离线）</div>
      </div>
    </div>
  </div>

  <div class="section">
    <p class="section-title">游戏</p>
    <div class="instance-card" id="instance-card" data-cmd="open-page" data-arg="instance-settings" title="打开实例设置（游戏设置 / Mod 管理）"></div>
    <div class="nav-item" data-cmd="open-page" data-arg="instances" title="实例列表（开发中）">
      <span class="nav-icon" data-icon="inventory"></span>
      <span class="nav-label">实例列表</span>
      <span class="nav-hint">开发中</span>
    </div>
    <div class="nav-item" data-cmd="open-page" data-arg="download" title="下载中心（开发中）">
      <span class="nav-icon" data-icon="download"></span>
      <span class="nav-label">下载中心</span>
      <span class="nav-hint">开发中</span>
    </div>
  </div>

  <div class="section">
    <p class="section-title">通用</p>
    <div class="nav-item" data-cmd="open-page" data-arg="settings" title="打开 VSCL 设置">
      <span class="nav-icon" data-icon="settings"></span>
      <span class="nav-label">设置</span>
    </div>
    <div class="nav-item" data-cmd="open-page" data-arg="multiplayer" title="多人联机（开发中）">
      <span class="nav-icon" data-icon="public"></span>
      <span class="nav-label">多人联机</span>
      <span class="nav-hint">开发中</span>
    </div>
    <div class="nav-item" data-cmd="refresh" title="重新扫描游戏目录与实例">
      <span class="nav-icon" data-icon="refresh"></span>
      <span class="nav-label">刷新</span>
    </div>
  </div>

  <div class="section" style="border-bottom: none;">
    <p class="section-title">游戏目录</p>
    <div class="instance-meta">
      <div id="dir-path">（检测中…）</div>
      <div><span class="badge" id="dir-source"></span></div>
    </div>
  </div>

  <div class="launch-bar">
    <div class="launch-row">
      <button class="launch-button" id="launch-btn" data-cmd="launch" disabled>
        <span class="launch-play" data-icon="play"></span>
        <span id="launch-label">启动游戏</span>
        <span class="launch-sub" id="launch-sub"></span>
      </button>
      <button class="launch-toggle" id="launch-toggle" data-cmd="select" title="切换实例" data-icon="list"></button>
    </div>
  </div>

  <script nonce="${nonce}" src="${iconsUri}"></script>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

/** 生成 CSP nonce */
function getNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let text = "";
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}
