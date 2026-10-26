// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 VSCL contributors
/**
 * 启动器设置页（编辑器区 WebviewPanel，替代原生设置界面；仅 vscl.useIntegratedBrowser
 * 保留在 VS Code 设置中）。分区：游戏目录 / 游戏（全局默认，HMCL 智能内存模型）/
 * 下载 / 账户 / 关于。样式复用 media/instancePanel.css。
 * 数据层不变：仍读写 VS Code 配置系统（vscl.*），仅展示层自建。
 */
import * as vscode from "vscode";

/** 设置页状态快照 */
export interface SettingsPanelState {
  directory: {
    active?: string;
    source?: string;
    registered: string[];
    official: string;
  };
  /** 智能内存模型：auto=填写值为下限；manual=填写值为上限 */
  memory: { autoMemory: boolean; minMemory: number; maxMemory: number };
  jvmArgs: string[];
  javaPath: string;
  downloadSource: string;
  downloadThreads: number;
  showLogs: boolean;
  extensionVersion: string;
}

export interface SettingsPanelCallbacks {
  getState(): SettingsPanelState;
  setGlobal(key: string, value: unknown): Promise<void>;
  /** 内存设置：auto=智能（值为下限）；manual=手动（值为上限） */
  setMemory(mode: "auto" | "manual", value: number): Promise<void>;
  addDirectory(): Promise<void>;
  activateDirectory(path: string): Promise<void>;
  removeDirectory(path: string): Promise<void>;
  resetAutoDirectory(): Promise<void>;
  /** 在 VS Code 原生设置中打开指定项 */
  openNativeSetting(query: string): Promise<void>;
}

export class SettingsPanel {
  public static current: SettingsPanel | undefined;
  private panel?: vscode.WebviewPanel;

