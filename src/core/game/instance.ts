// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 VSCL contributors
/**
 * 实例发现与版本 JSON 解析（组件识别逻辑对齐 HMCL `GameComponentType.matchLibrary`）。
 * 布局：游戏目录下 `versions/<实例>/<实例>.json`；ModLoader 通过 `inheritsFrom` 继承基础版本。
 */
import * as fs from "fs";
import * as path from "path";
import type { InstanceInfo } from "../state/store";
import { requiredJavaMajor } from "../java/javaVersion";
import { overrideFilePath } from "./instanceConfig";
import { probeInstanceIcon } from "./instanceIcon";

/** Mojang 版本 JSON 的关键字段（只取启动相关子集） */
export interface VersionJson {
  id?: string;
  mainClass?: string;
  inheritsFrom?: string;
  javaVersion?: { component?: string; majorVersion?: number };
  libraries?: { name?: string }[];
}

/** 组件 → 显示图标键（对应 media/icons.js 中的 MD3 SVG 键名） */
const COMPONENT_ICON_KEYS: Record<string, string> = {
  Forge: "forge",
  NeoForge: "neoforge",
  Fabric: "fabric",
  "Legacy Fabric": "fabric",
  Quilt: "quilt",
  LiteLoader: "liteloader",
  OptiFine: "optifine",
  Cleanroom: "cleanroom",
};

/** Maven 坐标解析：group:artifact:version[:classifier] */
function parseCoordinate(name: string): { group: string; artifact: string; version: string } | undefined {
  const parts = name.split(":");
  if (parts.length < 3 || !parts[0] || !parts[1]) {
    return undefined;
  }
  return { group: parts[0], artifact: parts[1], version: parts[2] };
}

/** `group:artifact` 精确匹配（HMCL Library.is 同款） */
function coordIs(lib: string, group: string, artifact: string): boolean {
  const c = parseCoordinate(lib);
  return !!c && c.group === group && c.artifact === artifact;
}

/** 组判定 */
function groupOf(lib: string): string | undefined {
  return parseCoordinate(lib)?.group;
}

/**
 * NeoForge 判定（HMCL NEO_FORGE 同款）：只认 fml（fancymodloader）的 core/loader 坐标。
 * 不能按 `net.neoforged` 整组匹配——NeoForge 依赖树含 bus/coremods/srgutils 等大量普通库。
 */
function isNeoForgeLibrary(lib: string): boolean {
  const c = parseCoordinate(lib);
  return !!c && c.group === "net.neoforged.fancymodloader" && (c.artifact === "core" || c.artifact === "loader");
}

/**
 * Forge 判定（HMCL FORGE 同款）：`net.minecraftforge` 组的 forge/fmlloader/minecraftforge
 * artifact，且**全库不存在 NeoForge**（NeoForge 实例的依赖树含 fmlloader 系库时靠此互斥）。
 */
function hasForgeLibrary(libs: string[]): boolean {
  const FORGE_ARTIFACTS = new Set(["forge", "fmlloader", "minecraftforge"]);
  if (libs.some(isNeoForgeLibrary)) {
    return false; // HMCL：任一库命中 NeoForge → Forge 判定让位
  }
  return libs.some((l) => {
    const c = parseCoordinate(l);
    return !!c && c.group === "net.minecraftforge" && FORGE_ARTIFACTS.has(c.artifact);
  });
}

/**
 * 组件识别（HMCL GameComponentType.matchLibrary 逻辑移植）。
 * 各 loader 互斥关系由判定内置：Fabric/Legacy Fabric 靠 net.legacyfabric 组区分，
 * Forge/NeoForge 靠 NeoForge 反查区分，Cleanroom 坐标独立。
 */
