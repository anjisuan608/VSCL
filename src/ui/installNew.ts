// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 VSCL contributors
/**
 * 安装新游戏面板（编辑器区 WebviewPanel，HMCL 下载中心同款逻辑）。
 * 主视图：组件列表（Minecraft / Forge / NeoForge / Cleanroom / Fabric /
 * Legacy Fabric / Quilt / OptiFine），每行「选择版本」进入版本选择子页
 * （带返回）；底部安装按钮按序编排：Minecraft → 加载器（至多一个）→
 * OptiFine（可叠加）。样式复用 media/instancePanel.css。
 */
import * as vscode from "vscode";

/** 安装计划（组件 id → 选中版本） */
export type InstallPlan = Record<string, string | undefined>;

/** 面板状态 */
export interface InstallNewState {
  plan: InstallPlan;
  downloading: boolean;
}

/** 版本选择子页数据 */
export interface ComponentVersionsPayload {
  component: string;
  name: string;
  items: { version: string; stable: boolean; detail?: string }[];
  error?: string;
}

export interface InstallNewCallbacks {
  getPlan(): InstallPlan;
  /** 设置计划项（扩展侧为单一源，回推 state 同步前端） */
  setPlan(component: string, version: string): void;
  /** 清除计划项（component 省略 = 清空全部） */
  clearPlan(component?: string): void;
  isDownloading(): boolean;
  /** 拉取组件版本列表（扩展侧按 listSource 获取） */
  fetchVersions(component: string): Promise<ComponentVersionsPayload>;
  /** 执行安装编排 */
  install(plan: InstallPlan): Promise<void>;
}

export class InstallNewPanel {
  public static current: InstallNewPanel | undefined;
  private panel?: vscode.WebviewPanel;