  private constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly callbacks: SettingsPanelCallbacks
  ) {}

  /** 打开或复用设置页 */
  public static createOrShow(context: vscode.ExtensionContext, callbacks: SettingsPanelCallbacks): SettingsPanel {
    if (SettingsPanel.current) {
      SettingsPanel.current.panel?.reveal();
      SettingsPanel.current.pushState();
      return SettingsPanel.current;
    }
    SettingsPanel.current = new SettingsPanel(context, callbacks);
    const panel = vscode.window.createWebviewPanel(
      "vscl.launcherSettings",
      "启动器设置",
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: false,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "media")],
      }
    );
    SettingsPanel.current.panel = panel;
    panel.webview.html = SettingsPanel.current.buildHtml(panel.webview);
    panel.onDidDispose(() => {
      SettingsPanel.current = undefined;
    });
    panel.webview.onDidReceiveMessage(async (msg: { cmd?: string; key?: string; value?: unknown; path?: string; mode?: string; number?: number; query?: string }) => {
      const self = SettingsPanel.current;
      if (!self) {
        return;
      }
      try {
        switch (msg.cmd) {
          case "ready":
            self.pushState();
            break;
          case "setGlobal":
            if (msg.key) {
              await self.callbacks.setGlobal(msg.key, msg.value);
              self.pushState();
            }
            break;
          case "setMemory":
            if (msg.mode === "auto" || msg.mode === "manual") {
              await self.callbacks.setMemory(msg.mode, Number(msg.number ?? 0));
              self.pushState();
            }
            break;
          case "addDirectory":
            await self.callbacks.addDirectory();
            self.pushState();
            break;
          case "activateDirectory":
            if (msg.path) {
              await self.callbacks.activateDirectory(msg.path);
              self.pushState();
            }
            break;
          case "removeDirectory":
            if (msg.path) {
              await self.callbacks.removeDirectory(msg.path);
              self.pushState();
            }
            break;
          case "resetAutoDirectory":
            await self.callbacks.resetAutoDirectory();
            self.pushState();
            break;
          case "openNativeSetting":
            await self.callbacks.openNativeSetting(msg.query || "@ext:vscl.vscl");
            break;
          default:
            break;
        }
      } catch (e) {
        void vscode.window.showErrorMessage(`VSCL：${e instanceof Error ? e.message : String(e)}`);
      }
    });
    return SettingsPanel.current;
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
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(media, "instancePanel.css"));
    const nonce = getNonce();
    return /* html */ `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link href="${styleUri}" rel="stylesheet">
  <title>启动器设置</title>
</head>
<body>
  <div class="page">
    <div class="section">
      <div class="section-title">游戏目录</div>
      <div class="section-desc" id="dir-current">检测中…</div>
      <div id="dir-list"></div>
      <div class="row" style="grid-template-columns: 1fr;">
        <div class="row-control">
          <button class="tool" data-cmd="addDirectory">添加游戏目录…</button>
          <button class="tool secondary" data-cmd="resetAutoDirectory">恢复自动选择</button>
        </div>
      </div>
    </div>

    <div class="section">
      <div class="section-title">游戏（全局默认）</div>
      <div class="section-desc">所有未被实例覆盖的项继承此处设置（实例可在实例设置页单独覆盖）。</div>
      <div class="row">
        <div class="row-label">
          <div class="row-name">智能内存</div>
          <div class="row-hint" id="memory-hint"></div>
        </div>
        <div class="row-control">
          <label class="override-toggle"><input type="checkbox" id="memory-auto"> 启用</label>
          <input type="number" id="memory-value" min="0" step="64">
          <span class="row-suffix" id="memory-suffix">MB</span>
        </div>
      </div>
      <div class="row">
        <div class="row-label"><div class="row-name">JVM 参数</div><div class="row-hint">每行一个</div></div>
        <div class="row-control"><textarea data-gkey="jvmArgs"></textarea></div>
      </div>
      <div class="row">
        <div class="row-label"><div class="row-name">Java 路径</div><div class="row-hint">留空自动检测</div></div>
        <div class="row-control"><input type="text" data-gkey="javaPath" placeholder="java 可执行文件完整路径"></div>
      </div>
      <div class="row">
        <div class="row-label"><div class="row-name">启动时打开日志终端</div></div>
        <div class="row-control"><label class="override-toggle"><input type="checkbox" data-gkey="showLogs"> 启用</label></div>
      </div>
    </div>

    <div class="section">
      <div class="section-title">下载</div>
      <div class="row">
        <div class="row-label"><div class="row-name">下载源</div></div>
        <div class="row-control">
          <select data-gkey="downloadSource">
            <option value="bmclapi">BMCLAPI 镜像（国内加速）</option>
            <option value="official">官方源</option>
          </select>
        </div>
      </div>
      <div class="row">
        <div class="row-label"><div class="row-name">下载线程数</div></div>
        <div class="row-control"><input type="number" data-gkey="downloadThreads" min="1" max="64"></div>
      </div>
    </div>

    <div class="section">
      <div class="section-title">关于</div>
      <div class="section-desc">
        Visual Studio Craft Launcher <span id="ext-version"></span> · AGPL-3.0-or-later ·
        非 Minecraft 官方产品，与 Mojang / Microsoft 无关联。
      </div>
    </div>
  </div>

  <script nonce="${nonce}">(function () {
    const vscode = acquireVsCodeApi();
    const $ = (s) => document.querySelector(s);
    function esc(s) {
      return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    let lastState;

    // 命令按钮
    document.body.addEventListener('click', (e) => {
      const el = e.target.closest('[data-cmd]');
      if (!el) return;
      vscode.postMessage({ cmd: el.dataset.cmd, path: el.dataset.path, query: el.dataset.query });
    });

    // 智能内存：模式切换联动说明文案；提交三键
    function renderMemory(state) {
      const auto = state.memory.autoMemory;
      $('#memory-auto').checked = auto;
      $('#memory-value').value = auto ? state.memory.minMemory : state.memory.maxMemory;
      $('#memory-hint').textContent = auto
        ? '启用：填写值为下限，上限按系统内存自动分配（不低于此值）'
        : '禁用：填写值为固定上限（-Xmx）';
    }
    $('#memory-auto').addEventListener('change', () => {
      vscode.postMessage({ cmd: 'setMemory', mode: $('#memory-auto').checked ? 'auto' : 'manual', number: Number($('#memory-value').value || 0) });
    });
    $('#memory-value').addEventListener('change', () => {
      vscode.postMessage({ cmd: 'setMemory', mode: $('#memory-auto').checked ? 'auto' : 'manual', number: Number($('#memory-value').value || 0) });
    });

    // 其它全局字段
    const GLOBAL_TEXT = ['javaPath'];
    GLOBAL_TEXT.forEach((k) => {
      $('[data-gkey="' + k + '"]').addEventListener('change', (e) => {
        vscode.postMessage({ cmd: 'setGlobal', key: k, value: e.target.value });
      });
    });
    $('[data-gkey="jvmArgs"]').addEventListener('change', (e) => {
      vscode.postMessage({ cmd: 'setGlobal', key: 'jvmArgs', value: String(e.target.value).split('\\n').filter(Boolean) });
    });
    $('[data-gkey="showLogs"]').addEventListener('change', (e) => {
      vscode.postMessage({ cmd: 'setGlobal', key: 'showLogs', value: e.target.checked });
    });
    $('[data-gkey="downloadSource"]').addEventListener('change', (e) => {
      vscode.postMessage({ cmd: 'setGlobal', key: 'downloadSource', value: e.target.value });
    });
    $('[data-gkey="downloadThreads"]').addEventListener('change', (e) => {
      vscode.postMessage({ cmd: 'setGlobal', key: 'downloadThreads', value: Number(e.target.value || 16) });
    });

    function renderDirs(state) {
      const d = state.directory;
      const sourceLabel = { workspace: '工作区', registered: '注册目录', official: '官方启动器目录' }[d.source] || d.source || '';
      $('#dir-current').innerHTML = '当前：<code>' + esc(d.active || '（未检测到）') + '</code>　<span class="badge">' + esc(sourceLabel) + '</span>';
      const rows = [];
      rows.push('<div class="list-row"><span class="list-name">官方启动器目录</span><span class="list-meta">' + esc(d.official) + '</span></div>');
      for (const dir of d.registered) {
        const isActive = dir === d.active;
        rows.push('<div class="list-row">'
          + '<span class="list-name">' + esc(dir) + (isActive ? ' <span class="badge">当前</span>' : '') + '</span>'
          + '<button class="tool secondary" data-cmd="activateDirectory" data-path="' + esc(dir) + '"' + (isActive ? ' disabled' : '') + '>设为当前</button>'
          + '<button class="icon-btn" data-cmd="removeDirectory" data-path="' + esc(dir) + '" title="移除">✕</button>'
          + '</div>');
      }
      $('#dir-list').innerHTML = rows.join('');
    }

    window.addEventListener('message', (e) => {
      const msg = e.data;
      if (!msg || msg.type !== 'state') return;
      lastState = msg.data;
      renderMemory(msg.data);
      $('[data-gkey="jvmArgs"]').value = (msg.data.jvmArgs || []).join('\\n');
      $('[data-gkey="javaPath"]').value = msg.data.javaPath || '';
      $('[data-gkey="showLogs"]').checked = !!msg.data.showLogs;
      $('[data-gkey="downloadSource"]').value = msg.data.downloadSource || 'bmclapi';
      $('[data-gkey="downloadThreads"]').value = msg.data.downloadThreads || 16;
      $('#ext-version').textContent = msg.data.extensionVersion || '';
      renderDirs(msg.data);
    });

    vscode.postMessage({ cmd: 'ready' });
  })();</script>
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
