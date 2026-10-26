// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 VSCL contributors
/**
 * VSCL 扩展入口。
 * 职责：装配 Store / 侧栏 / 命令；游戏目录解析与实例扫描的调度；
 * 状态持久化（workspaceState，多窗口隔离）。
 */
import * as vscode from "vscode";
import { Settings } from "./config/settings";
import { Store } from "./core/state/store";
import { resolveActiveDirectory } from "./core/game/gameDirectory";
import { scanInstances } from "./core/game/instance";
import { detectJava, JavaInstall } from "./core/java/javaDetector";
import { SidebarProvider } from "./ui/sidebar";

const SELECTED_INSTANCE_KEY = "vscl.selectedInstance";

/** 可用于图标文件名的键白名单（防路径注入；与 scripts/icons.json 对齐） */
const ICON_KEYS = new Set(["box", "image", "forge", "neoforge", "fabric", "quilt", "liteloader", "optifine", "cleanroom"]);

/** 实例图标键 → QuickPick 双主题 SVG 路径（media/icons/{light,dark}/<key>.svg） */
function instanceIconPath(
  context: vscode.ExtensionContext,
  iconKey: string | undefined
): { light: vscode.Uri; dark: vscode.Uri } {
  const key = iconKey && ICON_KEYS.has(iconKey) ? iconKey : "box";
  const base = vscode.Uri.joinPath(context.extensionUri, "media", "icons");
  return { light: vscode.Uri.joinPath(base, "light", `${key}.svg`), dark: vscode.Uri.joinPath(base, "dark", `${key}.svg`) };
}

/** 扩展激活入口 */
export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const store = new Store();
  let latestJava: JavaInstall | undefined;

  /** 按优先级链解析目录 → 扫描实例 → 广播状态 */
  async function refresh(): Promise<void> {
    const resolved = resolveActiveDirectory({
      workspaceRoots: (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath),
      registered: Settings.gameDirectories(),
      activeSetting: Settings.activeGameDirectory(),
    });
    const instances = await scanInstances(resolved.dir);

    // 恢复本窗口上次选中的实例（workspaceState：每窗口独立，避免多窗口串号）
    const persisted = context.workspaceState.get<string>(SELECTED_INSTANCE_KEY);
    const selected =
      instances.find((i) => i.id === persisted)?.id ?? instances[0]?.id;

    store.update({
      activeDirectory: resolved.dir,
      activeSource: resolved.source,
      instances,
      selectedInstanceId: selected,
    });
    sidebar.postState(latestJava);
  }

  // 状态持久化 + 侧栏推送（Store 广播已由 SidebarProvider 订阅）
  context.subscriptions.push(
    store.event((s) => {
      if (s.selectedInstanceId) {
        void context.workspaceState.update(SELECTED_INSTANCE_KEY, s.selectedInstanceId);
      }
    })
  );

  // 主侧栏
  const sidebar = new SidebarProvider(context, store);
  sidebar.register(context);

  // —— 命令 ——
  context.subscriptions.push(
    vscode.commands.registerCommand("vscl.refresh", () => refresh()),

    vscode.commands.registerCommand("vscl.launch", async () => {
      const instance = store.selectedInstance;
      if (!instance) {
        void vscode.window.showWarningMessage("VSCL：未选择可启动的实例。");
        return;
      }
      // 占位：启动链路（Java 匹配 → 命令构建 → spawn）在下一里程碑实现
      void vscode.window.showInformationMessage(
        `VSCL：启动「${instance.id}」的功能开发中（将需要 Java ${instance.javaMajor ?? "（按版本 JSON）"}）。`
      );
    }),

    vscode.commands.registerCommand("vscl.selectInstance", async () => {
      const { instances } = store.state;
      if (instances.length === 0) {
        void vscode.window.showWarningMessage("VSCL：当前游戏目录下没有实例。");
        return;
      }
      const picked = await vscode.window.showQuickPick(
        instances.map((i) => ({
          label: i.id,
          iconPath: instanceIconPath(context, i.icon),
          description: [
            i.id === store.state.selectedInstanceId ? "当前" : "",
            i.components.length ? i.components.join(" + ") : "原版",
            i.javaMajor ? `Java ${i.javaMajor}` : "",
            i.hasOverride ? "已自定义" : "",
          ]
            .filter(Boolean)
            .join(" · "),
          detail: i.dir,
          instanceId: i.id,
        })),
        { placeHolder: "选择实例", matchOnDescription: true, matchOnDetail: true }
      );
      if (picked) {
        store.update({ selectedInstanceId: picked.instanceId });
      }
    }),

    vscode.commands.registerCommand("vscl.addGameDirectory", async () => {
      const uris = await vscode.window.showOpenDialog({
        canSelectFolders: true,
        canSelectFiles: false,
        canSelectMany: false,
        openLabel: "添加为游戏目录",
      });
      const dir = uris?.[0]?.fsPath;
      if (!dir) {
        return;
      }
      await Settings.addGameDirectory(dir);
      await Settings.setActiveGameDirectory(dir);
      await refresh();
      void vscode.window.showInformationMessage(`VSCL：已切换到游戏目录 ${dir}`);
    }),

    vscode.commands.registerCommand("vscl.detectJava", async () => {
      const javas = detectJava(Settings.javaPath() || undefined);
      latestJava = javas[0];
      sidebar.postState(latestJava);
      if (javas.length === 0) {
        const choice = await vscode.window.showInformationMessage(
          "VSCL：未检测到 Java。游戏需要对应版本的 Java（≤1.16.5→8，1.18+→17，1.20.5+→21，26.x→25）。",
          "前往 java.com 下载",
          "前往 Adoptium 下载"
        );
        if (choice === "前往 java.com 下载") {
          const { openLink } = await import("./core/util/link");
          await openLink("https://www.java.com/zh-CN/download/");
        } else if (choice === "前往 Adoptium 下载") {
          const { openLink } = await import("./core/util/link");
          await openLink("https://adoptium.net/");
        }
        return;
      }
      const picked = await vscode.window.showQuickPick(
        javas.map((j) => ({
          label: `Java ${j.major}  ${j.version}`,
          description: [j.vendor || "未知发行方", j.source].join(" · "),
          detail: j.exePath,
        })),
        {
          placeHolder: `检测到 ${javas.length} 个 Java 运行时`,
          matchOnDescription: true,
          matchOnDetail: true,
        }
      );
      if (picked?.detail) {
        await vscode.env.clipboard.writeText(picked.detail);
        void vscode.window.showInformationMessage("VSCL：已复制该 Java 路径到剪贴板。");
      }
    }),

    // 页面入口占位（实例列表 / 下载中心 / 多人联机 webview 在后续里程碑实现）
    vscode.commands.registerCommand("vscl.openPage.instances", () =>
      vscode.window.showInformationMessage("VSCL：实例列表页面开发中。")
    ),
    vscode.commands.registerCommand("vscl.openPage.download", () =>
      vscode.window.showInformationMessage("VSCL：下载中心开发中（将支持 Modrinth 搜索与游戏版本安装）。")
    ),
    vscode.commands.registerCommand("vscl.openPage.multiplayer", () =>
      vscode.window.showInformationMessage("VSCL：多人联机开发中。")
    )
  );

  // 首次激活：解析目录与实例
  await refresh();

  // 监听设置变化：游戏目录注册表/激活目录变更后自动刷新
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("vscl.gameDirectories") || e.affectsConfiguration("vscl.activeGameDirectory")) {
        void refresh();
      }
    })
  );
}

/** 停用钩子（当前无资源需要释放） */
export function deactivate(): void {
  /* noop */
}
