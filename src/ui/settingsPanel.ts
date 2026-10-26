// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 VSCL contributors
/**
 * 启动器设置页（编辑器区 WebviewPanel；与实例设置/账户页统一 shell 风格：
 * 标题行 + 外置样式 media/instancePanel.css，无内联 <style>）。
 * 分区：Java 管理（检测列表/设默认/获取引导）/ 游戏目录 / 游戏（全局默认，
 * HMCL 智能内存模型）/ 下载 / 关于。仅 vscl.useIntegratedBrowser 与
 * vscl.microsoftClientId 保留在 VS Code 原生设置中。
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
  /** 检测到的 Java 列表 */
  javas: { exePath: string; major: number; version: string; vendor: string; source: string }[];
  /** 当前默认 Java（vscl.javaPath，空 = 自动匹配） */
  javaDefault: string;
  /** 智能内存模型：auto=填写值为下限；manual=填写值为上限 */
  memory: { autoMemory: boolean; minMemory: number; maxMemory: number };
  jvmArgs: string[];
  /** 窗口（""=默认；0 = 游戏记忆值） */
  windowType: string;
  width: number;
  height: number;
  javaPath: string;
  downloadSource: string;
  listSource: string;
  downloadThreads: number;
  showLogs: boolean;
  /** 扩展缓存（globalStorage/cache） */
  cache: { dir: string; sizeText: string };
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
  /** 重新检测 Java */
  rescanJava(): void;
  /** 将指定 Java 设为默认（写 vscl.javaPath） */
  setJavaDefault(exePath: string): Promise<void>;
  /** 清除默认（恢复自动匹配） */
  clearJavaDefault(): Promise<void>;
  /** 打开 Java 获取页面（java.com / BellSoft Liberica） */
  openJavaDownload(kind: "java" | "bellsoft"): Promise<void>;
  /** 在 VS Code 原生设置中打开指定项 */
  openNativeSetting(query: string): Promise<void>;
  /** 清空扩展缓存 */
  clearCache(): Promise<void>;
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
    panel.webview.onDidReceiveMessage(async (msg: { cmd?: string; key?: string; value?: unknown; path?: string; mode?: string; number?: number; query?: string; kind?: string }) => {
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
          case "rescanJava":
            self.callbacks.rescanJava();
            self.pushState();
            break;
          case "setJavaDefault":
            if (msg.path) {
              await self.callbacks.setJavaDefault(msg.path);
              self.pushState();
            }
            break;
          case "clearJavaDefault":
            await self.callbacks.clearJavaDefault();
            self.pushState();
            break;
          case "openJavaDownload":
            await self.callbacks.openJavaDownload(msg.kind === "bellsoft" ? "bellsoft" : "java");
            break;
          case "openNativeSetting":
            await self.callbacks.openNativeSetting(msg.query || "@ext:vscl.vscl");
            break;
          case "clearCache":
            await self.callbacks.clearCache();
            self.pushState();
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

  /** 切换设置页 Tab（如 "game"） */
  public switchTab(tab: string): void {
    void this.panel?.webview.postMessage({ type: "switchTab", tab });
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
  <div class="tabs" style="position: static; padding: 0 28px;">
    <span class="tab active" data-stab="java">Java 管理</span>
    <span class="tab" data-stab="dirs">游戏目录</span>
    <span class="tab" data-stab="game">游戏</span>
    <span class="tab" data-stab="download">下载</span>
    <span class="tab" data-stab="about">关于</span>
  </div>

  <!-- Java 管理 -->
  <div class="page" id="page-java">
    <div class="section">
      <div class="section-title">Java 管理</div>
      <div class="section-desc">
        检测本机 Java 运行时（PATH / JAVA_HOME / 各平台标准目录 / 注册表 / 官方启动器 runtime）。
        启动与安装的默认 Java 在「游戏」Tab 中选择；游戏版本所需的 Java 版本仅为推荐值。
      </div>
      <div class="toolbar" style="padding: 8px 16px 0;">
        <button class="tool secondary" data-cmd="rescanJava">重新检测</button>
        <button class="tool secondary" data-cmd="openJavaDownload" data-kind="java">前往 java.com 下载</button>
        <button class="tool secondary" data-cmd="openJavaDownload" data-kind="bellsoft">前往 BellSoft</button>
      </div>
      <div id="java-list"><div class="empty">检测中…</div></div>
    </div>
  </div>

  <!-- 游戏目录 -->
  <div class="page" id="page-dirs" hidden>
    <div class="section">
      <div class="section-title">游戏目录</div>
      <div class="section-desc" id="dir-current">检测中…</div>
      <div id="dir-list"></div>
      <div class="row" style="grid-template-columns: 1fr;">
        <div class="row-control">
          <span class="row-hint" style="flex: 1;">目录的添加与快速移除在「实例列表」页左侧管理</span>
          <button class="tool secondary" data-cmd="resetAutoDirectory">恢复自动选择</button>
        </div>
      </div>
    </div>
  </div>

  <!-- 游戏（全局默认） -->
  <div class="page" id="page-game" hidden>
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
          <span class="row-suffix">MB</span>
        </div>
      </div>
      <div class="row">
        <div class="row-label"><div class="row-name">JVM 参数</div><div class="row-hint">每行一个</div></div>
        <div class="row-control"><textarea data-gkey="jvmArgs"></textarea></div>
      </div>
      <div class="row">
        <div class="row-label">
          <div class="row-name">Java 选择</div>
          <div class="row-hint">启动与安装组件使用的默认 Java；实例可在实例设置中单独覆盖</div>
        </div>
        <div class="row-control">
          <div id="java-picker" style="display:flex;flex-direction:column;gap:5px;flex:1;"></div>
        </div>
      </div>
      <div class="row">
        <div class="row-label"><div class="row-name">启动时打开日志终端</div></div>
        <div class="row-control"><label class="override-toggle"><input type="checkbox" data-gkey="showLogs"> 启用</label></div>
      </div>
      <div class="row">
        <div class="row-label"><div class="row-name">窗口模式</div></div>
        <div class="row-control">
          <select data-gkey="windowType">
            <option value="">默认（游戏记忆值）</option>
            <option value="WINDOWED">窗口化</option>
            <option value="FULLSCREEN">全屏</option>
            <option value="MAXIMIZED">最大化</option>
          </select>
        </div>
      </div>
      <div class="row">
        <div class="row-label"><div class="row-name">窗口尺寸</div><div class="row-hint">0 = 使用游戏记忆值</div></div>
        <div class="row-control">
          <input type="number" data-gkey="width" min="0" placeholder="宽" style="max-width: 110px;">
          <span class="row-suffix">×</span>
          <input type="number" data-gkey="height" min="0" placeholder="高" style="max-width: 110px;">
          <select id="size-preset-global">
            <option value="">尺寸预设…</option>
            <option value="854x480">854 × 480</option>
            <option value="1280x720">1280 × 720</option>
            <option value="1600x900">1600 × 900</option>
            <option value="1920x1080">1920 × 1080</option>
            <option value="2560x1440">2560 × 1440</option>
            <option value="3840x2160">3840 × 2160（4K）</option>
          </select>
        </div>
      </div>
    </div>
  </div>

  <!-- 下载 -->
  <div class="page" id="page-download" hidden>
    <div class="section">
      <div class="section-title">下载</div>
      <div class="row">
        <div class="row-label"><div class="row-name">列表源</div><div class="row-hint">版本清单 / 加载器版本列表</div></div>
        <div class="row-control">
          <select data-gkey="listSource">
            <option value="bmclapi">BMCLAPI 镜像</option>
            <option value="official">官方源</option>
          </select>
        </div>
      </div>
      <div class="row">
        <div class="row-label"><div class="row-name">下载源</div><div class="row-hint">游戏文件（jar / 资源 / 依赖库）</div></div>
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
  </div>

  <!-- 关于 -->
  <div class="page" id="page-about" hidden>
    <div class="section">
      <div class="section-title">缓存</div>
      <div class="section-desc">
        版本清单等可再生数据缓存于扩展 globalStorage（VS Code 扩展规范：缓存不写用户工作区）。
        清理后重新进入下载中心会自动重新拉取；游戏文件本体不受影响。
      </div>
      <div class="row" style="grid-template-columns: 1fr;">
        <div class="row-control">
          <span class="list-meta" id="cache-info" style="flex: 1;">—</span>
          <button class="tool secondary" data-cmd="clearCache">清理缓存</button>
        </div>
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

    // Tab 切换（同实例设置页结构）
    document.querySelectorAll('.tab[data-stab]').forEach((t) =>
      t.addEventListener('click', () => {
        document.querySelectorAll('.tab[data-stab]').forEach((x) => x.classList.toggle('active', x === t));
        ['java', 'dirs', 'game', 'download', 'about'].forEach((p) => {
          $('#page-' + p).hidden = t.dataset.stab !== p;
        });
      })
    );

    document.body.addEventListener('click', (e) => {
      const el = e.target.closest('[data-cmd]');
      if (!el) return;
      vscode.postMessage({ cmd: el.dataset.cmd, path: el.dataset.path, kind: el.dataset.kind, query: el.dataset.query });
    });

    // 智能内存（HMCL 模型）
    function renderMemory(state) {
      const auto = state.memory.autoMemory;
      $('#memory-auto').checked = auto;
      $('#memory-value').value = auto ? state.memory.minMemory : state.memory.maxMemory;
      $('#memory-hint').textContent = auto
        ? '启用：填写值为下限，上限按系统内存自动分配（不低于此值）'
        : '禁用：填写值为固定上限（-Xmx）';
    }
    function postMemory() {
      vscode.postMessage({ cmd: 'setMemory', mode: $('#memory-auto').checked ? 'auto' : 'manual', number: Number($('#memory-value').value || 0) });
    }
    $('#memory-auto').addEventListener('change', postMemory);
    $('#memory-value').addEventListener('change', postMemory);

    // 其余全局字段（javaPath 由 Java 单选列表处理）
    $('[data-gkey="jvmArgs"]').addEventListener('change', (e) => {
      vscode.postMessage({ cmd: 'setGlobal', key: 'jvmArgs', value: String(e.target.value).split('\\n').filter(Boolean) });
    });
    $('[data-gkey="showLogs"]').addEventListener('change', (e) => {
      vscode.postMessage({ cmd: 'setGlobal', key: 'showLogs', value: e.target.checked });
    });
    $('[data-gkey="downloadSource"]').addEventListener('change', (e) => {
      vscode.postMessage({ cmd: 'setGlobal', key: 'downloadSource', value: e.target.value });
    });
    $('[data-gkey="listSource"]').addEventListener('change', (e) => {
      vscode.postMessage({ cmd: 'setGlobal', key: 'listSource', value: e.target.value });
    });
    $('[data-gkey="downloadThreads"]').addEventListener('change', (e) => {
      vscode.postMessage({ cmd: 'setGlobal', key: 'downloadThreads', value: Number(e.target.value || 16) });
    });
    // 窗口尺寸
    ['width', 'height'].forEach((k) => {
      $('[data-gkey="' + k + '"]').addEventListener('change', (e) => {
        vscode.postMessage({ cmd: 'setGlobal', key: k, value: Number(e.target.value || 0) });
      });
    });
    // 尺寸预设 → 填充宽高（HMCL 同款联动）
    $('#size-preset-global').addEventListener('change', (e) => {
      const [w, h] = String(e.target.value || '').split('x');
      if (!w) return;
      $('[data-gkey="width"]').value = w;
      $('[data-gkey="height"]').value = h;
      vscode.postMessage({ cmd: 'setGlobal', key: 'width', value: Number(w) });
      vscode.postMessage({ cmd: 'setGlobal', key: 'height', value: Number(h) });
    });

    // Java 列表（只读展示；选择在「游戏」Tab）
    const JAVA_SOURCE = { manual: '手动', java_home: 'JAVA_HOME', jdk_home: 'JDK_HOME', path: 'PATH', registry: '注册表', platform: '自动扫描' };
    function renderJavas(state) {
      const javas = state.javas || [];
      if (javas.length === 0) {
        $('#java-list').innerHTML = '<div class="empty">未检测到 Java —— 可前往 java.com / BellSoft 下载，或安装 Language Support for Java (Red Hat) 获取内置运行时</div>';
        return;
      }
      $('#java-list').innerHTML = javas.map((j) =>
        '<div class="list-row">'
        + '<span class="list-name">Java ' + j.major + '　<span class="list-meta">' + esc(j.version) + '</span></span>'
        + '<span class="badge">' + esc(j.vendor || '未知') + '</span>'
        + '<span class="badge">' + esc(JAVA_SOURCE[j.source] || j.source) + '</span>'
        + '<span class="list-meta" title="' + esc(j.exePath) + '">' + esc(j.exePath.length > 48 ? '…' + j.exePath.slice(-47) : j.exePath) + '</span>'
        + '</div>'
      ).join('');
    }

    // 游戏 Tab：Java 单选列表（自动 / 各检测 Java / 自定义路径）
    function renderJavaPicker(state) {
      const javas = state.javas || [];
      const cur = state.javaDefault || '';
      const isCustom = cur !== '' && !javas.some((j) => j.exePath === cur);
      $('#java-picker').innerHTML =
        '<label class="override-toggle" style="cursor:pointer;"><input type="radio" name="gjava" data-java="" ' + (cur === '' ? 'checked' : '') + '> 自动（按游戏版本匹配）</label>'
        + javas.map((j) =>
          '<label class="override-toggle" style="cursor:pointer;display:flex;gap:6px;align-items:center;min-width:0;">'
          + '<input type="radio" name="gjava" data-java="' + esc(j.exePath) + '" ' + (cur === j.exePath ? 'checked' : '') + '>'
          + 'Java ' + j.major + ' · ' + esc(j.vendor || '未知')
          + '<span class="row-hint" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + esc(j.exePath) + '</span></label>'
        ).join('')
        + '<label class="override-toggle" style="cursor:pointer;display:flex;gap:6px;align-items:center;">'
        + '<input type="radio" name="gjava" data-java="__custom__" ' + (isCustom ? 'checked' : '') + '> 自定义路径：'
        + '<input type="text" id="java-custom" value="' + esc(isCustom ? cur : '') + '" style="flex:1;" placeholder="java 可执行文件完整路径"></label>';
      $('#java-picker').querySelectorAll('input[name="gjava"]').forEach((r) => {
        r.addEventListener('change', () => {
          let v = r.dataset.java;
          if (v === '__custom__') {
            v = String($('#java-custom').value || '').trim();
            if (!v) { return; }
          }
          vscode.postMessage({ cmd: 'setGlobal', key: 'javaPath', value: v });
        });
      });
    }

    function renderDirs(state) {
      const d = state.directory;
      const sourceLabel = { workspace: '工作区', registered: '注册目录', official: '官方启动器目录' }[d.source] || d.source || '';
      $('#dir-current').innerHTML = '当前：<code>' + esc(d.active || '（未检测到）') + '</code>　<span class="badge">' + esc(sourceLabel) + '</span>';
      const rows = ['<div class="list-row"><span class="list-name">官方启动器目录</span><span class="list-meta">' + esc(d.official) + '</span></div>'];
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
      if (!msg) return;
      if (msg.type === 'switchTab') {
        const t = document.querySelector('.tab[data-stab="' + msg.tab + '"]');
        if (t) t.click();
        return;
      }
      if (msg.type !== 'state') return;
      renderMemory(msg.data);
      renderJavas(msg.data);
      renderJavaPicker(msg.data);
      renderDirs(msg.data);
      $('[data-gkey="jvmArgs"]').value = (msg.data.jvmArgs || []).join('\\n');
      $('[data-gkey="showLogs"]').checked = !!msg.data.showLogs;
      $('[data-gkey="downloadSource"]').value = msg.data.downloadSource || 'bmclapi';
      $('[data-gkey="listSource"]').value = msg.data.listSource || 'bmclapi';
      $('[data-gkey="downloadThreads"]').value = msg.data.downloadThreads || 16;
      $('[data-gkey="width"]').value = msg.data.width || '';
      $('[data-gkey="height"]').value = msg.data.height || '';
      $('[data-gkey="windowType"]').value = msg.data.windowType || '';
      if (msg.data.cache) {
        $('#cache-info').textContent = msg.data.cache.sizeText + ' · ' + msg.data.cache.dir;
      }
      $('#ext-version').textContent = msg.data.extensionVersion || '';
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
