// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 VSCL contributors
/**
 * 下载中心（编辑器区 WebviewPanel，设计基线 5.11 P1）。
 * 第一期范围：游戏版本下载（正式版/快照/旧版清单 + 安装）；Mod 搜索为占位 Tab。
 * 数据流：扩展侧拉取 manifest → postMessage 推送；安装请求回传扩展执行（withProgress）。
 */
import * as vscode from "vscode";
import type { VersionManifest } from "../core/download/versionManifest";

export interface DownloadCenterCallbacks {
  /** 拉取版本清单（缓存由实现方管理） */
  fetchManifest(force?: boolean): Promise<VersionManifest>;
  /** 本地已安装的版本 id（用于列表标记） */
  getInstalledIds(): string[];
  /** 安装指定版本 */
  install(versionId: string): Promise<void>;
}

export class DownloadCenterPanel {
  public static current: DownloadCenterPanel | undefined;
  private panel?: vscode.WebviewPanel;
  private manifest?: VersionManifest;
  private readonly installing = new Set<string>();

  private constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly callbacks: DownloadCenterCallbacks
  ) {}

  /** 打开或复用下载中心面板 */
  public static createOrShow(context: vscode.ExtensionContext, callbacks: DownloadCenterCallbacks): DownloadCenterPanel {
    if (DownloadCenterPanel.current) {
      DownloadCenterPanel.current.panel?.reveal();
      void DownloadCenterPanel.current.pushManifest();
      return DownloadCenterPanel.current;
    }
    DownloadCenterPanel.current = new DownloadCenterPanel(context, callbacks);
    const panel = vscode.window.createWebviewPanel(
      "vscl.downloadCenter",
      "下载中心",
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: false,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "media")],
      }
    );
    panel.iconPath = vscode.Uri.joinPath(context.extensionUri, "media", "icons", "dark", "download.svg");
    DownloadCenterPanel.current.panel = panel;
    panel.webview.html = DownloadCenterPanel.current.buildHtml(panel.webview);
    panel.onDidDispose(() => {
      DownloadCenterPanel.current = undefined;
    });
    panel.webview.onDidReceiveMessage(async (msg: { cmd?: string; id?: string }) => {
      const self = DownloadCenterPanel.current;
      if (!self) {
        return;
      }
      switch (msg.cmd) {
        case "ready":
          await self.pushManifest();
          break;
        case "refresh":
          await self.pushManifest(true);
          break;
        case "install":
          if (msg.id && !self.installing.has(msg.id)) {
            self.installing.add(msg.id);
            self.post({ type: "installing", id: msg.id });
            try {
              await self.callbacks.install(msg.id);
              self.post({ type: "installed", id: msg.id });
            } catch (e) {
              self.post({ type: "install-failed", id: msg.id, error: e instanceof Error ? e.message : String(e) });
              void vscode.window.showErrorMessage(`VSCL：安装 ${msg.id} 失败——${e instanceof Error ? e.message : String(e)}`);
            } finally {
              self.installing.delete(msg.id);
            }
          }
          break;
        default:
          break;
      }
    });
    return DownloadCenterPanel.current;
  }

  private post(message: unknown): void {
    void this.panel?.webview.postMessage(message);
  }

  /** 推送最新清单 */
  private async pushManifest(force = false): Promise<void> {
    try {
      this.manifest = await this.callbacks.fetchManifest(force);
      this.post({ type: "manifest", data: this.manifest, installedIds: this.callbacks.getInstalledIds() });
    } catch (e) {
      this.post({ type: "error", error: e instanceof Error ? e.message : String(e) });
      void vscode.window.showErrorMessage(`VSCL：获取版本清单失败——${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private buildHtml(webview: vscode.Webview): string {
    const media = vscode.Uri.joinPath(this.context.extensionUri, "media");
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(media, "downloadCenter.js"));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(media, "downloadCenter.css"));
    const nonce = getNonce();
    return /* html */ `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link href="${styleUri}" rel="stylesheet">
  <title>下载中心</title>
</head>
<body>
  <header class="dc-header">
    <div class="dc-tabs">
      <span class="dc-tab active">游戏版本</span>
      <span class="dc-tab disabled" title="开发中">Mod / 整合包</span>
    </div>
    <div class="dc-actions">
      <input id="search" class="dc-search" type="text" placeholder="搜索版本…" spellcheck="false">
      <button id="refresh" class="dc-button" title="重新获取版本清单">刷新</button>
    </div>
  </header>
  <div class="dc-latest" id="latest"></div>
  <div class="dc-filters" id="filters">
    <span class="dc-chip active" data-filter="release">正式版</span>
    <span class="dc-chip" data-filter="snapshot">快照</span>
    <span class="dc-chip" data-filter="old">旧版本</span>
    <span class="dc-chip" data-filter="all">全部</span>
  </div>
  <main id="list" class="dc-list"><div class="dc-empty">加载中…</div></main>
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
