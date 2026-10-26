// VSCL 主侧栏 webview 脚本：渲染状态 + 上报用户意图（与扩展单向通信）
/* global acquireVsCodeApi, VSCL_ICON, VSCL_RENDER_ICONS */
(function () {
  const vscode = acquireVsCodeApi();
  const $ = (sel) => document.querySelector(sel);

  /** @type {{ activeDirectory?: string, activeSource?: string, selected?: any, instances: any[] }} */
  let state = { instances: [] };

  function render() {
    const { activeDirectory, activeSource, selected, instances } = state;

    // 目录行
    $("#dir-path").textContent = activeDirectory || "（未检测到游戏目录）";
    $("#dir-source").textContent = activeSource
      ? { workspace: "工作区", registered: "注册目录", official: "官方启动器目录" }[activeSource] || activeSource
      : "";

    // 当前实例卡（自定义图标经 data URI 显示，无则按 icon 键渲染 SVG）
    const card = $("#instance-card");
    if (selected) {
      const iconHtml = selected.iconUri
        ? `<img class="instance-img" src="${escapeHtml(selected.iconUri)}" alt="${escapeHtml(selected.icon || "box")}">`
        : `<span class="instance-icon">${VSCL_ICON(selected.icon || "box", 20)}</span>`;
      card.innerHTML = `
        <div class="instance-title">
          ${iconHtml}
          <span>${escapeHtml(selected.id)}</span>
        </div>
        <div class="instance-meta">
          ${selected.components.length ? selected.components.map((c) => `<span class="badge">${escapeHtml(c)}</span>`).join(" ") : '<span class="badge">原版</span>'}
          ${selected.javaMajor ? `<span class="badge">Java ${selected.javaMajor}</span>` : ""}
          ${selected.hasOverride ? '<span class="badge">已自定义</span>' : ""}
        </div>`;
    } else {
      card.innerHTML = `<div class="empty-hint">${instances.length ? "未选择实例，点击下方按钮切换" : "暂无实例：先安装游戏版本（下载中心开发中）"}</div>`;
    }

    // 启动按钮 + 实例切换入口（点击弹出 VS Code 原生实例选择列表）
    const btn = $("#launch-btn");
    btn.disabled = !selected;
    $("#launch-sub").textContent = selected ? selected.id : "无可启动实例";
    $("#launch-toggle").disabled = instances.length === 0;

    // 动态注入静态占位图标（导航项、切换按钮等）
    VSCL_RENDER_ICONS(document.body);
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  window.addEventListener("message", (e) => {
    const msg = e.data;
    if (msg && msg.type === "state") {
      state = msg.data;
      render();
    }
  });

  // 用户意图上报（扩展侧统一路由到 Store/命令）
  document.body.addEventListener("click", (e) => {
    const target = e.target.closest("[data-cmd]");
    if (!target) return;
    vscode.postMessage({ cmd: target.getAttribute("data-cmd"), arg: target.getAttribute("data-arg") });
  });

  render();
})();
