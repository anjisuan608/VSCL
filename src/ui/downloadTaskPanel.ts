// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 VSCL contributors
/**
 * 下载与安装面板（每会话一个编辑器标签；多任务多标签）。
 * 结构：头部（任务名 + 实时速率 + 取消按钮）→ 阶段分组（当前阶段 done/total）→
 * 下载项列表（每项独立进度条，含待下载；完成项淡出消失）。
 * 标题：`下载和安装 - <任务名>`；意外关闭后可经完成通知/状态栏重新打开。
 */
import * as vscode from "vscode";
import { InstallSession } from "../core/download/installSession";

export class DownloadTaskPanel {
  private static readonly panels = new Map<string, DownloadTaskPanel>();

  private panel?: vscode.WebviewPanel;
  private readonly subs: vscode.Disposable[] = [];

  private constructor(
    private readonly session: InstallSession
  ) {}

  /** 打开或复用会话面板（支持同会话重开、多会话多标签） */
  public static open(session: InstallSession): DownloadTaskPanel {
    const existing = DownloadTaskPanel.panels.get(session.id);
    if (existing) {
      existing.panel?.reveal();
      existing.push();
      return existing;
    }
    const inst = new DownloadTaskPanel(session);
    const panel = vscode.window.createWebviewPanel(
      "vscl.downloadTask",
      `下载和安装 - ${session.title}`,
      vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    inst.panel = panel;
    panel.webview.html = inst.html();
    DownloadTaskPanel.panels.set(session.id, inst);
    panel.onDidDispose(() => {
      DownloadTaskPanel.panels.delete(session.id);
      inst.subs.forEach((s) => s.dispose());
    });
    panel.webview.onDidReceiveMessage((msg: { cmd?: string }) => {
      if (msg.cmd === "ready") {
        inst.push();
      } else if (msg.cmd === "cancel") {
        session.cancel();
      }
    });
    // 状态变化推送（速率/阶段/项目）
    inst.subs.push(session.onDidChange(() => inst.push()));
    inst.push();
    return inst;
  }

  /** 按会话 id 重开面板（通知/状态栏跳转） */
  public static reopen(id: string): boolean {
    const inst = DownloadTaskPanel.panels.get(id);
    if (inst) {
      inst.panel?.reveal();
      inst.push();
      return true;
    }
    return false;
  }

  private push(): void {
    void this.panel?.webview.postMessage({ type: "state", data: this.session.snapshot() });
  }

  private html(): string {
    const nonce = getNonce();
    return /* html */ `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); background: var(--vscode-editor-background); }
    .dt-head { position: sticky; top: 0; z-index: 5; display: flex; align-items: center; gap: 12px; padding: 10px 16px; background: var(--vscode-editor-background); border-bottom: 1px solid var(--vscode-widget-border, rgba(128,128,128,.25)); }
    .dt-title { font-weight: 600; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .dt-speed { font-size: 12px; color: var(--vscode-descriptionForeground); font-variant-numeric: tabular-nums; }
    .dt-cancel { padding: 5px 14px; border: none; border-radius: 3px; cursor: pointer; background: var(--vscode-button-secondaryBackground, rgba(128,128,128,.2)); color: var(--vscode-button-secondaryForeground, var(--vscode-foreground)); font-family: inherit; }
    .dt-cancel:hover:not(:disabled) { background: var(--vscode-button-secondaryHoverBackground, rgba(128,128,128,.32)); }
    .dt-cancel:disabled { opacity: .5; cursor: not-allowed; }
    .dt-phase { padding: 12px 16px 6px; }
    .dt-phase-name { display: flex; justify-content: space-between; font-size: 13px; font-weight: 600; margin-bottom: 6px; }
    .dt-phase-name .count { color: var(--vscode-descriptionForeground); font-variant-numeric: tabular-nums; }
    .bar { height: 6px; border-radius: 3px; background: var(--vscode-progressBar-background, rgba(128,128,128,.2)); overflow: hidden; }
    .bar > i { display: block; height: 100%; background: var(--vscode-progressBar-background); width: 0; transition: width .15s; }
    .dt-item { display: flex; align-items: center; gap: 10px; padding: 6px 16px; }
    .dt-item .name { flex: 1; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; direction: rtl; text-align: left; }
    .dt-item .pct { font-size: 11px; color: var(--vscode-descriptionForeground); width: 44px; text-align: right; font-variant-numeric: tabular-nums; }
    .dt-item .bar { flex: 2; height: 4px; }
    .dt-item.done { opacity: 0; transition: opacity .4s; }
    .dt-empty { padding: 40px; text-align: center; color: var(--vscode-descriptionForeground); }
    .dt-done { padding: 24px 16px; text-align: center; color: var(--vscode-testing-iconPassed, #4caf50); font-weight: 600; }
    .dt-error { padding: 24px 16px; text-align: center; color: var(--vscode-errorForeground); }
  </style>
</head>
<body>
  <div class="dt-head">
    <span class="dt-title" id="title">—</span>
    <span class="dt-speed" id="speed"></span>
    <button class="dt-cancel" id="cancel" data-cmd="cancel">取消</button>
  </div>
  <div id="content"><div class="dt-empty">等待任务…</div></div>
  <script nonce="${nonce}">(function () {
    const vscode = acquireVsCodeApi();
    const $ = (s) => document.querySelector(s);
    function esc(s) {
      return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }
    let state = null;
    const doneIds = new Set(); // 已完成项：淡出后不再渲染

    function pct(item) {
      if (!item.total) return item.status === 'done' ? 100 : 0;
      return Math.min(100, Math.round(item.received / item.total * 100));
    }

    function render() {
      if (!state) return;
      $('#title').textContent = ${JSON.stringify(`下载和安装 - ${this.session.title}`)};
      $('#speed').textContent = state.speedText || '';
      $('#cancel').disabled = state.completed || state.cancelled;
      $('#cancel').textContent = state.cancelled ? '已取消' : (state.completed ? '已完成' : '取消');
      const c = $('#content');
      if (state.error) {
        c.innerHTML = '<div class="dt-error">出错：' + esc(state.error) + '</div>';
        return;
      }
      if (state.cancelled) {
        c.innerHTML = '<div class="dt-error">已取消（已完成的文件保留）</div>';
        return;
      }
      if (state.completed) {
        c.innerHTML = '<div class="dt-done">✓ 安装完成</div>';
        return;
      }
      if (!state.phase && (!state.items || state.items.length === 0)) {
        c.innerHTML = '<div class="dt-empty">准备中…</div>';
        return;
      }
      const phasePct = state.phaseTotal > 0 ? Math.min(100, Math.round(state.phaseDone / state.phaseTotal * 100)) : 0;
      let html = '';
      if (state.phase) {
        html += '<div class="dt-phase"><div class="dt-phase-name"><span>' + esc(state.phase) + '</span>'
          + '<span class="count">' + state.phaseDone + ' / ' + state.phaseTotal + '</span></div>'
          + '<div class="bar"><i style="width:' + phasePct + '%"></i></div></div>';
      }
      html += (state.items || []).filter((i) => !doneIds.has(i.id)).map((i) => {
        return '<div class="dt-item" id="item-' + esc(i.id) + '">'
          + '<span class="name">' + esc(i.name) + '</span>'
          + '<div class="bar"><i style="width:' + pct(i) + '%"></i></div>'
          + '<span class="pct">' + pct(i) + '%</span></div>';
      }).join('');
      c.innerHTML = html || '<div class="dt-empty">等待下一阶段…</div>';
      // 完成项标记淡出（本轮列表已滤除；保留集合防回显）
      (state.doneIds || []).forEach((id) => doneIds.add(id));
    }

    document.body.addEventListener('click', (e) => {
      const el = e.target.closest('[data-cmd]');
      if (el) vscode.postMessage({ cmd: el.dataset.cmd });
    });
    window.addEventListener('message', (e) => {
      if (e.data && e.data.type === 'state') { state = e.data.data; render(); }
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
