// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 VSCL contributors
/**
 * 实例设置面板（编辑器区 WebviewPanel，对齐 HMCL 实例详情页 `GameInstancePage`）。
 * Tab：游戏设置（全字段覆盖表单）/ 安装（组件与加载器安装）/ Mod 管理 /
 *      资源包（只读列表）/ 世界（只读列表）/ 截图（占位）。
 * 样式：外置 media/instancePanel.css（HMCL 式分区卡片，主题变量驱动）。
 */
import * as vscode from "vscode";

/** 面板状态快照 */
export interface InstancePanelState {
  instance?:
    | {
        id: string;
        dir: string;
        javaMajor?: number;
        components: string[];
        iconUri?: string;
        running: boolean;
      }
    | undefined;
  /** 全局参考值（展示"跟随全局"提示 + Java 单选列表用） */
  global: {
    minMemory: number;
    maxMemory: number;
    jvmArgs: string[];
    javaPath: string;
    downloadSource: string;
    downloadThreads: number;
    showLogs: boolean;
    /** 已检测 Java（javaPicker 单选列表） */
    javas: { exePath: string; major: number; vendor: string; source: string }[];
  };
  overrides: Record<string, unknown>;
  mods: {
    fileName: string;
    path: string;
    name?: string;
    version?: string;
    authors?: string;
    loader: string;
    enabled: boolean;
    size: number;
  }[];
  resourcepacks: { name: string; size: number }[];
  /** 光影包（shaderpacks） */
  shaderpacks: { name: string; size: number }[];
  worlds: { name: string; size: number; mtime: number }[];
  /** 组件状态列表（HMCL 安装列表同款：识别已装 + 版本 + 动作） */
  componentsView: {
    id: string;
    name: string;
    hint?: string;
    base?: boolean;
    installed: boolean;
    version?: string;
  }[];
}

/** 目录类型（打开目录操作） */
export type FolderKind = "mods" | "resourcepacks" | "saves";

export interface InstancePanelCallbacks {
  getState(): InstancePanelState;
  toggleMod(filePath: string): Promise<void>;
  deleteMod(filePath: string): Promise<void>;
  openFolder(kind: FolderKind): Promise<void>;
  installLoader(): Promise<void>;
  /** 添加模组（jar/zip 文件选择 → 复制到 mods/） */
  addMod(): Promise<void>;
  /** 为指定组件选择版本并安装（未安装组件的「选择版本」入口） */
  pickComponent(component: string): Promise<void>;
  /** 切换组件版本（入口占位） */
  switchComponent(component: string): Promise<void>;
  /** 移除组件（入口占位；Minecraft 不支持移除） */
  removeComponent(component: string): Promise<void>;
  /** 校验并修复游戏文件（资产/库缺失补齐） */
  verifyInstance(): Promise<void>;
  setOverride(key: string, value: unknown): Promise<void>;
  resetOverride(key: string): Promise<void>;
}

export class InstancePanel {
  public static current: InstancePanel | undefined;
  private panel?: vscode.WebviewPanel;

