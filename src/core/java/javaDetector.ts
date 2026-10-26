// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 VSCL contributors
/**
 * Java 运行时检测（对齐 HMCL `JavaManager` 的扫描策略，不做下载）。
 *
 * 来源优先级：用户显式设置 > JAVA_HOME/JDK_HOME > PATH > 平台标准目录。
 * 平台扫描点（HMCL 同款）：
 *   - Windows：%ProgramFiles%、%ProgramFiles(x86)% 全目录 + 官方启动器 `Minecraft Launcher\runtime`
 *   - macOS：  /Library/Java/JavaVirtualMachines、~/Library/Java/JavaVirtualMachines
 *   - Linux：  /usr/lib/jvm
 * 版本解析：优先读候选目录 `release` 文件（零进程开销）；PATH 中的 java 用 `java -version` 解析。
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawnSync } from "child_process";
import { parseJavaMajor } from "./javaVersion";

/** 一个可用的 Java 安装 */
export interface JavaInstall {
  /** Java home 目录（可执行文件的上级） */
  home: string;
  /** java 可执行文件绝对路径 */
  exePath: string;
  /** 主版本号（8 / 17 / 21 / 25 …） */
  major: number;
  /** 原始版本串（如 "21.0.2"） */
  version: string;
  /** 发行方（如 "Eclipse Adoptium"、"Oracle"），未知则空串 */
  vendor: string;
  /** 检测来源（manual / env / path / platform / ...） */
  source: string;
}

/** 单个候选目录的 release 文件解析结果 */
interface ReleaseInfo {
  version: string;
  vendor: string;
}

function javaExecutableName(): string {
  return process.platform === "win32" ? "java.exe" : "java";
}

/** 解析 JDK/JRE home 下的 release 文件（HMCL JavaInfo 同款方式，无进程开销） */
export function parseReleaseFile(javaHome: string): ReleaseInfo | undefined {
  const releasePath = path.join(javaHome, "release");
  try {
    const text = fs.readFileSync(releasePath, "utf8");
    const map = new Map<string, string>();
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^([A-Z_0-9]+)="(.*)"$/);
      if (m) {
        map.set(m[1], m[2]);
      }
    }
    const version = map.get("JAVA_VERSION");
    if (!version) {
      return undefined;
    }
    return { version: version.replace(/^"/, "").replace(/"$/, ""), vendor: map.get("IMPLEMENTOR") ?? "" };
  } catch {
    return undefined;
  }
}

/** 从 `java -version` 的 stderr 解析版本串 */
function parseVersionOutput(output: string): string | undefined {
  const m = output.match(/version\s+"([^"]+)"/);
  return m ? m[1] : undefined;
}

/** 限深目录递归，收集含 bin/java 的目录（作为 javaHome 候选） */
function findJavaHomes(root: string, maxDepth: number, out: Set<string>, depth = 0, budget = { n: 0 }): void {
  if (depth > maxDepth || budget.n <= 0 || !fs.existsSync(root)) {
    return;
  }
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (budget.n <= 0) {
      return;
    }
    budget.n--;
    if (!entry.isDirectory()) {
      continue;
    }
    const child = path.join(root, entry.name);
    if (fs.existsSync(path.join(child, "bin", javaExecutableName()))) {
      out.add(child);
      continue; // 命中 javaHome 后不再深入
    }
    findJavaHomes(child, maxDepth, out, depth + 1, budget);
  }
}

