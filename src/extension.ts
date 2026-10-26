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
import { ConfigStore, VsclSettings } from "./core/configStore";
import { Store } from "./core/state/store";
import { resolveActiveDirectory, officialGameDirectory, isSameDirectory } from "./core/game/gameDirectory";
import { scanInstances } from "./core/game/instance";
import { effectiveSettings, loadOverrides, setOverride, resetOverride, OverrideKey } from "./core/game/instanceConfig";
import { probeInstanceIcon, readIconDataUri } from "./core/game/instanceIcon";
import { detectJava, JavaInstall } from "./core/java/javaDetector";
import { javaSatisfies } from "./core/java/javaVersion";
import { offlineIdentity } from "./core/auth/offline";
import { AccountStore, AccountEntry, DEFAULT_USERNAME } from "./core/auth/accounts";
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
import { SettingsPanel, SettingsPanelState } from "./ui/settingsPanel";
import { AccountPanel, AccountPanelState, AddAccountPanel } from "./ui/accountPanel";
import { SidebarProvider } from "./ui/sidebar";
import { listMods, setModEnabled, deleteMod, modsDirOf } from "./core/mod/modManager";
import { fetchLoaderVersions, installFabricLike, FabricLike } from "./core/modloader/fabricFamily";
import { fetchForgeFamilyVersions, installForgeFamily, ForgeFamily } from "./core/modloader/forgeInstaller";
import { fetchOptiFineVersions, installOptiFine } from "./core/modloader/optiFine";
import { spawnSync } from "child_process";

