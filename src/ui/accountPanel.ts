// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 VSCL contributors
/**
 * 账户相关页（两个独立编辑器标签）：
 *  - AccountPanel「账户」：仅单选列表；标题行右侧「＋ 添加账户」
 *  - AddAccountPanel「添加账户」：顶部标签 微软 / 离线 / 外置登录(authlib-injector 占位)；
 *    标题行右侧「账户列表」按钮跳回；账户列表使用说明置于微软选项卡下
 * 样式统一外置 media/instancePanel.css（内联 <style> 会被 CSP 拦截）。
 * 存储对照 HMCL：元数据 accounts.json + 私密令牌（HMCL 混淆文件 → VSCL 用 SecretStorage）。
 */
import * as vscode from "vscode";

/** 账户列表页状态 */
export interface AccountPanelState {
  accounts: { id: string; type: string; username: string; uuid: string }[];
  selectedId?: string;
  /** 微软 Client ID 是否已配置 */
  clientIdConfigured: boolean;
}

export interface AccountPanelCallbacks {
  getState(): AccountPanelState;
  select(id: string): Promise<void>;
  remove(id: string): Promise<void>;
  /** 打开「添加账户」标签 */
  openAdd(): void;
}

export interface AddAccountPanelCallbacks {
  getClientIdConfigured(): boolean;
  addOffline(username: string): Promise<void>;
  addMicrosoft(): Promise<void>;
  openNativeSetting(query: string): Promise<void>;
  /** 回到「账户」列表标签 */
  openList(): void;
}

function getNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let text = "";
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}