  private constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly callbacks: InstancePanelCallbacks
  ) {}

  /** 打开或复用实例设置面板 */
  public static createOrShow(context: vscode.ExtensionContext, callbacks: InstancePanelCallbacks): InstancePanel {
    if (InstancePanel.current) {
      InstancePanel.current.panel?.reveal();
      InstancePanel.current.pushState();
      return InstancePanel.current;
    }
    InstancePanel.current = new InstancePanel(context, callbacks);
    const panel = vscode.window.createWebviewPanel(
      "vscl.instanceSettings",
      "实例设置",
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: false, localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "media")] }
    );
    InstancePanel.current.panel = panel;
    panel.webview.html = InstancePanel.current.buildHtml(panel.webview);
    panel.onDidDispose(() => {
      InstancePanel.current = undefined;
    });
    panel.webview.onDidReceiveMessage(async (msg: { cmd?: string; path?: string; key?: string; value?: unknown; kind?: string; component?: string }) => {
      const self = InstancePanel.current;
      if (!self) {
        return;
      }
      try {
        switch (msg.cmd) {
          case "ready":
            self.pushState();
            break;
          case "toggleMod":
            if (msg.path) {
              await self.callbacks.toggleMod(msg.path);
              self.pushState();
            }
            break;
          case "deleteMod":
            if (msg.path) {
              await self.callbacks.deleteMod(msg.path);
              self.pushState();
            }
            break;
          case "openFolder":
            await self.callbacks.openFolder((msg.kind as FolderKind) ?? "mods");
            break;
          case "installLoader":
            await self.callbacks.installLoader();
            self.pushState();
            break;
          case "addMod":
            await self.callbacks.addMod();
            self.pushState();
            break;
          case "verifyInstance":
            await self.callbacks.verifyInstance();
            self.pushState();
            break;
          case "pickComponent":
            if (msg.component) {
              await self.callbacks.pickComponent(msg.component);
              self.pushState();
            }
            break;
          case "switchComponent":
            if (msg.component) {
              await self.callbacks.switchComponent(msg.component);
            }
            break;
          case "removeComponent":
            if (msg.component) {
              await self.callbacks.removeComponent(msg.component);
              self.pushState();
            }
            break;
          case "setOverride":
            if (msg.key) {
              await self.callbacks.setOverride(msg.key, msg.value);
              self.pushState();
            }
            break;
          case "resetOverride":
            if (msg.key) {
              await self.callbacks.resetOverride(msg.key);
              self.pushState();
            }
            break;
          default:
            break;
        }
      } catch (e) {
        void vscode.window.showErrorMessage(`VSCL：${e instanceof Error ? e.message : String(e)}`);
      }
    });
    return InstancePanel.current;
  }

  /** 状态变更后刷新 */
  public refresh(): void {
    this.pushState();
  }

  /** 面板标题跟随实例 */
  public updateTitle(instanceId: string | undefined): void {
    if (this.panel) {
      this.panel.title = instanceId ? `实例设置 · ${instanceId}` : "实例设置";
    }
  }

  private pushState(): void {
    const state = this.callbacks.getState();
    this.updateTitle(state.instance?.id);
    void this.panel?.webview.postMessage({ type: "state", data: state });
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
        content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}'; img-src data:;">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link href="${styleUri}" rel="stylesheet">
  <title>实例设置</title>
</head>
<body>
  <div class="tabs">
    <span class="tab active" data-tab="settings">游戏设置</span>
    <span class="tab" data-tab="install">安装</span>
    <span class="tab" data-tab="mods">Mod 管理</span>
    <span class="tab" data-tab="resourcepacks">资源包</span>
    <span class="tab" data-tab="shaderpacks">光影包</span>
    <span class="tab" data-tab="worlds">世界</span>
    <span class="tab placeholder" title="开发中">截图</span>
  </div>

  <div class="page" id="page-settings">
    <div class="toolbar">
      <button class="tool secondary" data-cmd="openLauncherSettings">全局游戏设置 / 启动器设置…</button>
    </div>
    <div class="instance-head" id="instance-head"></div>
    <div id="settings-form"></div>
  </div>

  <div class="page" id="page-install" hidden>
    <div class="section">
      <div class="section-title">组件</div>
      <div class="section-desc">
        识别当前实例已安装的组件与版本（HMCL 安装列表同款）。加载器卸载/切换在后续版本实现。
      </div>
      <div id="comp-list"><div class="empty">加载中…</div></div>
      <div class="row" style="grid-template-columns: 1fr;">
        <div class="row-control">
          <button class="tool secondary" data-cmd="verifyInstance">校验并修复游戏文件…</button>
        </div>
      </div>
    </div>
  </div>

  <div class="page" id="page-mods" hidden>
    <div class="toolbar">
      <button class="tool" data-cmd="addMod"><span data-icon="add"></span> 添加模组</button>
      <button class="tool secondary" data-cmd="openFolder" data-kind="mods"><span data-icon="folder"></span> 打开 mods 目录</button>
      <button class="tool secondary" data-cmd="refresh"><span data-icon="refresh"></span> 刷新</button>
    </div>
    <div class="section"><div id="mod-list"><div class="empty">加载中…</div></div></div>
  </div>

  <div class="page" id="page-resourcepacks" hidden>
    <div class="toolbar">
      <button class="tool secondary" data-cmd="openFolder" data-kind="resourcepacks"><span data-icon="folder"></span> 打开目录</button>
      <button class="tool secondary" data-cmd="refresh"><span data-icon="refresh"></span> 刷新</button>
    </div>
    <div class="section"><div id="rp-list"><div class="empty">加载中…</div></div></div>
  </div>

  <div class="page" id="page-shaderpacks" hidden>
    <div class="toolbar">
      <button class="tool secondary" data-cmd="openFolder" data-kind="shaderpacks"><span data-icon="folder"></span> 打开目录</button>
      <button class="tool secondary" data-cmd="refresh"><span data-icon="refresh"></span> 刷新</button>
    </div>
    <div class="section"><div id="shader-list"><div class="empty">加载中…</div></div></div>
  </div>

  <div class="page" id="page-worlds" hidden>
    <div class="toolbar">
      <button class="tool secondary" data-cmd="openFolder" data-kind="saves"><span data-icon="folder"></span> 打开目录</button>
      <button class="tool secondary" data-cmd="refresh"><span data-icon="refresh"></span> 刷新</button>
    </div>
    <div class="section"><div id="world-list"><div class="empty">加载中…</div></div></div>
  </div>

  <script nonce="${nonce}">${INSTANCE_PANEL_SCRIPT}</script>