const SELECTED_INSTANCE_KEY = "vscl.selectedInstance";

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
  // 自管配置存储（globalStorage/settings.json；原生设置仅保留 useIntegratedBrowser / microsoftClientId）
  const configStore = new ConfigStore(path.join(context.globalStorageUri.fsPath, "settings.json"));
  Settings.bind(configStore);

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

    // 空实例引导（仅一次）：多半是游戏目录未注册
    if (
      instances.length === 0 &&
      !context.globalState.get<boolean>("vscl.noInstanceHinted")
    ) {
      await context.globalState.update("vscl.noInstanceHinted", true);
      const choice = await vscode.window.showInformationMessage(
        "VSCL：当前游戏目录没有任何实例。若你的游戏在其他目录，请添加游戏目录。",
        "添加游戏目录"
      );
      if (choice === "添加游戏目录") {
        await addDirectoryDialog();
      }
    }
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

    // —— Java 选择：实例覆盖 > 全局设置 > 按版本需求自动匹配（缓存） ——
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
      // Java 版本为推荐值而非强制：优先满足版本需求；无满足项时降级用最高版本启动并警告
      const javas = javasCache.length > 0 ? javasCache : detectJava();
      const required = instance.javaMajor;
      const matched = javas.find((j) => javaSatisfies(j.major, required));
      const cand = matched ?? javas[0];
      if (cand) {
        javaExe = cand.exePath === "java" ? "java" : cand.exePath;
        javaSource = cand.vendor || cand.source;
        if (!matched && required) {
          void vscode.window.showWarningMessage(
            `VSCL：本机没有满足「${instance.id}」推荐的 Java ${required}，将使用 Java ${cand.major} 启动（可能无法正常运行游戏）。`
          );
        }
      }
    }
      // 裸命令名（PATH 查找）不算文件路径，无需 existsSync 校验
      const isBare = javaExe === "java" || javaExe === "java.exe";
      if (!javaExe || (!isBare && !fs.existsSync(javaExe))) {
      const javasNow = javasCache.length > 0 ? javasCache : detectJava();
      const choice = await vscode.window.showErrorMessage(
        `VSCL：未找到可用的 Java 运行时（诊断：manual=${manual ?? "空"}，缓存=${javasCache.length}，现场检测=${javasNow.length}）。`,
        "打开 Java 管理",
        "前往 java.com 下载"
      );
      if (choice === "打开 Java 管理") {
        void vscode.commands.executeCommand("vscl.openLauncherSettings");
      } else if (choice === "前往 java.com 下载") {
        const { openLink } = await import("./core/util/link");
        await openLink("https://www.java.com/zh-CN/download/");
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
        autoMemory: eff.autoMemory,
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
      // 面板随选中实例/运行状态/设置变更刷新
      InstancePanel.current?.refresh();
      InstancePanel.current?.updateTitle(s.selectedInstanceId);
      SettingsPanel.current?.refresh();
    })
  );

  /** 账户库（globalStorage 元数据 + SecretStorage 令牌 + workspaceState 选中） */
  const accountStore = new AccountStore(context);

  /** 刷新账户列表到 Store（无选中时回落列表首项） */
  async function refreshAccounts(): Promise<void> {
    const accounts = accountStore.load();
    const persisted = accountStore.getSelectedId();
    const selectedAccountId = accounts.some((a) => a.id === persisted) ? persisted : accounts[0]?.id;
    store.update({ accounts, selectedAccountId });
  }

  /** 选中账户（持久化 + 广播） */
  async function selectAccount(id: string): Promise<void> {
    await accountStore.setSelectedId(id);
    store.update({ selectedAccountId: id });
  }

  /** 添加离线账户并选中（刷新列表状态） */
  async function addOfflineAccount(username: string): Promise<void> {
    const entry = accountStore.add(AccountStore.offlineEntry(username));
    await selectAccount(entry.id);
    await refreshAccounts();
  }

  /** 添加微软账户（设备码流程）并选中 */
  async function addMicrosoftAccount(): Promise<void> {
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
        const cred = await loginWithMicrosoft(clientId, (p) => {
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
        const entry = accountStore.add({ type: "microsoft", username: cred.username, uuid: cred.uuid });
        await accountStore.saveMsCredential(entry.id, cred);
        await selectAccount(entry.id);
        await refreshAccounts();
      });
      void vscode.window.showInformationMessage(`VSCL：已添加微软账户 ${store.selectedAccount?.username ?? ""}，启动将使用正版验证。`);
    } catch (e) {
      void vscode.window.showErrorMessage(`VSCL：登录失败——${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** 解析启动身份：选中账户驱动；无账户默认以 Dev 离线启动 */
  async function resolveIdentity(): Promise<{ username: string; uuid: string; accessToken: string; userType: string }> {
    const entry = store.selectedAccount;
    if (entry?.type === "microsoft") {
      const clientId = Settings.microsoftClientId();
      const cred = clientId ? await accountStore.loadMsCredential(entry.id) : undefined;
      if (cred) {
        try {
          let valid: MsCredential = cred;
          if (cred.expiresAt < Date.now() + 60_000) {
            const refreshed = await refreshMicrosoft(clientId, cred.refreshToken);
            if (!refreshed) {
              throw new Error("令牌刷新被拒绝");
            }
            valid = { ...cred, accessToken: refreshed.accessToken, refreshToken: refreshed.refreshToken, expiresAt: Date.now() + 24 * 3600 * 1000 };
            await accountStore.saveMsCredential(entry.id, valid);
          }
          return { username: entry.username, uuid: entry.uuid, accessToken: valid.accessToken, userType: "msa" };
        } catch (e) {
          void vscode.window.showWarningMessage(
            `VSCL：微软令牌刷新失败（${e instanceof Error ? e.message : String(e)}），回落离线启动 ${entry.username}。`
          );
        }
      } else if (!clientId) {
        void vscode.window.showWarningMessage("VSCL：微软账户需要配置 Client ID，回落离线启动。");
      }
      return offlineIdentity(entry.username);
    }
    if (entry?.type === "offline") {
      return offlineIdentity(entry.username);
    }
    return offlineIdentity(DEFAULT_USERNAME); // 无账户：Dev
  }

  /** 打开「添加账户」标签 */
  function openAddAccountPanel(): void {
    AddAccountPanel.createOrShow(context, {
      getClientIdConfigured: () => !!Settings.microsoftClientId(),
      addOffline: (username) => addOfflineAccount(username),
      addMicrosoft: () => addMicrosoftAccount(),
      openNativeSetting: async (query) => {
        await vscode.commands.executeCommand("workbench.action.openSettings", query);
      },
      openList: () => openAccountPanel(),
    });
  }

  /** 打开账户列表页（单选） */
  function openAccountPanel(): void {
    AccountPanel.createOrShow(context, {
      getState: (): AccountPanelState => ({
        accounts: store.state.accounts.map((a) => ({ id: a.id, type: a.type, username: a.username, uuid: a.uuid })),
        selectedId: store.state.selectedAccountId,
        clientIdConfigured: !!Settings.microsoftClientId(),
      }),
      select: (id) => selectAccount(id),
      remove: async (id) => {
        const target: AccountEntry | undefined = store.state.accounts.find((a) => a.id === id);
        const choice = await vscode.window.showWarningMessage(
          `删除账户「${target?.username ?? id}」？${target?.type === "microsoft" ? "（其登录令牌一并清除）" : ""}`,
          { modal: true },
          "删除"
        );
        if (choice !== "删除") {
          return;
        }
        await accountStore.remove(id);
        await refreshAccounts();
      },
      openAdd: () => openAddAccountPanel(),
    });
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
        downloadSource: Settings.downloadSource(),
        downloadThreads: Settings.downloadThreads(),
        showLogs: Settings.showLogs(),
        javas: (javasCache.length > 0 ? javasCache : detectJava()).map((j) => ({
          exePath: j.exePath,
          major: j.major,
          vendor: j.vendor,
          source: j.source,
        })),
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
    });
  }

  /** 已检测 Java 缓存（设置页列表 / 安装选择共用） */
  let javasCache: JavaInstall[] = [];

  /** 重新扫描 Java */
  function scanJavas(): JavaInstall[] {
    javasCache = detectJava(Settings.javaPath() || undefined);
    return javasCache;
  }
  scanJavas(); // 激活同步段立即预热（命令注册前完成，杜绝启动时缓存为空的时序窗口）

  /** 为安装/启动解析可用 Java（手动设置 > 版本匹配） */
  function resolveJavaFor(required?: number): string | undefined {
    const manual = Settings.javaPath() || undefined;
    if (manual) {
      return manual;
    }
    return (javasCache.length > 0 ? javasCache : detectJava()).find((j) => javaSatisfies(j.major, required))?.exePath;
  }

  /** 添加游戏目录（对话框 → 注册并激活 → 刷新） */
  async function addDirectoryDialog(): Promise<void> {
    const uris = await vscode.window.showOpenDialog({
      canSelectFolders: true,
      canSelectFiles: false,
      canSelectMany: false,
      openLabel: "添加为游戏目录",
    });
    const dir = uris?.[0]?.fsPath;
    if (dir) {
      Settings.addGameDirectory(dir);
      Settings.setActiveGameDirectory(dir);
      await refresh();
    }
  }

  /** 启动器设置页状态快照（Java/目录/内存/下载） */
  function settingsPanelState(): SettingsPanelState {
    const g = Settings.globalGameSettings();
    const javas = javasCache.length > 0 ? javasCache : detectJava();
    return {
      directory: {
        active: store.state.activeDirectory,
        source: store.state.activeSource,
        registered: Settings.gameDirectories(),
        official: officialGameDirectory(),
      },
      javas: javas.map((j) => ({ exePath: j.exePath, major: j.major, version: j.version, vendor: j.vendor, source: j.source })),
      javaDefault: Settings.javaPath(),
      memory: { autoMemory: g.autoMemory, minMemory: g.minMemory, maxMemory: g.maxMemory },
      jvmArgs: g.jvmArgs,
      javaPath: Settings.javaPath(),
      downloadSource: Settings.downloadSource(),
      downloadThreads: Settings.downloadThreads(),
      showLogs: Settings.showLogs(),
      extensionVersion: String(context.extension.packageJSON.version ?? "0.0.0"),
    };
  }

  /** 打开启动器设置页（自建页面；仅内置浏览器/微软 Client ID 留在原生设置） */
  function openLauncherSettings(): void {
    SettingsPanel.createOrShow(context, {
      getState: settingsPanelState,
      setGlobal: async (k, v) => {
        // 自管存储字段直接落盘（key 与 VsclSettings 字段同名）
        configStore.update(k as keyof VsclSettings, v as never);
      },
      setMemory: async (mode, value) => {
        if (mode === "auto") {
          configStore.update("autoMemory", true);
          configStore.update("minMemory", value);
        } else {
          configStore.update("autoMemory", false);
          configStore.update("maxMemory", value);
        }
      },
      addDirectory: () => addDirectoryDialog(),
      activateDirectory: async (p) => {
        await Settings.setActiveGameDirectory(p);
        await refresh();
      },
      removeDirectory: async (p) => {
        await Settings.removeGameDirectory(p);
        if (store.state.activeDirectory && isSameDirectory(store.state.activeDirectory, p)) {
          await Settings.setActiveGameDirectory("");
        }
        await refresh();
      },
      resetAutoDirectory: async () => {
        await Settings.setActiveGameDirectory("");
        await refresh();
      },
      rescanJava: () => {
        scanJavas();
      },
      setJavaDefault: async (exePath) => {
        Settings.setJavaPath(exePath);
        scanJavas();
      },
      clearJavaDefault: async () => {
        Settings.setJavaPath("");
        scanJavas();
      },
      openJavaDownload: async (kind) => {
        const { openLink } = await import("./core/util/link");
        await openLink(kind === "bellsoft" ? "https://bell-sw.com/pages/downloads/" : "https://www.java.com/zh-CN/download/");
      },
      openNativeSetting: async (query) => {
        await vscode.commands.executeCommand("workbench.action.openSettings", query);
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
        { label: "Fabric", description: "轻量加载器", loader: "fabric" as const },
        { label: "Quilt", description: "Fabric 社区分支", loader: "quilt" as const },
        { label: "Forge", description: "经典加载器（需要 Java 执行后处理）", loader: "forge" as const },
        { label: "NeoForge", description: "Forge 社区分支（需要 Java 执行后处理）", loader: "neoforge" as const },
        { label: "OptiFine", description: "画质优化（BMCLAPI 下载；新版需 Java 补丁）", loader: "optifine" as const },
      ],
      { placeHolder: "选择加载器" }
    );
    if (!kindPick) {
      return;
    }
    const source = Settings.downloadSource();
    try {
      // 版本列表
      let versions: { version: string; stable: boolean; optiFine?: Parameters<typeof installOptiFine>[0]["version"] }[];
      if (kindPick.loader === "forge" || kindPick.loader === "neoforge") {
        const all = await fetchForgeFamilyVersions(kindPick.loader, source);
        versions = kindPick.loader === "forge" ? all.filter((v) => v.version.startsWith(`${instance.id}-`)) : all;
        if (versions.length === 0 && kindPick.loader === "forge") {
          void vscode.window.showWarningMessage(`VSCL：Forge 未提供「${instance.id}」的版本，请选择更早/更晚的基础实例。`);
          return;
        }
      } else if (kindPick.loader === "optifine") {
        const all = await fetchOptiFineVersions();
        versions = all
          .filter((v) => v.mcversion === instance.id || instance.id.startsWith(`${v.mcversion}-`))
          .map((v) => ({ version: v.id, stable: true, optiFine: v }));
        if (versions.length === 0) {
          void vscode.window.showWarningMessage(`VSCL：OptiFine 未提供「${instance.id}」对应版本。`);
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
          optiFine: v.optiFine,
        })),
        { placeHolder: `选择 ${kindPick.label} 版本`, matchOnDescription: true }
      );
      if (!pick) {
        return;
      }
      // Forge/NeoForge 后处理与 OptiFine Patcher 需要 Java（尽力解析）
      let javaExe = "java";
      if (kindPick.loader !== "fabric" && kindPick.loader !== "quilt") {
        const cand = resolveJavaFor(instance.javaMajor);
        if (!cand) {
          void vscode.window.showErrorMessage("VSCL：该安装需要本机 Java，请先在启动器设置中配置。");
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
          if (kindPick.loader === "optifine" && pick.optiFine) {
            return installOptiFine({
              gameDir,
              baseInstanceId: instance.id,
              version: pick.optiFine,
              javaExe,
              threads: Settings.downloadThreads(),
              onProgress: (m) => progress.report({ message: m }),
            });
          }
          return installForgeFamily({
            kind: kindPick.loader === "forge" ? "forge" : "neoforge",
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
    vscode.commands.registerCommand("vscl.openLauncherSettings", () => openLauncherSettings()),
    vscode.commands.registerCommand("vscl.openAccountPanel", () => openAccountPanel()),
    vscode.commands.registerCommand("vscl.openAddAccountPanel", () => openAddAccountPanel()),
    vscode.commands.registerCommand("vscl.installModpack", () => void installModpackCommand())
  );

  // 首次激活：解析目录与实例、加载账户列表、预热 Java 缓存
  await refresh();
  await refreshAccounts();
  scanJavas();

  // 自管设置变更：目录相关 → 重扫实例；设置页 → 刷新
  context.subscriptions.push(
    Settings.onDidChange(() => {
      SettingsPanel.current?.refresh();
      void refresh();
    })
  );
}

/** 停用钩子（当前无资源需要释放） */
export function deactivate(): void {
  /* noop */
}
