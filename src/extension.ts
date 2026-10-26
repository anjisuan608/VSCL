// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 VSCL contributors
/**
 * VSCL 扩展入口。
 * 职责：装配 Store / 侧栏 / 命令；游戏目录解析与实例扫描的调度；
 * 状态持久化（workspaceState，多窗口隔离）。
 */
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { Settings } from "./config/settings";
import { Store } from "./core/state/store";
import { resolveActiveDirectory } from "./core/game/gameDirectory";
import { scanInstances } from "./core/game/instance";
import { effectiveSettings, loadOverrides, setOverride, resetOverride, OverrideKey } from "./core/game/instanceConfig";
import { probeInstanceIcon, readIconDataUri } from "./core/game/instanceIcon";
import { detectJava, JavaInstall } from "./core/java/javaDetector";
import { javaSatisfies } from "./core/java/javaVersion";
import { offlineIdentity } from "./core/auth/offline";
import { loginWithMicrosoft, refreshMicrosoft, MsCredential } from "./core/auth/microsoft";
import { mergeVersion } from "./core/launch/versionMerge";
import { buildLaunchCommand } from "./core/launch/launcher";
import { spawnGame, GameProcess } from "./core/launch/process";
import { VersionManifestSource } from "./core/download/versionManifest";
import { installVersion, downloadVersionChain } from "./core/download/gameInstaller";
import { installMrpack, readMrpackIndex } from "./core/modpack/mrpack";
import { GameTerminal } from "./ui/gameTerminal";
import { DownloadCenterPanel } from "./ui/downloadCenter";
import { InstancePanel, InstancePanelState, FolderKind } from "./ui/instancePanel";
import { SidebarProvider } from "./ui/sidebar";
import { listMods, setModEnabled, deleteMod, modsDirOf } from "./core/mod/modManager";
import { fetchLoaderVersions, installFabricLike, FabricLike } from "./core/modloader/fabricFamily";
import { fetchForgeFamilyVersions, installForgeFamily, ForgeFamily } from "./core/modloader/forgeInstaller";
import { spawnSync } from "child_process";

const SELECTED_INSTANCE_KEY = "vscl.selectedInstance";
const MS_CREDENTIAL_KEY = "vscl.msCredential";