/** 按平台收集扫描根（HMCL JavaManager 同款路径） */
function platformScanRoots(): { root: string; depth: number }[] {
  const roots: { root: string; depth: number }[] = [];
  const home = os.homedir();
  if (process.platform === "win32") {
    const programFiles = process.env["ProgramFiles"] ?? "C:\\Program Files";
    const programFilesX86 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
    roots.push({ root: programFiles, depth: 2 });
    roots.push({ root: programFilesX86, depth: 2 });
    // 官方启动器自带 runtime（runtime/<name>/<platform>/bin/java.exe）
    const x86 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
    roots.push({ root: path.join(x86, "Minecraft Launcher", "runtime"), depth: 3 });
    const pf = process.env["ProgramFiles"] ?? "C:\\Program Files";
    roots.push({ root: path.join(pf, "Minecraft Launcher", "runtime"), depth: 3 });
  } else if (process.platform === "darwin") {
    roots.push({ root: "/Library/Java/JavaVirtualMachines", depth: 4 });
    roots.push({ root: path.join(home, "Library", "Java", "JavaVirtualMachines"), depth: 4 });
  } else {
    roots.push({ root: "/usr/lib/jvm", depth: 2 });
    roots.push({ root: path.join(home, ".sdkman", "candidates", "java"), depth: 2 });
  }
  return roots;
}

/** 从候选 exe 路径构造 JavaInstall（release 文件优先） */
function makeInstall(exePath: string, source: string): JavaInstall | undefined {
  // exe 位于 <home>/bin/java(.exe)
  const home = path.dirname(path.dirname(exePath));
  const release = parseReleaseFile(home);
  let version = release?.version;
  let vendor = release?.vendor ?? "";
  if (!version) {
    // 无 release 文件：spawn 解析（仅对少量候选执行）
    const r = spawnSync(exePath, ["-version"], { encoding: "utf8", timeout: 5000 });
    const text = `${r.stdout ?? ""}${r.stderr ?? ""}`;
    version = parseVersionOutput(text);
  }
  if (!version) {
    return undefined;
  }
  const major = parseJavaMajor(version);
  if (!major) {
    return undefined;
  }
  return { home, exePath, major, version, vendor, source };
}

/** 递增去重键：同一 home 只保留优先级最高的来源 */
function addUnique(map: Map<string, JavaInstall>, install: JavaInstall | undefined): void {
  if (!install) {
    return;
  }
  const key = path.normalize(install.home).toLowerCase();
  if (!map.has(key)) {
    map.set(key, install);
  }
}

/**
 * 检测本机全部可用 Java（按来源优先级去重）。
 * @param manualPath 用户在设置中显式指定的 java 路径（可空）
 */
export function detectJava(manualPath?: string): JavaInstall[] {
  const byHome = new Map<string, JavaInstall>();

  // ① 用户显式设置
  if (manualPath && manualPath.trim().length > 0) {
    const exe = fs.existsSync(manualPath) && fs.statSync(manualPath).isDirectory()
      ? path.join(manualPath, "bin", javaExecutableName())
      : manualPath;
    addUnique(byHome, makeInstall(exe, "manual"));
  }

  // ② JAVA_HOME / JDK_HOME
  for (const envName of ["JAVA_HOME", "JDK_HOME"]) {
    const home = process.env[envName];
    if (home) {
      addUnique(byHome, makeInstall(path.join(home, "bin", javaExecutableName()), envName.toLowerCase()));
    }
  }

  // ③ PATH 中的 java
  const pathProbe = spawnSync(javaExecutableName(), ["-version"], { encoding: "utf8", timeout: 5000 });
  if (!pathProbe.error) {
    addUnique(byHome, makeInstall(javaExecutableName(), "path"));
  }

  // ④ 平台标准目录
  const candidates = new Set<string>();
  for (const { root, depth } of platformScanRoots()) {
    findJavaHomes(root, depth, candidates);
  }
  for (const home of candidates) {
    addUnique(byHome, makeInstall(path.join(home, "bin", javaExecutableName()), "platform"));
  }

  // 输出：主版本降序（新版本优先），同版本手动/环境变量来源优先
  const sourceRank: Record<string, number> = { manual: 0, java_home: 1, jdk_home: 2, path: 3, platform: 4 };
  return [...byHome.values()].sort((a, b) => {
    if (b.major !== a.major) {
      return b.major - a.major;
    }
    return (sourceRank[a.source] ?? 9) - (sourceRank[b.source] ?? 9);
  });
}
