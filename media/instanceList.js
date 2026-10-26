// 实例列表前端：目录栏渲染（激活/删除/添加）+ 实例列表（选中/启动/打开设置）
/* global acquireVsCodeApi, VSCL_ICON, VSCL_RENDER_ICONS */
(function () {
  const vscode = acquireVsCodeApi();
  const $ = (s) => document.querySelector(s);
  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  const KIND_LABEL = { workspace: "工作区", registered: "注册", official: "官方" };

  function render(state) {
    // ── 左栏目录 ──
    const dirs = state.directories || [];
    $("#dir-list").innerHTML = dirs.length
      ? dirs
          .map(
            (d) => `
      <div class="dir-item${d.active ? " active" : ""}" data-cmd="activateDir" data-path="${esc(d.path)}" title="${esc(d.path)}">
        <span class="dir-icon" data-icon="folder"></span>
        <span class="dir-text">
          <span class="name">${esc(d.name)}</span>
          <span class="dir-path">${esc(d.displayPath || d.path)}</span>
        </span>
        <span class="badge">${esc(KIND_LABEL[d.kind] || d.kind)}</span>
        ${d.kind === "registered" ? `<button class="icon-btn" data-cmd="removeDir" data-path="${esc(d.path)}" title="移除目录">${VSCL_ICON("delete", 14)}</button>` : ""}
      </div>`
          )
          .join("")
      : '<div class="empty">暂无目录</div>';
    // 目录渲染后立即注入图标（空实例列表分支提前 return 也不能跳过）
    VSCL_RENDER_ICONS(document.body);

    // ── 右侧实例列表 ──
    $("#dir-current").textContent = state.activeDir || "（未检测到游戏目录）";
    const instances = state.instances || [];
    if (instances.length === 0) {
      $("#inst-list").innerHTML = '<div class="dc-empty">该目录下没有实例 —— 可前往「下载中心」安装新游戏</div>';
      return;
    }
    $("#inst-list").innerHTML = instances
      .map((i) => {
        return `
      <div class="inst-row${i.id === state.selectedId ? " selected" : ""}" data-cmd="selectRow" data-id="${esc(i.id)}">
        <span class="dir-icon">${VSCL_ICON(i.icon || "box", 20)}</span>
        <span class="list-name">${esc(i.id)}</span>
        ${i.components.length ? i.components.map((c) => `<span class="badge">${esc(c)}</span>`).join(" ") : '<span class="badge">原版</span>'}
        ${i.javaMajor ? `<span class="badge">Java ${i.javaMajor}</span>` : ""}
        ${i.running ? '<span class="badge">运行中</span>' : ""}
        <button class="tool secondary" data-cmd="openInstance" data-id="${esc(i.id)}" title="打开实例设置">设置</button>
        <button class="tool" data-cmd="launch" data-id="${esc(i.id)}" ${i.running ? "disabled" : ""} title="启动">${VSCL_ICON("play", 14)} 启动</button>
      </div>`;
      })
      .join("");
  }

  // 目录区左右拖拽调宽（复用 dc-resizer 逻辑，不持久化）
  (function () {
    const side = document.querySelector(".il-side");
    const resizer = $("#dc-resizer");
    let dragging = false;
    resizer.addEventListener("mousedown", (e) => {
      dragging = true;
      resizer.classList.add("dragging");
      e.preventDefault();
    });
    window.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      side.style.width = Math.min(420, Math.max(180, e.clientX)) + "px";
    });
    window.addEventListener("mouseup", () => {
      dragging = false;
      resizer.classList.remove("dragging");
    });
  })();

  document.body.addEventListener("click", (e) => {
    const el = e.target.closest("[data-cmd]");
    if (!el) return;
    const cmd = el.dataset.cmd;
    if (cmd === "selectRow") {
      // 点击行 = 选中（同步侧栏与启动目标）；命令经扩展路由
      vscode.postMessage({ cmd: "selectInstance", id: el.dataset.id });
      return;
    }
    vscode.postMessage({ cmd, path: el.dataset.path, id: el.dataset.id });
  });

  window.addEventListener("message", (e) => {
    const msg = e.data;
    if (msg && msg.type === "state") {
      render(msg.data);
    }
  });

  vscode.postMessage({ cmd: "ready" });
})();