/** 运行中的实例（进程 + 终端句柄） */
const running = new Map<string, { proc: GameProcess; term: GameTerminal }>();

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

  /** 启动选中实例：Java 匹配 → 版本合并 → 命令构建 → 日志终端 + spawn */
  async function launchSelected(): Promise<void> {
    const instance = store.selectedInstance;
    if (!instance) {
      void vscode.window.showWarningMessage("VSCL：未选择可启动的实例。");
      return;
    }
    if (running.has(instance.id)) {
      void vscode.window.showInformationMessage(`VSCL：「${instance.id}」已在运行。`);
      return;
    }
    const gameDir = store.state.activeDirectory;
    if (!gameDir) {
      void vscode.window.showWarningMessage("VSCL：未解析到游戏目录。");
      return;
    }

    // —— 生效配置（全局 ⊕ 实例覆盖） ——
    const overrides = loadOverrides(instance.dir);
    const eff = effectiveSettings(Settings.globalGameSettings(), overrides);

    // —— Java 选择：实例覆盖 > 全局设置 > 按版本需求自动匹配 ——
    let javaExe: string | undefined;
    let javaSource = "";
    const manual = overrides.javaPath || Settings.javaPath() || undefined;
    if (manual) {
      javaExe =
        fs.existsSync(manual) && fs.statSync(manual).isDirectory()
          ? path.join(manual, "bin", process.platform === "win32" ? "java.exe" : "java")
          : manual;
      javaSource = "手动指定";
    } else {
      const cand = detectJava().find((j) => javaSatisfies(j.major, instance.javaMajor));
      if (cand) {
        javaExe = cand.exePath === "java" ? "java" : cand.exePath;
        javaSource = cand.vendor || cand.source;
      }
    }
    if (!javaExe || (javaExe !== "java" && !fs.existsSync(javaExe))) {
      const required = instance.javaMajor ? `Java ${instance.javaMajor}` : "匹配的 Java";
      const choice = await vscode.window.showErrorMessage(
        `VSCL：未找到满足「${instance.id}」的运行时（${required}）。`,
        "检测/获取 Java"
      );
      if (choice) {
        void vscode.commands.executeCommand("vscl.detectJava");
      }
      return;
    }

    // —— 版本合并与命令构建 ——
    const merged = mergeVersion(gameDir, instance.id);
    if (!merged) {
      void vscode.window.showErrorMessage(`VSCL：无法读取版本 JSON（versions/${instance.id}）。`);
      return;
    }
    const identity = await resolveIdentity();
    let built: ReturnType<typeof buildLaunchCommand>;
    try {
      built = buildLaunchCommand({
        merged,
        gameDir,
        instanceDir: instance.dir,
        javaExe,
        identity,
        minMemory: eff.minMemory,
        maxMemory: eff.maxMemory,
        extraJvmArgs: eff.jvmArgs,
        quickPlay: eff.quickPlay,
        windowType: eff.windowType,
        width: eff.width,
        height: eff.height,
        processPriority: eff.processPriority,
        environmentVariables: eff.environmentVariables,
        enableDebugLogOutput: eff.enableDebugLogOutput,
      });
    } catch (e) {
      void vscode.window.showErrorMessage(`VSCL：构建启动命令失败——${e instanceof Error ? e.message : String(e)}`);
      return;
    }

    // —— 日志终端 + 进程 ——
    const term = new GameTerminal(`MC ${instance.id}`);
    let terminal: vscode.Terminal | undefined;
    if (overrides.showLogs ?? Settings.showLogs()) {
      terminal = vscode.window.createTerminal({ name: `Minecraft ${instance.id}`, pty: term });
      terminal.show(true);
    }
    // 启动前命令（失败仅警告，不阻断启动）
    if (eff.preLaunchCommand?.trim()) {
      term.info(`[VSCL] 执行启动前命令：${eff.preLaunchCommand.trim()}`);
      const r = runShell(eff.preLaunchCommand.trim());
      if (r.code !== 0) {
        term.warning(`[VSCL] 启动前命令退出码 ${r.code}`);
      }
    }
    for (const w of built.warnings) {
      term.warning(`[VSCL] ${w}`);
    }
    term.info(`[VSCL] 启动 ${instance.id}（Java ${instance.javaMajor ?? "?"} · ${javaSource}）`);

    const proc = spawnGame(built.command, built.args, instance.dir, (line) => term.onGameLine(line), {
      env: built.env,
      nice: built.niceValue,
    });
    proc.onExit((code, signal) => {
      term.info(`[VSCL] 游戏退出（code=${code ?? "null"}${signal ? ` signal=${signal}` : ""}）`);
      running.delete(instance.id);
      store.update({ runningInstanceIds: store.state.runningInstanceIds.filter((id) => id !== instance.id) });
      void terminal?.dispose(); // 日志随终端销毁；游戏自身 logs/ 目录保留完整日志
      // 退出后命令
      if (eff.postExitCommand?.trim()) {
        runShell(eff.postExitCommand.trim());
      }
    });
    term.onUserInput = (data) => proc.write(data);
    proc.child.once("error", (err) => {
      term.error(`[VSCL] 启动失败：${err.message}`);
    });
    running.set(instance.id, { proc, term });
    store.update({ runningInstanceIds: [...store.state.runningInstanceIds, instance.id] });
  }

  // 状态持久化 + 侧栏推送（Store 广播已由 SidebarProvider 订阅）
  context.subscriptions.push(
    store.event((s) => {
      if (s.selectedInstanceId) {
        void context.workspaceState.update(SELECTED_INSTANCE_KEY, s.selectedInstanceId);
      }
      // 实例设置面板随选中实例/运行状态刷新
      InstancePanel.current?.refresh();
      InstancePanel.current?.updateTitle(s.selectedInstanceId);
    })
  );

  /** 载入微软凭据（SecretStorage） */
  async function loadCredential(): Promise<MsCredential | undefined> {
    const raw = await context.secrets.get(MS_CREDENTIAL_KEY);
    if (!raw) {
      return undefined;
    }
    try {
      return JSON.parse(raw) as MsCredential;
    } catch {
      return undefined;
    }
  }

  /** 保存/清除微软凭据并同步状态 */
  async function saveCredential(cred: MsCredential | undefined): Promise<void> {
    if (cred) {
      await context.secrets.store(MS_CREDENTIAL_KEY, JSON.stringify(cred));
    } else {
      await context.secrets.delete(MS_CREDENTIAL_KEY);
    }
    store.update({ accountName: cred?.username });
  }

  /** 解析启动身份：微软账户优先（过期自动刷新），失败/未登录回落离线 */
  async function resolveIdentity(): Promise<{ username: string; uuid: string; accessToken: string; userType: string }> {
    const clientId = Settings.microsoftClientId();
    if (clientId) {
      const cred = await loadCredential();
      if (cred) {
        try {
          let valid = cred;
          if (cred.expiresAt < Date.now() + 60_000) {
            const refreshed = await refreshMicrosoft(clientId, cred.refreshToken);
            if (!refreshed) {
              throw new Error("令牌刷新被拒绝");
            }
            valid = { ...cred, accessToken: refreshed.accessToken, refreshToken: refreshed.refreshToken, expiresAt: Date.now() + 24 * 3600 * 1000 };
            await saveCredential(valid);
          }
          return { username: valid.username, uuid: valid.uuid, accessToken: valid.accessToken, userType: "msa" };
        } catch (e) {
          void vscode.window.showWarningMessage(
            `VSCL：微软令牌刷新失败（${e instanceof Error ? e.message : String(e)}），回落离线启动。`
          );
        }
      }
    }
    return offlineIdentity(Settings.offlineUsername());
  }

  /** 账户管理：登录/退出（设备码流程） */
  async function accountManage(): Promise<void> {
    const cred = await loadCredential();
    const items = cred
      ? [
          { label: `$(account) ${cred.username}`, description: "微软账户（正版验证）", action: "" },
          { label: "$(refresh) 重新登录", action: "login" },
          { label: "$(sign-out) 退出登录", action: "logout" },
        ]
      : [{ label: "$(sign-in) 登录微软账户", description: "需要配置 vscl.microsoftClientId", action: "login" }];
    const pick = await vscode.window.showQuickPick(items, { placeHolder: "账户管理" });
    if (!pick || !pick.action) {
      return;
    }
    if (pick.action === "logout") {
      await saveCredential(undefined);
      void vscode.window.showInformationMessage("VSCL：已退出登录，启动将使用离线身份。");
      return;
    }
    const clientId = Settings.microsoftClientId();
    if (!clientId) {
      const choice = await vscode.window.showInformationMessage(
        "VSCL：需要先在 Azure 门户注册应用并配置客户端 ID。",
        "打开设置"
      );
      if (choice) {
        void vscode.commands.executeCommand("workbench.action.openSettings", "vscl.microsoftClientId");
      }
      return;
    }
    try {
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "VSCL：微软登录进行中…", cancellable: false }, async () => {
        const newCred = await loginWithMicrosoft(clientId, (p) => {
          void (async () => {
            const choice = await vscode.window.showInformationMessage(
              `VSCL：请在浏览器输入代码：${p.userCode}`,
              "打开验证页面",
              "复制代码"
            );
            if (choice === "打开验证页面") {
              const { openLink } = await import("./core/util/link");
              await openLink(p.verificationUri, "auth");
            } else if (choice === "复制代码") {
              await vscode.env.clipboard.writeText(p.userCode);
            }
          })();
        });
        await saveCredential(newCred);
      });
      void vscode.window.showInformationMessage(`VSCL：已登录 ${store.state.accountName ?? ""}，启动将使用正版验证。`);
    } catch (e) {
      void vscode.window.showErrorMessage(`VSCL：登录失败——${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** 安装 mrpack 整合包（选择文件 → 确认 → 安装） */
  async function installModpackCommand(): Promise<void> {
    const gameDir = store.state.activeDirectory;
    if (!gameDir) {
      void vscode.window.showWarningMessage("VSCL：未解析到游戏目录。");
      return;
    }
    const uris = await vscode.window.showOpenDialog({
      filters: { "Modrinth 整合包": ["mrpack"] },
      canSelectMany: false,
      openLabel: "安装整合包",
    });
    const file = uris?.[0]?.fsPath;
    if (!file) {
      return;
    }
    try {
      const { index } = readMrpackIndex(file);
      const loaderTag = index.dependencies["fabric-loader"]
        ? " · Fabric"
        : index.dependencies["quilt-loader"]
          ? " · Quilt"
          : "";
      const confirm = await vscode.window.showQuickPick(
        [
          {
            label: index.name ?? "整合包",
            description: index.versionId ?? "",
            detail: `${index.files.length} 个文件 · Minecraft ${index.dependencies["minecraft"] ?? "?"}${loaderTag}`,
          },
        ],
        { placeHolder: "确认安装此整合包？" }
      );
      if (!confirm) {
        return;
      }
      const id = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `VSCL：安装 ${index.name ?? "整合包"}`, cancellable: false },
        async (progress) =>
          installMrpack({
            mrpackPath: file,
            gameDir,
            threads: Settings.downloadThreads(),
            source: Settings.downloadSource(),
            onProgress: (m) => progress.report({ message: m }),
          })
      );
      await refresh();
      store.update({ selectedInstanceId: id });
      void vscode.window.showInformationMessage(`VSCL：整合包「${id}」安装完成，已选中可直接启动。`);
    } catch (e) {
      void vscode.window.showErrorMessage(`VSCL：整合包安装失败——${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** 安装游戏版本（下载中心回调）：JSON 链 → 客户端/资源/库并发下载 */
  async function installGameVersion(versionId: string): Promise<void> {
    const gameDir = store.state.activeDirectory;
    if (!gameDir) {
      throw new Error("未解析到游戏目录");
    }
    const source = Settings.downloadSource();
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `VSCL：安装 ${versionId}`, cancellable: false },
      async (progress) => {
        const manifest = await manifestSource.fetch();
        progress.report({ message: "版本文件…" });
        await downloadVersionChain(
          gameDir,
          versionId,
          (id) => {
            const v = manifest.versions.find((x) => x.id === id);
            return v ? { url: v.url, sha1: v.sha1 } : undefined;
          },
          source
        );
        await installVersion({
          gameDir,
          versionId,
          source,
          threads: Settings.downloadThreads(),
          onProgress: (p) => progress.report({ message: `${p.phase} ${p.done}/${p.total}` }),
        });
      }
    );
    await refresh();
    void vscode.window.showInformationMessage(`VSCL：${versionId} 安装完成，可从侧栏选择启动。`);
  }

  /** 版本清单数据源（globalStorage 缓存 + 内存 TTL） */
  const manifestSource = new VersionManifestSource(
    context.globalStorageUri.fsPath,
    () => Settings.downloadSource()
  );

  // 主侧栏
  const sidebar = new SidebarProvider(context, store);
  sidebar.register(context);

  /** 列目录条目（资源包/世界等；含目录与 zip 文件） */
  function listDirEntries(dir: string): { name: string; size: number; mtime: number }[] {
    try {
      return fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((d) => d.isDirectory() || /\.zip$/i.test(d.name))
        .map((d) => {
          const s = fs.statSync(path.join(dir, d.name));
          return { name: d.name.replace(/\.zip$/i, ""), size: s.size, mtime: s.mtimeMs };
        });
    } catch {
      return [];
    }
  }

  /** 实例设置面板状态快照（游戏设置 + Mod / 资源包 / 世界列表） */
  function instancePanelState(): InstancePanelState {
    const instance = store.selectedInstance;
    const global = Settings.globalGameSettings();
    const overrides = instance ? (loadOverrides(instance.dir) as Record<string, unknown>) : {};
    let iconUri: string | undefined;
    if (instance?.iconPath) {
      const icon = probeInstanceIcon(instance.dir);
      if (icon) {
        iconUri = readIconDataUri(icon) || undefined;
      }
    }
    const mods = instance
      ? listMods(instance.dir).map((m) => ({
          fileName: m.fileName,
          path: m.path,
          name: m.meta.name,
          version: m.meta.version,
          authors: m.meta.authors,
          loader: m.meta.loader,
          enabled: m.enabled,
          size: m.size,
        }))
      : [];
    return {
      instance: instance
        ? {
            id: instance.id,
            dir: instance.dir,
            javaMajor: instance.javaMajor,
            components: instance.components,
            iconUri,
            running: store.state.runningInstanceIds.includes(instance.id),
          }
        : undefined,
      global: {
        minMemory: global.minMemory,
        maxMemory: global.maxMemory,
        jvmArgs: global.jvmArgs,
        javaPath: Settings.javaPath(),
        offlineUsername: Settings.offlineUsername(),
        downloadSource: Settings.downloadSource(),
        downloadThreads: Settings.downloadThreads(),
        showLogs: Settings.showLogs(),
        useIntegratedBrowser: Settings.useIntegratedBrowser(),
      },
      overrides,
      mods,
      resourcepacks: instance ? listDirEntries(path.join(instance.dir, "resourcepacks")) : [],
      worlds: instance ? listDirEntries(path.join(instance.dir, "saves")) : [],
    };
  }

  /** 按文件路径定位 Mod（面板操作） */
  function findModByPath(filePath: string) {
    const instance = store.selectedInstance;
    return instance ? listMods(instance.dir).find((m) => m.path === filePath) : undefined;
  }

  /** 全局设置字段 → vscl.* 配置项映射 */
  const GLOBAL_SETTING_KEYS: Record<string, string> = {
    minMemory: "game.minMemory",
    maxMemory: "game.maxMemory",
    jvmArgs: "game.jvmArgs",
    javaPath: "javaPath",
    offlineUsername: "offlineUsername",
    downloadSource: "downloadSource",
    downloadThreads: "downloadThreads",
    showLogs: "showLogs",
    useIntegratedBrowser: "useIntegratedBrowser",
  };

  /** 打开实例设置面板（命令/侧栏实例卡入口） */
  function openInstanceSettings(): void {
    InstancePanel.createOrShow(context, {
      getState: instancePanelState,
      toggleMod: async (p) => {
        const entry = findModByPath(p);
        if (entry) {
          setModEnabled(entry, !entry.enabled);
        }
      },
      deleteMod: async (p) => {
        const entry = findModByPath(p);
        if (entry) {
          const choice = await vscode.window.showWarningMessage(
            `删除 Mod「${entry.meta.name ?? entry.fileName}」？`,
            { modal: true },
            "删除"
          );
          if (choice === "删除") {
            deleteMod(entry);
          }
        }
      },
      openFolder: async (kind) => {
        const instance = store.selectedInstance;
        if (instance) {
          const dir = path.join(instance.dir, kind);
          fs.mkdirSync(dir, { recursive: true });
          await vscode.env.openExternal(vscode.Uri.file(dir));
        }
      },
      installLoader: () => installModLoader(),
      setOverride: async (k, v) => {
        const instance = store.selectedInstance;
        if (instance) {
          setOverride(instance.dir, k as OverrideKey, v as never);
        }
      },
      resetOverride: async (k) => {
        const instance = store.selectedInstance;
        if (instance) {
          resetOverride(instance.dir, k as OverrideKey);
        }
      },
      setGlobal: async (k, v) => {
        const configKey = GLOBAL_SETTING_KEYS[k];
        if (configKey) {
          await vscode.workspace.getConfiguration("vscl").update(configKey, v, vscode.ConfigurationTarget.Global);
        }
      },
    });
  }

  /** 执行系统 shell 命令（启动前/退出后钩子） */
  function runShell(command: string): { code: number | null; output: string } {
    const r =
      process.platform === "win32"
        ? spawnSync("cmd", ["/c", command], { encoding: "utf8", timeout: 120000, windowsHide: true })
        : spawnSync("/bin/sh", ["-c", command], { encoding: "utf8", timeout: 120000 });
    return { code: r.status, output: `${r.stdout ?? ""}${r.stderr ?? ""}`.slice(-2000) };
  }

  /** 安装加载器：Fabric / Quilt / Forge / NeoForge */
  async function installModLoader(): Promise<void> {
    const instance = store.selectedInstance;
    if (!instance) {
      void vscode.window.showWarningMessage("VSCL：请先选择一个基础实例（原版版本）。");
      return;
    }
    const gameDir = store.state.activeDirectory;
    if (!gameDir) {
      void vscode.window.showWarningMessage("VSCL：未解析到游戏目录。");
      return;
    }
    const kindPick = await vscode.window.showQuickPick(
      [
        { label: "Fabric", description: "轻量加载器", loader: "fabric" as FabricLike | ForgeFamily },
        { label: "Quilt", description: "Fabric 社区分支", loader: "quilt" as FabricLike | ForgeFamily },
        { label: "Forge", description: "经典加载器（需要 Java 执行后处理）", loader: "forge" as FabricLike | ForgeFamily },
        { label: "NeoForge", description: "Forge 社区分支（需要 Java 执行后处理）", loader: "neoforge" as FabricLike | ForgeFamily },
      ],
      { placeHolder: "选择加载器" }
    );
    if (!kindPick) {
      return;
    }
    const source = Settings.downloadSource();
    try {
      // 版本列表
      let versions: { version: string; stable: boolean }[];
      if (kindPick.loader === "forge" || kindPick.loader === "neoforge") {
        const all = await fetchForgeFamilyVersions(kindPick.loader, source);
        versions = kindPick.loader === "forge" ? all.filter((v) => v.version.startsWith(`${instance.id}-`)) : all;
        if (versions.length === 0 && kindPick.loader === "forge") {
          void vscode.window.showWarningMessage(`VSCL：Forge 未提供「${instance.id}」的版本，请选择更早/更晚的基础实例。`);
          return;
        }
      } else {
        versions = await fetchLoaderVersions(kindPick.loader);
      }
      const pick = await vscode.window.showQuickPick(
        versions.map((v) => ({
          label: v.version,
          description: v.stable ? "稳定版" : "开发版",
          version: v.version,
        })),
        { placeHolder: `选择 ${kindPick.label} 版本`, matchOnDescription: true }
      );
      if (!pick) {
        return;
      }
      // Forge/NeoForge 的后处理需要 Java
      let javaExe = "java";
      if (kindPick.loader === "forge" || kindPick.loader === "neoforge") {
        const manual = Settings.javaPath() || undefined;
        const cand = manual ?? detectJava().find((j) => javaSatisfies(j.major, instance.javaMajor))?.exePath;
        if (!cand) {
          void vscode.window.showErrorMessage("VSCL：安装 Forge/NeoForge 需要本机 Java，请先配置 vscl.javaPath 或安装 Java。");
          return;
        }
        javaExe = cand;
      }
      const newId = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `VSCL：安装 ${kindPick.label} ${pick.version}`, cancellable: false },
        async (progress) => {
          progress.report({ message: "准备安装…" });
          if (kindPick.loader === "fabric" || kindPick.loader === "quilt") {
            return installFabricLike({
              gameDir,
              gameVersion: instance.id,
              loaderVersion: pick.version,
              kind: kindPick.loader,
              threads: Settings.downloadThreads(),
              source,
            });
          }
          return installForgeFamily({
            kind: kindPick.loader,
            gameDir,
            gameVersion: instance.id,
            version: pick.version,
            javaExe,
            threads: Settings.downloadThreads(),
            source,
            onProgress: (m) => progress.report({ message: m }),
          });
        }
      );
      await refresh();
      store.update({ selectedInstanceId: newId });
      InstancePanel.current?.refresh();
      void vscode.window.showInformationMessage(`VSCL：已安装 ${newId}，可直接启动。`);
    } catch (e) {
      void vscode.window.showErrorMessage(`VSCL：安装失败——${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // —— 命令 ——
  context.subscriptions.push(
    vscode.commands.registerCommand("vscl.refresh", () => refresh()),

    vscode.commands.registerCommand("vscl.launch", () => void launchSelected()),

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

    // 页面入口占位（实例列表 / 多人联机 webview 在后续里程碑实现）
    vscode.commands.registerCommand("vscl.openPage.instances", () =>
      vscode.window.showInformationMessage("VSCL：实例列表页面开发中。")
    ),
    vscode.commands.registerCommand("vscl.openPage.download", () =>
      DownloadCenterPanel.createOrShow(context, {
        fetchManifest: (force) => manifestSource.fetch(force),
        getInstalledIds: () => store.state.instances.map((i) => i.id),
        install: (versionId) => installGameVersion(versionId),
      })
    ),
    vscode.commands.registerCommand("vscl.openPage.multiplayer", () =>
      vscode.window.showInformationMessage("VSCL：多人联机开发中。")
    ),
    vscode.commands.registerCommand("vscl.installModLoader", () => void installModLoader()),
    vscode.commands.registerCommand("vscl.openInstanceSettings", () => openInstanceSettings()),
    vscode.commands.registerCommand("vscl.account.manage", () => void accountManage()),
    vscode.commands.registerCommand("vscl.installModpack", () => void installModpackCommand())
  );

  // 首次激活：解析目录与实例
  await refresh();

  // 恢复已登录账户状态显示（凭据本身在 SecretStorage）
  void loadCredential().then((cred) => {
    if (cred) {
      store.update({ accountName: cred.username });
    }
  });

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
