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
  /** 当前双源（下载源 / 列表源，HMCL 同款解耦） */
  getSources(): { downloadSource: string; listSource: string };
  /** 切换源并刷新清单 */
  setSource(key: "downloadSource" | "listSource", value: "official" | "bmclapi"): Promise<void>;
  /** 「选择」：跳转安装新游戏面板（预填 MC 版本） */
  install(versionId: string): Promise<void> | void;
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
    panel.webview.onDidReceiveMessage(async (msg: { cmd?: string; id?: string; key?: string; value?: string }) => {
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
            } finally {
              self.installing.delete(msg.id);
              self.post({ type: "installed", id: msg.id });
            }
          }
          break;
        case "setSource":
          if (msg.key === "downloadSource" || msg.key === "listSource") {
            await self.callbacks.setSource(msg.key, msg.value === "official" ? "official" : "bmclapi");
            await self.pushManifest(true);
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

  /** 推送最新清单（附带双源状态） */
  private async pushManifest(force = false): Promise<void> {
    try {
      this.manifest = await this.callbacks.fetchManifest(force);
      this.post({
        type: "manifest",
        data: this.manifest,
        sources: this.callbacks.getSources(),
      });
    } catch (e) {
      this.post({ type: "error", error: e instanceof Error ? e.message : String(e) });
      void vscode.window.showErrorMessage(`VSCL：获取版本清单失败——${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private buildHtml(webview: vscode.Webview): string {
    const media = vscode.Uri.joinPath(this.context.extensionUri, "media");
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(media, "downloadCenter.js"));
    const iconsUri = webview.asWebviewUri(vscode.Uri.joinPath(media, "icons.js"));
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
  <div class="dc-body">
    <nav class="dc-side" id="dc-side" style="width: 240px;">
      <div class="dc-side-title">新游戏</div>
      <div class="dc-side-item active" data-view="game"><span class="dc-side-icon" data-icon="sports_esports"></span>游戏</div>
      <div class="dc-side-item disabled" title="开发中" data-view="modpack"><span class="dc-side-icon" data-icon="inventory"></span>整合包</div>
      <div class="dc-side-title" style="margin-top: 12px;">资源</div>
      <div class="dc-side-item disabled" title="开发中" data-view="mod"><span class="dc-side-icon" data-icon="puzzle"></span>模组</div>
      <div class="dc-side-item disabled" title="开发中" data-view="resourcepack"><span class="dc-side-icon" data-icon="texture"></span>资源包</div>
      <div class="dc-side-item disabled" title="开发中" data-view="shader"><span class="dc-side-icon" data-icon="image"></span>光影</div>
      <div class="dc-side-item disabled" title="开发中" data-view="world"><span class="dc-side-icon" data-icon="public"></span>世界</div>
    </nav>
    <div class="dc-resizer" id="dc-resizer" title="拖拽调整宽度"></div>
    <main class="dc-main">
      <header class="dc-header">
        <div class="dc-filters">
          <span class="dc-chip active" data-filter="release">正式版</span>
          <span class="dc-chip" data-filter="snapshot">快照</span>
          <span class="dc-chip" data-filter="old">旧版本</span>
          <span class="dc-chip" data-filter="all">全部</span>
        </div>
        <div class="dc-actions">
          <select id="list-source" class="dc-button" title="列表源（版本清单）">
            <option value="bmclapi">列表：BMCLAPI</option>
            <option value="official">列表：官方</option>
          </select>
          <select id="dl-source" class="dc-button" title="文件下载源">
            <option value="bmclapi">下载：BMCLAPI</option>
            <option value="official">下载：官方</option>
          </select>
          <input id="search" class="dc-search" type="text" placeholder="搜索版本…" spellcheck="false">
          <button id="refresh" class="dc-button" title="重新获取版本清单">刷新</button>
        </div>
      </header>
      <div class="dc-latest" id="latest"></div>
      <main id="list" class="dc-list"><div class="dc-empty">加载中…</div></main>
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