function detectComponents(libs: string[]): string[] {
  const components: string[] = [];
  const hasGroup = (group: string) => libs.some((l) => groupOf(l) === group);

  // Fabric vs Legacy Fabric（HMCL：fabric-loader + 是否存在 net.legacyfabric 组库）
  if (libs.some((l) => coordIs(l, "net.fabricmc", "fabric-loader"))) {
    components.push(hasGroup("net.legacyfabric") ? "Legacy Fabric" : "Fabric");
  }
  // NeoForge（fml core/loader）
  if (libs.some(isNeoForgeLibrary)) {
    components.push("NeoForge");
  }
  // Forge（内置 NeoForge 反查互斥）
  if (hasForgeLibrary(libs)) {
    components.push("Forge");
  }
  // Cleanroom（HMCL：com.cleanroommc:cleanroom 精确坐标）
  if (libs.some((l) => coordIs(l, "com.cleanroommc", "cleanroom"))) {
    components.push("Cleanroom");
  }
  // Quilt / LiteLoader
  if (libs.some((l) => coordIs(l, "org.quiltmc", "quilt-loader"))) {
    components.push("Quilt");
  }
  if (libs.some((l) => coordIs(l, "com.mumfrey", "liteloader"))) {
    components.push("LiteLoader");
  }
  // OptiFine（HMCL：net.optifine / optifine 组，排除 launchwrapper）
  if (
    libs.some((l) => {
      const c = parseCoordinate(l);
      return !!c && (c.group === "net.optifine" || c.group === "optifine") && !c.artifact.includes("launchwrapper");
    })
  ) {
    components.push("OptiFine");
  }
  return components;
}

/**
 * 沿 inheritsFrom 链收集全部 libraries 与 javaVersion 声明（深度限制防环）。
 * @returns 版本 JSON 声明的 Java 主版本（链上首个声明优先）
 */
function collectInherited(
  gameDir: string,
  json: VersionJson,
  libsOut: string[],
  depth = 0
): number | undefined {
  if (depth > 8) {
    return undefined;
  }
  for (const lib of json.libraries ?? []) {
    if (lib.name) {
      libsOut.push(lib.name);
    }
  }
  const declared = json.javaVersion?.majorVersion;
  if (json.inheritsFrom) {
    const parentPath = path.join(gameDir, "versions", json.inheritsFrom, `${json.inheritsFrom}.json`);
    const parent = readVersionJson(parentPath);
    if (parent) {
      const parentDeclared = collectInherited(gameDir, parent, libsOut, depth + 1);
      return declared ?? parentDeclared;
    }
  }
  return declared;
}

/** 读取单个版本 JSON（容错：损坏/不存在返回 undefined） */
export function readVersionJson(filePath: string): VersionJson | undefined {
  try {
    const text = fs.readFileSync(filePath, "utf8");
    const obj = JSON.parse(text) as VersionJson;
    return typeof obj === "object" && obj !== null ? obj : undefined;
  } catch {
    return undefined;
  }
}

/** 扫描游戏目录下的全部实例 */
export async function scanInstances(gameDir: string): Promise<InstanceInfo[]> {
  const versionsDir = path.join(gameDir, "versions");
  const result: InstanceInfo[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(versionsDir, { withFileTypes: true });
  } catch {
    return result; // 目录不存在（尚未安装任何版本）
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const instanceDir = path.join(versionsDir, entry.name);
    const json = readVersionJson(path.join(instanceDir, `${entry.name}.json`));
    if (!json) {
      continue; // 非版本目录（如 .DS_Store 残留）
    }
    const libs: string[] = [];
    const declared = collectInherited(gameDir, json, libs);
    const components = detectComponents(libs);
    const id = json.id ?? entry.name;
    // 自定义图标：icon.* 白名单 + 安全检查（见 instanceIcon.ts）；无则按主组件映射 SVG 图标键
    const customIcon = probeInstanceIcon(instanceDir);
    result.push({
      id,
      dir: instanceDir,
      components,
      javaMajor: requiredJavaMajor(id, declared),
      icon: customIcon ? "image" : (COMPONENT_ICON_KEYS[components[0]] ?? "box"),
      iconPath: customIcon?.path,
      hasOverride: fs.existsSync(overrideFilePath(instanceDir)),
    });
  }
  // 排序：自然版本号倒序（新版本在前），解析失败的排最后
  return result.sort((a, b) => compareVersionIds(b.id, a.id));
}

/** 简版版本号比较：数字段逐段比较，非数字段字典序 */
function compareVersionIds(a: string, b: string): number {
  const pa = a.match(/\d+/g)?.map(Number) ?? [];
  const pb = b.match(/\d+/g)?.map(Number) ?? [];
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const va = pa[i] ?? 0;
    const vb = pb[i] ?? 0;
    if (va !== vb) {
      return va - vb;
    }
  }
  return a.localeCompare(b);
}