/** 通用面板壳（CSP + 外置样式） */
function shell(context: vscode.ExtensionContext, webview: vscode.Webview, title: string, body: string, script: string): string {
  const media = vscode.Uri.joinPath(context.extensionUri, "media");
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
  <title>${title}</title>
</head>
<body>
${body}
  <script nonce="${nonce}">${script}</script>
</body>
</html>`;
}

/** 账户列表面板 */
export class AccountPanel {
  public static current: AccountPanel | undefined;
  private panel?: vscode.WebviewPanel;

  private constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly callbacks: AccountPanelCallbacks
  ) {}

  /** 打开或复用账户列表标签 */
  public static createOrShow(context: vscode.ExtensionContext, callbacks: AccountPanelCallbacks): AccountPanel {
    if (AccountPanel.current) {
      AccountPanel.current.panel?.reveal();
      AccountPanel.current.pushState();
      return AccountPanel.current;
    }
    AccountPanel.current = new AccountPanel(context, callbacks);
    const panel = vscode.window.createWebviewPanel("vscl.accountList", "账户", vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: false,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "media")],
    });
    AccountPanel.current.panel = panel;
    panel.webview.html = AccountPanel.current.buildHtml(panel.webview);
    panel.onDidDispose(() => {
      AccountPanel.current = undefined;
    });
    panel.webview.onDidReceiveMessage(async (msg: { cmd?: string; id?: string }) => {
      const self = AccountPanel.current;
      if (!self) {
        return;
      }
      try {
        if (msg.cmd === "ready") {
          self.pushState();
        } else if (msg.cmd === "openAdd") {
          self.callbacks.openAdd();
        } else if (msg.cmd === "select" && msg.id) {
          await self.callbacks.select(msg.id);
          self.pushState();
        } else if (msg.cmd === "remove" && msg.id) {
          await self.callbacks.remove(msg.id);
          self.pushState();
        }
      } catch (e) {
        void vscode.window.showErrorMessage(`VSCL：${e instanceof Error ? e.message : String(e)}`);
      }
    });
    return AccountPanel.current;
  }

  /** 状态变更后刷新 */
  public refresh(): void {
    this.pushState();
  }

  private pushState(): void {
    void this.panel?.webview.postMessage({ type: "state", data: this.callbacks.getState() });
  }

  private buildHtml(webview: vscode.Webview): string {
    const body = /* html */ `
  <div class="page">
    <div class="view-bar">
      <span class="view-title">账户列表</span>
      <button class="tool" data-cmd="openAdd">＋ 添加账户</button>
    </div>
    <div class="section">
      <div class="section-desc">选择启动游戏使用的账户（单选，切换即时生效）。未添加账户时默认以 Dev 离线启动。</div>
      <div id="acct-list"><div class="empty">加载中…</div></div>
    </div>
  </div>`;
    const script = `(function () {
  const vscode = acquireVsCodeApi();
  const $ = (s) => document.querySelector(s);
  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  document.body.addEventListener('click', (e) => {
    const el = e.target.closest('[data-cmd]');
    if (!el) return;
    vscode.postMessage({ cmd: el.dataset.cmd, id: el.dataset.id });
  });
  window.addEventListener('message', (e) => {
    const msg = e.data;
    if (!msg || msg.type !== 'state') return;
    const { accounts, selectedId } = msg.data;
    if (!accounts || accounts.length === 0) {
      $('#acct-list').innerHTML = '<div class="empty">暂无账户 —— 点击右上角「添加账户」创建</div>';
      return;
    }
    $('#acct-list').innerHTML = accounts.map((a) =>
      '<div class="list-row acct-row' + (a.id === selectedId ? ' selected' : '') + '">'
      + '<input type="radio" class="radio" name="acct" data-cmd="select" data-id="' + esc(a.id) + '" ' + (a.id === selectedId ? 'checked' : '') + '>'
      + '<span class="list-name">' + esc(a.username) + '</span>'
      + '<span class="badge">' + (a.type === 'microsoft' ? '微软' : a.type === 'authlibInjector' ? '外置' : '离线') + '</span>'
      + '<span class="list-meta">' + esc(a.uuid) + '</span>'
      + '<button class="icon-btn" data-cmd="remove" data-id="' + esc(a.id) + '" title="删除账户">✕</button>'
      + '</div>'
    ).join('');
  });
  vscode.postMessage({ cmd: 'ready' });
})();`;
    return shell(this.context, webview, "账户", body, script);
  }
}

/** 添加账户面板（独立标签：微软 / 离线 / 外置登录） */
export class AddAccountPanel {
  public static current: AddAccountPanel | undefined;
  private panel?: vscode.WebviewPanel;

  private constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly callbacks: AddAccountPanelCallbacks
  ) {}

  /** 打开或复用添加账户标签 */
  public static createOrShow(context: vscode.ExtensionContext, callbacks: AddAccountPanelCallbacks): AddAccountPanel {
    if (AddAccountPanel.current) {
      AddAccountPanel.current.panel?.reveal();
      AddAccountPanel.current.pushState();
      return AddAccountPanel.current;
    }
    AddAccountPanel.current = new AddAccountPanel(context, callbacks);
    const panel = vscode.window.createWebviewPanel("vscl.addAccount", "添加账户", vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: false,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "media")],
    });
    AddAccountPanel.current.panel = panel;
    panel.webview.html = AddAccountPanel.current.buildHtml(panel.webview);
    panel.onDidDispose(() => {
      AddAccountPanel.current = undefined;
    });
    panel.webview.onDidReceiveMessage(async (msg: { cmd?: string; username?: string; query?: string }) => {
      const self = AddAccountPanel.current;
      if (!self) {
        return;
      }
      try {
        if (msg.cmd === "ready") {
          self.pushState();
        } else if (msg.cmd === "openList") {
          self.callbacks.openList();
        } else if (msg.cmd === "addOffline" && msg.username?.trim()) {
          await self.callbacks.addOffline(msg.username.trim());
          self.callbacks.openList(); // 添加成功回列表
        } else if (msg.cmd === "addMicrosoft") {
          await self.callbacks.addMicrosoft();
          self.callbacks.openList();
        } else if (msg.cmd === "openNativeSetting") {
          await self.callbacks.openNativeSetting(msg.query || "@ext:vscl.vscl");
        }
      } catch (e) {
        void vscode.window.showErrorMessage(`VSCL：${e instanceof Error ? e.message : String(e)}`);
      }
    });
    return AddAccountPanel.current;
  }

  /** 刷新（Client ID 状态） */
  public refresh(): void {
    this.pushState();
  }

  private pushState(): void {
    void this.panel?.webview.postMessage({
      type: "state",
      data: { clientIdConfigured: this.callbacks.getClientIdConfigured() },
    });
  }

  private buildHtml(webview: vscode.Webview): string {
    const body = /* html */ `
  <div class="page">
    <div class="view-bar">
      <span class="view-title">添加账户</span>
      <button class="tool secondary" data-cmd="openList">账户列表</button>
    </div>
    <div class="tabs" style="position: static; padding: 0 8px;">
      <span class="tab active" data-atab="microsoft">微软</span>
      <span class="tab" data-atab="offline">离线</span>
      <span class="tab" data-atab="authlib">外置登录</span>
    </div>

    <div id="atab-microsoft" style="padding-top: 16px;">
      <div class="section">
        <div class="section-title">微软账户（正版验证）</div>
        <div class="section-desc">
          使用设备码流程登录：点击下方按钮获取代码，在浏览器完成微软授权后自动返回。
          令牌使用 SecretStorage（系统密钥库）安全存储，启动时自动刷新。<br><br>
          <b>账户说明</b>：账户列表以单选方式决定启动身份，切换即时生效；
          未添加任何账户时，启动游戏默认以 <b>Dev</b> 用户名离线启动。
        </div>
        <div class="row" style="grid-template-columns: 1fr;">
          <div class="row-control">
            <button class="tool" data-cmd="addMicrosoft">登录微软账户…</button>
            <button class="tool secondary" data-cmd="openNativeSetting" data-query="vscl.microsoftClientId">配置 Client ID</button>
          </div>
        </div>
        <div class="section-desc" id="ms-hint">—</div>
      </div>
    </div>

    <div id="atab-offline" hidden style="padding-top: 16px;">
      <div class="section">
        <div class="section-title">离线账户</div>
        <div class="section-desc">
          直接填写用户名即可添加。UUID 按 Mojang 离线规则生成（UUIDv3 of "OfflinePlayer:&lt;name&gt;"），
          同名用户在不同工具间保持一致。仅建议用于单机或离线服务器。
        </div>
        <div class="auth-input">
          <input type="text" id="offline-name" placeholder="用户名…" spellcheck="false">
          <button class="tool" data-cmd="addOfflineInput">添加</button>
        </div>
      </div>
    </div>

    <div id="atab-authlib" hidden style="padding-top: 16px;">
      <div class="section">
        <div class="section-title">外置登录（authlib-injector）</div>
        <div class="placeholder-box">
          第三方皮肤站登录（authlib-injector）开发中。<br>
          届时填入皮肤站 API 地址并使用用户名密码登录，游戏启动时自动注入 agent。
        </div>
      </div>
    </div>
  </div>`;
    const script = `(function () {
  const vscode = acquireVsCodeApi();
  const $ = (s) => document.querySelector(s);
  document.querySelectorAll('.tab[data-atab]').forEach((t) =>
    t.addEventListener('click', () => {
      document.querySelectorAll('.tab[data-atab]').forEach((x) => x.classList.toggle('active', x === t));
      ['microsoft', 'offline', 'authlib'].forEach((k) => { $('#atab-' + k).hidden = t.dataset.atab !== k; });
    })
  );
  document.body.addEventListener('click', (e) => {
    const el = e.target.closest('[data-cmd]');
    if (!el) return;
    const cmd = el.dataset.cmd;
    if (cmd === 'addOfflineInput') {
      const input = $('#offline-name');
      if (!input.value.trim()) { input.focus(); return; }
      vscode.postMessage({ cmd: 'addOffline', username: input.value.trim() });
      input.value = '';
      return;
    }
    vscode.postMessage({ cmd, query: el.dataset.query });
  });
  $('#offline-name').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { document.querySelector('[data-cmd="addOfflineInput"]').click(); }
  });
  window.addEventListener('message', (e) => {
    const msg = e.data;
    if (!msg || msg.type !== 'state') return;
    $('#ms-hint').textContent = msg.data.clientIdConfigured
      ? 'Client ID 已配置，可直接登录。'
      : '尚未配置 Client ID：需先在 Azure 门户注册应用（公共客户端），否则无法登录微软账户。';
  });
  vscode.postMessage({ cmd: 'ready' });
})();`;
    return shell(this.context, webview, "添加账户", body, script);
  }
}