  private constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly callbacks: InstallNewCallbacks
  ) {}

  /** 打开或复用安装面板（prefillVersion: 从下载中心「选择」带入的 MC 版本） */
  public static createOrShow(context: vscode.ExtensionContext, callbacks: InstallNewCallbacks, prefillVersion?: string): InstallNewPanel {
    if (InstallNewPanel.current) {
      if (prefillVersion) {
        callbacks; // 预填通过扩展侧 plan 处理（openInstallNew 统一设置）
      }
      InstallNewPanel.current.panel?.reveal();
      InstallNewPanel.current.pushState();
      return InstallNewPanel.current;
    }
    InstallNewPanel.current = new InstallNewPanel(context, callbacks);
    const panel = vscode.window.createWebviewPanel(
      "vscl.installNew",
      "安装新游戏",
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: false,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "media")],
      }
    );
    InstallNewPanel.current.panel = panel;
    panel.webview.html = InstallNewPanel.current.buildHtml(panel.webview);
    panel.onDidDispose(() => {
      InstallNewPanel.current = undefined;
    });
    panel.webview.onDidReceiveMessage(async (msg: { cmd?: string; component?: string; version?: string; value?: string }) => {
      const self = InstallNewPanel.current;
      if (!self) {
        return;
      }
      try {
        switch (msg.cmd) {
          case "ready":
            self.pushState();
            break;
          case "pick":
            // 进入组件版本子页：扩展侧拉取列表推送
            if (msg.component) {
              const payload = await self.callbacks.fetchVersions(msg.component);
              void panel.webview.postMessage({ type: "versions", data: payload });
            }
            break;
          case "set":
            if (msg.component && msg.version) {
              self.callbacks.setPlan(msg.component, msg.version);
              void panel.webview.postMessage({ type: "setPlan", data: { component: msg.component, version: msg.version } });
            }
            break;
          case "setCustomName":
            self.callbacks.setPlan("customName", msg.value ?? "");
            break;
          case "clear":
            self.callbacks.clearPlan(msg.component);
            self.pushState();
            break;
          case "clearAll":
            self.callbacks.clearPlan();
            self.pushState();
            break;
          case "install":
            await self.callbacks.install(self.callbacks.getPlan());
            panel.dispose();
            break;
          default:
            break;
        }
      } catch (e) {
        void vscode.window.showErrorMessage(`VSCL：${e instanceof Error ? e.message : String(e)}`);
      }
    });
    return InstallNewPanel.current;
  }

  /** 状态变更后刷新 */
  public refresh(): void {
    this.pushState();
  }

  private pushState(): void {
    void this.panel?.webview.postMessage({
      type: "state",
      data: { plan: this.callbacks.getPlan(), downloading: this.callbacks.isDownloading() } satisfies InstallNewState,
    });
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
  <title>安装新游戏</title>
</head>
<body>
  <!-- 主视图：组件列表 -->
  <div class="page" id="view-main">
    <div class="view-bar">
      <span class="view-title">安装新游戏</span>
    </div>
    <div class="section">
      <div class="section-desc">选择游戏版本与组件（对齐 HMCL）：Minecraft 必选；加载器至多一个；OptiFine 可叠加于原版或加载器之上。</div>
      <div class="row" style="grid-template-columns: 130px 1fr;">
        <div class="row-label"><div class="row-name">客户端名称</div></div>
        <div class="row-control">
          <input type="text" id="custom-name" placeholder="留空自动生成（如 fabric-loader-0.20.1-1.21.8）；命名作用于最终实例" spellcheck="false">
        </div>
      </div>
      <div id="comp-list"><div class="empty">加载中…</div></div>
    </div>
    <div class="install-bar">
      <button class="tool secondary" data-cmd="clearAll">清空选择</button>
      <button class="tool" id="install-btn" data-cmd="install" disabled>安装</button>
    </div>
  </div>

  <!-- 子视图：版本选择 -->
  <div class="page" id="view-pick" hidden>
    <div class="view-bar">
      <span class="back-link" data-cmd="back">← 返回</span>
      <span class="view-title" id="pick-title" style="font-size: 15px;">选择版本</span>
      <input type="text" id="pick-search" placeholder="搜索…" spellcheck="false" style="max-width: 200px;">
      <button class="tool secondary" id="pick-refresh" title="重新获取版本列表">刷新</button>
    </div>
    <div class="section"><div id="ver-list"><div class="empty">加载中…</div></div></div>
  </div>

  <script nonce="${nonce}">(function () {
    const vscode = acquireVsCodeApi();
    const $ = (s) => document.querySelector(s);
    function esc(s) {
      return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    const COMPS = [
      { id: 'minecraft', name: 'Minecraft', hint: '游戏本体（必选）' },
      { id: 'forge', name: 'Forge' },
      { id: 'neoforge', name: 'NeoForge' },
      { id: 'cleanroom', name: 'Cleanroom' },
      { id: 'fabric', name: 'Fabric' },
      { id: 'legacyfabric', name: 'Legacy Fabric' },
      { id: 'quilt', name: 'Quilt' },
      { id: 'liteloader', name: 'LiteLoader' },
      { id: 'optifine', name: 'OptiFine' },
    ];
    const NAME = Object.fromEntries(COMPS.map((c) => [c.id, c.name]));
    // 互斥加载器组（至多选一个）；LiteLoader/OptiFine 可单独、可叠加于 Forge
    const MUTEX = ['forge', 'neoforge', 'cleanroom', 'fabric', 'legacyfabric', 'quilt'];
    // 默认命名优先级（LiteLoader 高于 Forge：LL+OF → version-LiteLoader）
    const NAME_PRIORITY = ['liteloader', 'forge', 'neoforge', 'cleanroom', 'fabric', 'quilt', 'legacyfabric'];
    let plan = {};
    let pickComponent = null;   // 当前子页组件
    let versions = [];          // 子页版本数据
    let downloading = false;

    /** 组件不可选原因（null = 可选） */
    function compatOf(comp) {
      if (comp === 'minecraft') return null;
      if (!plan.minecraft) return '请先选择 Minecraft 版本';
      const pickedMutex = MUTEX.find((l) => plan[l]);
      if (MUTEX.includes(comp)) {
        return pickedMutex && pickedMutex !== comp ? '与 ' + NAME[pickedMutex] + ' 不兼容' : null;
      }
      // liteloader / optifine：可单独；仅可与 Forge 叠加
      if (pickedMutex && pickedMutex !== 'forge') return '仅支持与 Forge 同时安装';
      return null;
    }

    /** 默认客户端名称（version-loader；OF 叠加时以主加载器为准） */
    function defaultName() {
      const mc = plan.minecraft;
      if (!mc) return '';
      const primary = NAME_PRIORITY.find((l) => plan[l]);
      if (primary) return mc + '-' + NAME[primary];
      if (plan.optifine) return mc + '-OptiFine';
      return mc;
    }

    function show(view) {
      $('#view-main').hidden = view !== 'main';
      $('#view-pick').hidden = view !== 'pick';
    }

    function renderMain() {
      $('#comp-list').innerHTML = COMPS.map((c) => {
        const picked = plan[c.id];
        const reason = compatOf(c.id);
        let action;
        if (picked) {
          action = '<span class="badge">' + esc(picked) + '</span>'
            + '<button class="tool secondary" data-cmd="pick" data-comp="' + c.id + '">更换</button>'
            + (c.id === 'minecraft' ? '' : '<button class="icon-btn" data-cmd="clear" data-comp="' + c.id + '" title="清除">✕</button>');
        } else {
          action = '<button class="tool secondary" data-cmd="pick" data-comp="' + c.id + '"' + (reason ? ' disabled title="' + esc(reason) + '"' : '') + '>选择版本</button>'
            + (reason ? '<span class="list-meta">' + esc(reason) + '</span>' : '');
        }
        return '<div class="list-row">'
        + '<span class="list-name">' + esc(c.name) + '</span>'
        + '<span class="list-meta">' + esc(c.hint || '') + '</span>'
        + action + '</div>';
      }).join('');
      const btn = $('#install-btn');
      btn.disabled = !plan.minecraft || downloading;
      btn.textContent = downloading ? '安装中…' : '安装';
      $('#custom-name').placeholder = defaultName() ? '默认：' + defaultName() + '（命名仅作用于最终实例）' : '先选择 Minecraft 版本';
    }

    function renderVersions(payload) {
      versions = payload.items || [];
      $('#pick-title').textContent = '选择 ' + (payload.name || payload.component);
      $('#pick-search').value = '';
      paintVersions('');
      if (payload.error) {
        $('#ver-list').innerHTML = '<div class="empty">获取版本列表失败：' + esc(payload.error) + '</div>';
      }
    }
    function paintVersions(q) {
      const filtered = versions.filter((v) => !q || v.version.toLowerCase().includes(q));
      if (filtered.length === 0) {
        $('#ver-list').innerHTML = '<div class="empty">无匹配版本</div>';
        return;
      }
      $('#ver-list').innerHTML = filtered.map((v) =>
        '<div class="list-row ver-row" data-cmd="set" data-ver="' + esc(v.version) + '">'
        + '<span class="id">' + esc(v.version) + '</span>'
        + (v.stable ? '' : '<span class="badge">开发版</span>')
        + (v.detail ? '<span class="list-meta">' + esc(v.detail) + '</span>' : '')
        + '</div>'
      ).join('');
    }

    document.body.addEventListener('click', (e) => {
      const el = e.target.closest('[data-cmd]');
      if (!el) return;
      const cmd = el.dataset.cmd;
      if (cmd === 'back') { show('main'); return; }
      if (cmd === 'clear') { vscode.postMessage({ cmd: 'clear', component: el.dataset.comp }); return; }
      if (cmd === 'clearAll') { vscode.postMessage({ cmd: 'clearAll' }); return; }
      if (cmd === 'set') {
        vscode.postMessage({ cmd: 'set', component: pickComponent, version: el.dataset.ver });
        return;
      }
      if (cmd === 'pick') { pickComponent = el.dataset.comp; show('pick'); }
      vscode.postMessage({ cmd, component: el.dataset.comp });
    });
    $('#pick-search').addEventListener('input', (e) => paintVersions(String(e.target.value).trim().toLowerCase()));
    // 刷新当前组件的版本列表（重新拉取）
    $('#pick-refresh').addEventListener('click', () => {
      if (pickComponent) {
        $('#ver-list').innerHTML = '<div class="empty">加载中…</div>';
        vscode.postMessage({ cmd: 'pick', component: pickComponent });
      }
    });
    $('#custom-name').addEventListener('change', (e) => {
      vscode.postMessage({ cmd: 'setCustomName', value: String(e.target.value || '').trim() });
    });

    window.addEventListener('message', (e) => {
      const msg = e.data;
      if (!msg) return;
      if (msg.type === 'state') {
        plan = msg.data.plan || {};
        downloading = !!msg.data.downloading;
        $('#custom-name').value = plan.customName || '';
        renderMain();
      } else if (msg.type === 'versions') {
        renderVersions(msg.data);
      } else if (msg.type === 'setPlan') {
        plan[msg.data.component] = msg.data.version;
        show('main');
        renderMain();
      }
    });

    vscode.postMessage({ cmd: 'ready' });
    renderMain();
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