</body>
</html>`;
  }
}

/** 面板脚本（单独常量便于维护；与 media/instancePanel.css 配套） */
const INSTANCE_PANEL_SCRIPT = `(function () {
  const vscode = acquireVsCodeApi();
  const $ = (s) => document.querySelector(s);

  // ── 图标（MD3 path，currentColor 主题自适应） ──
  const ICONS = {
    forge: '<path d="M22.7 19l-9.1-9.1c.9-2.3.4-5-1.5-6.9-2-2-5-2.4-7.4-1.3L9 6 6 9 1.6 4.7C.4 7.1.9 10.1 2.9 12.1c1.9 1.9 4.6 2.4 6.9 1.5l9.1 9.1c.4.4 1 .4 1.4 0l2.3-2.3c.5-.4.5-1.1.1-1.4z"/>',
    neoforge: '<path d="M19 3H5L2 9l10 12L22 9l-2-6zm-2 15.5L7.5 6h9L17 18.5zM12 8.6 8.9 12 12 15.4 15.1 12 12 8.6z"/>',
    fabric: '<path d="M11 21h-1l1-7H7.5c-.58 0-.57-.32-.38-.66.19-.34.05-.08.07-.12C8.48 10.94 10.42 7.54 13 3h1l-1 7h3.5c.49 0 .56.33.47.51l-.07.15C12.96 17.55 11 21 11 21z"/>',
    quilt: '<path d="M3 3v8h8V3H3zm6 6H5V5h4v4zm-6 4v8h8v-8H3zm6 6H5v-4h4v4zm4-16v8h8V3h-8zm6 6h-4V5h4v4zm-6 4v8h8v-8h-8zm6 6h-4v-4h4v4z"/>',
    liteloader: '<path d="M20.5 11H19V7c0-1.1-.9-2-2-2h-4V3.5C13 2.12 11.88 1 10.5 1S8 2.12 8 3.5V5H4c-1.1 0-1.99.9-1.99 2v3.8H3.5c1.49 0 2.7 1.21 2.7 2.7s-1.21 2.7-2.7 2.7H2V20c0 1.1.9 2 2 2h3.8v-1.5c0-1.49 1.21-2.7 2.7-2.7s2.7 1.21 2.7 2.7V22H17c1.1 0 2-.9 2-2v-4h1.5c1.38 0 2.5-1.12 2.5-2.5S21.88 11 20.5 11z"/>',
    box: '<path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16zm-9-2.53 6.06-3.5L12 6.47 5.94 9.97 12 13.47zM12 15.4 6.06 11.9 12 8.4l5.94 3.5L12 15.4z"/>',
    image: '<path d="M21 19V5c0-1.1-.9-2-2-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2zM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5z"/>',
    folder: '<path d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/>',
    terrain: '<path d="M12 2L2 7l10 5 10-5-10-5zm0 9L4.5 7.5 12 4l7.5 3.5L12 11zm0 4L4 12.5 12 9l8 3.5L12 15zm0 4.5-8-3.5 8-3.5 8 3.5-8 3.5z"/>',
    visibility: '<path d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z"/>',
    visibility_off: '<path d="M12 7c2.76 0 5 2.24 5 5 0 .65-.13 1.26-.36 1.83l2.92 2.92c1.51-1.26 2.7-2.89 3.43-4.75-1.73-4.39-6-7.5-11-7.5-1.4 0-2.74.25-3.98.7l2.16 2.16C10.74 7.13 11.35 7 12 7zM2 4.27l2.28 2.28.46.46C3.08 8.3 1.78 10.02 1 12c1.73 4.39 6 7.5 11 7.5 1.55 0 3.03-.3 4.38-.84l.42.42L19.73 22 21 20.73 3.27 3 2 4.27zM7.53 9.8l1.55 1.55c-.05.21-.08.43-.08.65 0 1.66 1.34 3 3 3 .22 0 .44-.03.65-.08l1.55 1.55c-.67.33-1.41.53-2.2.53-2.76 0-5-2.24-5-5 0-.79.2-1.53.53-2.2zm4.31-.78 3.15 3.15.02-.16c0-1.66-1.34-3-3-3l-.17.01z"/>',
    delete: '<path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/>',
    package: '<path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/>',
  };
  function icon(name) {
    return '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">' + (ICONS[name] || ICONS.box) + '</svg>';
  }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ── Tab 切换 ──
  document.querySelectorAll('.tab[data-tab]').forEach((t) =>
    t.addEventListener('click', () => {
      if (t.classList.contains('placeholder')) return;
      document.querySelectorAll('.tab[data-tab]').forEach((x) => x.classList.toggle('active', x === t));
      ['settings', 'install', 'mods', 'resourcepacks', 'shaderpacks', 'worlds'].forEach((p) => {
        $('#page-' + p).hidden = t.dataset.tab !== p;
      });
    })
  );

  // ── 命令分发 ──
  document.body.addEventListener('click', (e) => {
    const el = e.target.closest('[data-cmd]');
    if (!el) return;
    const cmd = el.dataset.cmd;
    if (cmd === 'refresh') { vscode.postMessage({ cmd: 'ready' }); return; }
    if (cmd === 'toggleMod') { vscode.postMessage({ cmd: 'toggleMod', path: el.dataset.path }); return; }
    if (cmd === 'deleteMod') { vscode.postMessage({ cmd: 'deleteMod', path: el.dataset.path }); return; }
    if (cmd === 'openFolder') { vscode.postMessage({ cmd: 'openFolder', kind: el.dataset.kind || 'mods' }); return; }
    vscode.postMessage({ cmd, component: el.dataset.comp });
  });

  // ── 游戏设置字段定义（HMCL GameSettingsPage 对齐；全部写入实例覆盖 vsclversion.json） ──
  const SECTIONS = [
    {
      title: 'Java', desc: '点选即覆盖（未覆盖时继承全局选择）；「自动」按游戏版本匹配。',
      fields: [{ key: 'javaPath', label: 'Java 选择', type: 'javaPicker' }],
    },
    {
      title: '内存', desc: '智能内存启用时填写值为下限（自动分配不低于此值）；禁用时填写值为固定上限。留空继承全局设置。',
      fields: [
        { key: 'autoMemory', label: '智能内存', type: 'bool' },
        { key: 'minMemory', label: '最小内存 / 智能下限 (MB)', type: 'number' },
        { key: 'maxMemory', label: '最大内存 / 手动上限 (MB)', type: 'number' },
      ],
    },
    {
      title: 'JVM 参数', desc: '每行一个；整体替换全局参数（不合并）。',
      fields: [{ key: 'jvmArgs', label: '额外 JVM 参数', type: 'lines' }],
    },
    {
      title: '窗口',
      desc: '预设选择会同时覆盖宽度与高度（写入实例配置）。',
      fields: [
        { key: 'windowType', label: '窗口模式', type: 'select', options: [['', '默认'], ['WINDOWED', '窗口化'], ['FULLSCREEN', '全屏'], ['MAXIMIZED', '最大化']] },
        { key: 'width', label: '窗口宽度', type: 'number' },
        { key: 'height', label: '窗口高度', type: 'number' },
        { key: 'sizePreset', label: '尺寸预设', type: 'sizePreset' },
      ],
    },
    {
      title: '进程与环境',
      fields: [
        { key: 'processPriority', label: '进程优先级', type: 'select', options: [['', '默认'], ['LOW', '低'], ['BELOW_NORMAL', '低于正常'], ['NORMAL', '正常'], ['ABOVE_NORMAL', '高于正常'], ['HIGH', '高']] },
        { key: 'environmentVariables', label: '环境变量', type: 'lines', placeholder: 'KEY=VALUE，每行一条' },
        { key: 'preLaunchCommand', label: '启动前命令', type: 'text' },
        { key: 'postExitCommand', label: '退出后命令', type: 'text' },
      ],
    },
    {
      title: '启动行为',
      fields: [
        { key: 'launcherVisibility', label: '启动后界面', type: 'select', options: [['', '默认'], ['CLOSE', '关闭'], ['HIDE', '隐藏'], ['KEEP', '保留']] },
        { key: 'quickPlay', label: 'Quick Play 世界', type: 'text', placeholder: '启动后自动进入的世界名' },
        { key: 'showLogs', label: '打开日志终端', type: 'bool' },
        { key: 'enableDebugLogOutput', label: 'Debug 日志', type: 'bool' },
      ],
    },
  ];

  function renderSettings(state) {
    const ov = state.overrides || {};
    const has = (k) => Object.prototype.hasOwnProperty.call(ov, k);
    const html = [];
    for (const sec of SECTIONS) {
      html.push('<div class="section"><div class="section-title">' + esc(sec.title) + '</div>');
      if (sec.desc) html.push('<div class="section-desc">' + esc(sec.desc) + '</div>');
      for (const f of sec.fields) {
        const overridden = has(f.key);
        const val = overridden ? ov[f.key] : undefined;
        let control = '';
        if (f.type === 'sizePreset') {
          control = '<select data-key="' + f.key + '" ' + (overridden ? '' : 'disabled') + '>'
            + '<option value="">选择预设…</option>'
            + '<option value="854x480">854 × 480</option>'
            + '<option value="1280x720">1280 × 720</option>'
            + '<option value="1600x900">1600 × 900</option>'
            + '<option value="1920x1080">1920 × 1080</option>'
            + '<option value="2560x1440">2560 × 1440</option>'
            + '<option value="3840x2160">3840 × 2160（4K）</option>'
            + '</select>';
        } else if (f.type === 'javaPicker') {
          const javas = (state.global && state.global.javas) || [];
          const cur = overridden ? String(val ?? '') : '';
          const isCustom = cur !== '' && !javas.some((j) => j.exePath === cur);
          const dis = overridden ? '' : 'opacity:.45;pointer-events:none;';
          control = '<div style="display:flex;flex-direction:column;gap:5px;' + dis + '">'
            + '<label style="display:flex;gap:8px;align-items:center;cursor:pointer;"><input type="radio" name="jp-' + f.key + '" data-key="' + f.key + '" value="" ' + (cur === '' ? 'checked' : '') + '> 自动（按游戏版本匹配）</label>'
            + javas.map((j) => '<label style="display:flex;gap:8px;align-items:center;cursor:pointer;min-width:0;"><input type="radio" name="jp-' + f.key + '" data-key="' + f.key + '" value="' + esc(j.exePath) + '" ' + (cur === j.exePath ? 'checked' : '') + '> Java ' + j.major + ' · ' + esc(j.vendor || '未知') + ' <span class="row-hint" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + esc(j.exePath) + '</span></label>').join('')
            + '<label style="display:flex;gap:8px;align-items:center;cursor:pointer;"><input type="radio" name="jp-' + f.key + '" data-key="' + f.key + '" value="__custom__" ' + (isCustom ? 'checked' : '') + '> 自定义路径：<input type="text" data-custom="' + f.key + '" value="' + esc(isCustom ? cur : '') + '" style="flex:1;" placeholder="java 可执行文件完整路径"></label>'
            + '</div>';
        } else if (f.type === 'select') {
          const cur = overridden ? String(val ?? '') : '';
          control = '<select data-key="' + f.key + '" ' + (overridden ? '' : 'disabled') + '>'
            + f.options.map(([v, t]) => '<option value="' + esc(v) + '"' + (v === cur ? ' selected' : '') + '>' + esc(t) + '</option>').join('')
            + '</select>';
        } else if (f.type === 'bool') {
          const cur = overridden ? (val ? 'true' : 'false') : '';
          control = '<select data-key="' + f.key + '" data-bool="1" ' + (overridden ? '' : 'disabled') + '>'
            + '<option value=""' + (cur === '' ? ' selected' : '') + '>跟随全局</option>'
            + '<option value="true"' + (cur === 'true' ? ' selected' : '') + '>启用</option>'
            + '<option value="false"' + (cur === 'false' ? ' selected' : '') + '>禁用</option>'
            + '</select>';
        } else if (f.type === 'lines') {
          const cur = Array.isArray(val) ? val.join('\\n') : overridden ? String(val ?? '') : '';
          control = '<textarea data-key="' + f.key + '" ' + (overridden ? '' : 'disabled') + ' placeholder="' + esc(f.placeholder || '') + '">' + esc(cur) + '</textarea>';
        } else {
          const cur = overridden ? String(val ?? '') : '';
          control = '<input type="' + (f.type === 'number' ? 'number' : 'text') + '" data-key="' + f.key + '" value="' + esc(cur) + '" ' + (overridden ? '' : 'disabled') + ' placeholder="' + esc(f.placeholder || '') + '">';
        }
        html.push('<div class="row"><div class="row-label"><div class="row-name">' + esc(f.label) + '</div></div>'
          + '<div class="row-control">'
          + '<label class="override-toggle"><input type="checkbox" data-override="' + f.key + '" ' + (overridden ? 'checked' : '') + '> 覆盖</label>'
          + control + '</div></div>');
      }
      html.push('</div>');
    }
    $('#settings-form').innerHTML = html.join('');

    // 覆盖开关
    $('#settings-form').querySelectorAll('input[data-override]').forEach((cb) => {
      cb.addEventListener('change', () => {
        const key = cb.dataset.override;
        if (cb.checked) {
          const input = $('#settings-form').querySelector('[data-key="' + key + '"]');
          vscode.postMessage({ cmd: 'setOverride', key, value: coerce(key, input) });
        } else {
          vscode.postMessage({ cmd: 'resetOverride', key });
        }
      });
    });
    // 控件变更
    $('#settings-form').querySelectorAll('[data-key]').forEach((input) => {
      input.addEventListener('change', () => {
        const key = input.dataset.key;
        const toggle = input.closest('.row-control').querySelector('[data-override="' + key + '"]');
        if (toggle && !toggle.checked) return;
        const field = FIELDS.find((f) => f.key === key);
        // 尺寸预设：同时覆盖 width / height 两键
        if (field && field.type === 'sizePreset') {
          const [w, h] = String(input.value || '').split('x');
          if (w && h) {
            vscode.postMessage({ cmd: 'setOverride', key: 'width', value: Number(w) });
            vscode.postMessage({ cmd: 'setOverride', key: 'height', value: Number(h) });
          }
          return;
        }
        let value = coerce(key, input);
        if (field && field.type === 'javaPicker' && input.value === '__custom__') {
          const custom = $('#settings-form').querySelector('[data-custom="' + key + '"]');
          value = String(custom ? custom.value : '').trim();
        }
        vscode.postMessage({ cmd: 'setOverride', key, value });
      });
    });
  }

  function coerce(key, input) {
    const field = SECTIONS.flatMap((s) => s.fields).find((f) => f.key === key);
    if (!field) return input.value;
    if (field.type === 'bool') return input.value === 'true' ? true : input.value === 'false' ? false : null;
    if (field.type === 'lines') return String(input.value).split('\\n').filter(Boolean);
    if (field.type === 'number') return Number(input.value || 0);
    return String(input.value);
  }

  // bool select 空值 → reset
  const _post = vscode.postMessage.bind(vscode);
  vscode.postMessage = function (msg) {
    if (msg.cmd === 'setOverride' && msg.value === null) {
      _post({ cmd: 'resetOverride', key: msg.key });
      return;
    }
    _post(msg);
  };

  function renderHead(state) {
    const i = state.instance;
    const el = $('#instance-head');
    if (!i) {
      el.innerHTML = '<div class="meta">未选择实例</div>';
      return;
    }
    const iconHtml = i.iconUri
      ? '<img src="' + esc(i.iconUri) + '" alt="">'
      : '<span class="list-icon" style="width:40px">' + icon(i.components.length ? i.components[0].toLowerCase().replace(/\\s+/g, '') : 'box') + '</span>';
    el.innerHTML = iconHtml
      + '<div><div class="id">' + esc(i.id) + '</div><div class="meta">'
      + (i.components.length ? i.components.map((c) => '<span class="badge">' + esc(c) + '</span>').join('') : '<span class="badge">原版</span>')
      + (i.javaMajor ? '<span class="badge">Java ' + i.javaMajor + '</span>' : '')
      + (i.running ? '<span class="badge">运行中</span>' : '')
      + '</div></div>';
  }

  // 组件状态列表（安装 Tab）：Minecraft 仅切换入口；已装 loader 显示版本 + 切换/移除；未装提供选择版本
  function renderComps(state) {
    const comps = state.componentsView || [];
    if (!state.instance) {
      $('#comp-list').innerHTML = '<div class="empty">未选择实例</div>';
      return;
    }
    $('#comp-list').innerHTML = comps.map((c) => {
      let action;
      if (c.base) {
        action = '<span class="badge">' + esc(c.version || '?') + '</span>'
          + '<button class="tool secondary" data-cmd="switchComponent" data-comp="' + c.id + '">切换版本</button>';
      } else if (c.installed) {
        action = '<span class="badge">' + esc(c.version || '?') + '</span>'
          + '<button class="tool secondary" data-cmd="switchComponent" data-comp="' + c.id + '">切换版本</button>'
          + '<button class="tool secondary" data-cmd="removeComponent" data-comp="' + c.id + '">移除</button>';
      } else {
        action = '<button class="tool secondary" data-cmd="pickComponent" data-comp="' + c.id + '">选择版本</button>';
      }
      return '<div class="list-row">'
        + '<span class="list-name">' + esc(c.name) + '</span>'
        + '<span class="list-meta">' + esc(c.hint || '') + '</span>'
        + action + '</div>';
    }).join('');
  }

  function renderMods(state) {
    const mods = state.mods || [];
    if (mods.length === 0) {
      $('#mod-list').innerHTML = '<div class="empty">' + (state.instance ? '暂无 Mod' : '未选择实例') + '</div>';
      return;
    }
    $('#mod-list').innerHTML = mods.map((m) =>
      '<div class="list-row' + (m.enabled ? '' : ' dimmed') + '">'
      + '<span class="list-icon">' + icon(m.loader) + '</span>'
      + '<span class="list-name">' + esc(m.name || m.fileName) + '</span>'
      + (m.version ? '<span class="badge">' + esc(m.version) + '</span>' : '')
      + '<span class="list-meta">' + esc(m.authors || '') + '</span>'
      + '<span class="list-meta">' + (m.size / 1048576).toFixed(1) + ' MB</span>'
      + '<button class="icon-btn" data-cmd="toggleMod" data-path="' + esc(m.path) + '" title="' + (m.enabled ? '停用' : '启用') + '">' + icon(m.enabled ? 'visibility' : 'visibility_off') + '</button>'
      + '<button class="icon-btn" data-cmd="deleteMod" data-path="' + esc(m.path) + '" title="删除">' + icon('delete') + '</button>'
      + '</div>'
    ).join('');
  }

  function renderSimpleList(sel, items, emptyText, iconName) {
    const el = $(sel);
    if (!items || items.length === 0) {
      el.innerHTML = '<div class="empty">' + emptyText + '</div>';
      return;
    }
    el.innerHTML = items.map((it) =>
      '<div class="list-row"><span class="list-icon">' + icon(iconName) + '</span>'
      + '<span class="list-name">' + esc(it.name) + '</span>'
      + '<span class="list-meta">' + (it.size / 1048576).toFixed(1) + ' MB</span></div>'
    ).join('');
  }

  window.addEventListener('message', (e) => {
    const msg = e.data;
    if (msg && msg.type === 'state') {
      renderHead(msg.data);
      renderSettings(msg.data);
      renderComps(msg.data);
      renderMods(msg.data);
      renderSimpleList('#rp-list', msg.data.resourcepacks, '暂无资源包', 'image');
      renderSimpleList('#shader-list', msg.data.shaderpacks, '暂无光影包', 'image');
      renderSimpleList('#world-list', (msg.data.worlds || []).map((w) => ({ name: w.name, size: w.size })), '暂无世界', 'terrain');
      // 静态按钮的 data-icon 占位注入（与侧栏同模式）
      document.querySelectorAll('[data-icon]').forEach((el) => {
        if (!el.innerHTML) el.innerHTML = VSCL_ICON(el.getAttribute('data-icon'), 15);
      });
    }
  });

  vscode.postMessage({ cmd: 'ready' });
})();`;

function getNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let text = "";
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}
