// 下载中心前端：渲染版本清单 + 过滤/搜索 + 安装请求
/* global acquireVsCodeApi */
(function () {
  const vscode = acquireVsCodeApi();
  const $ = (sel) => document.querySelector(sel);

  /** @type {{ latest: any, versions: any[] }} */
  let manifest = { latest: {}, versions: [] };
  let filter = "release";
  let query = "";
  let installing = new Set();

  const TYPE_LABEL = { release: "正式版", snapshot: "快照", old_beta: "Beta", old_alpha: "Alpha" };

  function matches(v) {
    if (query && !v.id.toLowerCase().includes(query)) return false;
    if (filter === "all") return true;
    if (filter === "old") return v.type === "old_beta" || v.type === "old_alpha";
    return v.type === filter;
  }

  function render() {
    // 最新卡
    const latestEl = $("#latest");
    const rel = manifest.versions.find((v) => v.id === manifest.latest.release);
    const snap = manifest.versions.find((v) => v.id === manifest.latest.snapshot);
    latestEl.innerHTML = [rel, snap]
      .filter(Boolean)
      .map(
        (v) => `
      <div class="dc-latest-card">
        <span class="tag">${v.type === "snapshot" ? "最新快照" : "最新正式版"}</span>
        <div class="name">${escapeHtml(v.id)}</div>
        <button class="dc-button" data-install="${escapeHtml(v.id)}" ${installing.has(v.id) ? "disabled" : ""}>
          ${installing.has(v.id) ? "打开中…" : "选择"}
        </button>
      </div>`
      )
      .join("");

    // 列表
    const list = $("#list");
    const rows = manifest.versions.filter(matches);
    if (manifest.versions.length === 0) {
      list.innerHTML = '<div class="dc-empty">加载中…</div>';
      return;
    }
    if (rows.length === 0) {
      list.innerHTML = '<div class="dc-empty">无匹配版本</div>';
      return;
    }
    list.innerHTML = rows
      .map((v) => {
        const time = (v.releaseTime || "").slice(0, 10);
        return `
      <div class="dc-row">
        <span class="dc-badge">${TYPE_LABEL[v.type] || v.type}</span>
        <span class="id">${escapeHtml(v.id)}</span>
        <span class="meta">${time}</span>
        <button class="dc-button" data-install="${escapeHtml(v.id)}" ${installing.has(v.id) ? "disabled" : ""}>
          ${installing.has(v.id) ? "打开中…" : "选择"}
        </button>
      </div>`;
      })
      .join("");
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  window.addEventListener("message", (e) => {
    const msg = e.data;
    if (!msg) return;
    if (msg.type === "manifest") {
      manifest = msg.data;
      if (msg.sources) {
        $('#list-source').value = msg.sources.listSource || 'bmclapi';
        $('#dl-source').value = msg.sources.downloadSource || 'bmclapi';
      }
      render();
    } else if (msg.type === "installing") {
      installing.add(msg.id);
      render();
    } else if (msg.type === "installed") {
      installing.delete(msg.id);
      render();
    } else if (msg.type === "install-failed") {
      installing.delete(msg.id);
      render();
    } else if (msg.type === "error") {
      $("#list").innerHTML = `<div class="dc-error">${escapeHtml(msg.error)}</div>`;
    }
  });

  document.body.addEventListener("click", (e) => {
    const installBtn = e.target.closest("[data-install]");
    if (installBtn) {
      vscode.postMessage({ cmd: "install", id: installBtn.getAttribute("data-install") });
      return;
    }
    if (e.target.closest("#refresh")) {
      vscode.postMessage({ cmd: "refresh" });
      return;
    }
    // 版本类型通道（顶部 chips）
    const chip = e.target.closest(".dc-chip");
    if (chip) {
      filter = chip.getAttribute("data-filter");
      document.querySelectorAll(".dc-chip").forEach((c) => c.classList.toggle("active", c === chip));
      render();
      return;
    }
    // 左侧内容大类导航（当前仅「游戏」实现）
    const nav = e.target.closest(".dc-side-item");
    if (nav && !nav.classList.contains("disabled")) {
      document.querySelectorAll(".dc-side-item").forEach((c) => c.classList.toggle("active", c === nav));
    }
  });

  $("#search").addEventListener("input", (e) => {
    query = e.target.value.trim().toLowerCase();
    render();
  });

  // 双源快速切换（下载源 / 列表源）
  $('#list-source').addEventListener('change', (e) => {
    vscode.postMessage({ cmd: 'setSource', key: 'listSource', value: e.target.value });
  });
  $('#dl-source').addEventListener('change', (e) => {
    vscode.postMessage({ cmd: 'setSource', key: 'downloadSource', value: e.target.value });
  });

  // 左右拖拽调宽（不持久化；范围 140–360px）
  (function () {
    const side = $('#dc-side');
    const resizer = $('#dc-resizer');
    let dragging = false;
    resizer.addEventListener('mousedown', (e) => {
      dragging = true;
      resizer.classList.add('dragging');
      e.preventDefault();
    });
    window.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      const w = Math.min(420, Math.max(180, e.clientX));
      side.style.width = w + "px";
    });
    window.addEventListener('mouseup', () => {
      dragging = false;
      resizer.classList.remove('dragging');
    });
  })();

  // 注入左栏 MD3 图标（icons.js 提供）
  if (typeof VSCL_RENDER_ICONS === "function") {
    VSCL_RENDER_ICONS(document.body);
  }

  vscode.postMessage({ cmd: "ready" });
  render();
})();
