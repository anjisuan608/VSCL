// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 VSCL contributors
/**
 * 组件清单（HMCL 安装器列表同款结构）：Minecraft 基础版本 + 各加载器/组件。
 * 提供组件定义、实例组件识别（store 扫描结果匹配）与组件版本提取（从
 * 合并版本 JSON 的 libraries 坐标反推，HMCL GameComponentType 同思路）。
 */
import * as fs from "fs";
import * as path from "path";
import { readJson } from "./launch/versionMerge";

/** 组件定义 */
export interface ComponentDef {
  id: ComponentId;
  name: string;
  /** 是否为基础版本（Minecraft 行为不同：仅切换、不可移除） */
  base?: boolean;
  /** 说明（仅 Minecraft 保留） */
  hint?: string;
}

/** 安装列表（顺序对齐 HMCL 下载中心） */
export const COMPONENTS: ComponentDef[] = [
  { id: "minecraft", name: "Minecraft", base: true, hint: "游戏本体（必选）" },
  { id: "forge", name: "Forge" },
  { id: "neoforge", name: "NeoForge" },
  { id: "cleanroom", name: "Cleanroom" },
  { id: "fabric", name: "Fabric" },
  { id: "legacyfabric", name: "Legacy Fabric" },
  { id: "quilt", name: "Quilt" },
  { id: "liteloader", name: "LiteLoader" },
  { id: "optifine", name: "OptiFine" },
];

/** 组件 id */
export type ComponentId = "minecraft" | "fabric" | "quilt" | "legacyfabric" | "forge" | "neoforge" | "cleanroom" | "liteloader" | "optifine";

/** store 组件名（InstanceInfo.components）→ 组件 id */
const DETECT_TO_ID: Record<string, ComponentId> = {
  Fabric: "fabric",
  "Legacy Fabric": "legacyfabric",
  Quilt: "quilt",
  Forge: "forge",
  NeoForge: "neoforge",
  Cleanroom: "cleanroom",
  OptiFine: "optifine",
  LiteLoader: "liteloader",
};

/** 由扫描组件列表推断已安装组件 id 集合（LiteLoader 等未列组件忽略） */
export function installedComponentIds(detected: string[]): ComponentId[] {
  const out: ComponentId[] = [];
  for (const d of detected) {
    const id = DETECT_TO_ID[d];
    if (id && !out.includes(id)) {
      out.push(id);
    }
  }
  return out;
}

/**
 * 从实例版本 JSON 的 libraries 坐标提取各组件版本。
 * @param gameDir 游戏目录
 * @param instanceId 实例 id（versions/<id>/<id>.json，HMCL 合并 JSON 或自包含 JSON）
 */
export function extractComponentVersions(gameDir: string, instanceId: string): Partial<Record<ComponentId, string>> {
  const json = readJson(gameDir, instanceId);
  if (!json) {
    return {};
  }
  const names = (json.libraries ?? []).map((l) => l.name ?? "");
  const out: Partial<Record<ComponentId, string>> = {};

  const coord = (prefix: string): string | undefined => {
    for (const n of names) {
      if (n.startsWith(prefix)) {
        return n.split(":")[2];
      }
    }
    return undefined;
  };

  // Fabric 系（Legacy Fabric 以坐标组区分：net.legacyfabric 存在即 Legacy）
  const fabricLoader = coord("net.fabricmc:fabric-loader:");
  if (fabricLoader) {
    const isLegacy = names.some((n) => n.startsWith("net.legacyfabric:"));
    out[isLegacy ? "legacyfabric" : "fabric"] = fabricLoader;
  }
  out.quilt = coord("org.quiltmc:quilt-loader:");

  // Forge 系
  out.neoforge = coord("net.neoforged.fancymodloader:loader:");
  const forgeVer = coord("net.minecraftforge:forge:");
  if (forgeVer) {
    // forge 坐标版本形如 "1.20.1-47.4.0"，取 loader 段
    const parts = forgeVer.split("-");
    out.forge = parts.length > 1 ? parts.slice(1).join("-") : forgeVer;
  }

  // LiteLoader
  out.liteloader = coord("com.mumfrey:liteloader:");

  // OptiFine（坐标 optifine:OptiFine:<mc>_<edition>）
  const of = coord("optifine:OptiFine:");
  if (of) {
    out.optifine = of;
  }
  return out;
}

/**
 * 实例的基础 Minecraft 版本。
 * HMCL 合并 JSON 的 jar 字段指向自身（无 inheritsFrom），基础版本从 id 提取
 * 首个 x.y[.z] 段（"1.21.8-Quilt" → "1.21.8；"26.1.2-Fabric" → "26.1.2"）。
 */
export function baseMinecraftVersion(gameDir: string, instanceId: string): string {
  const jsonPath = path.join(gameDir, "versions", instanceId, `${instanceId}.json`);
  try {
    const raw = JSON.parse(fs.readFileSync(jsonPath, "utf8")) as { jar?: string; inheritsFrom?: string; id?: string };
    // 独立实例布局（Forge 安装器风格）：inheritsFrom 即基础版本
    if (raw.inheritsFrom) {
      return raw.inheritsFrom;
    }
    // jar 指向其他版本目录时为继承布局
    if (raw.jar && raw.jar !== instanceId) {
      return raw.jar;
    }
  } catch {
    /* 落回 id 启发式 */
  }
  const m = instanceId.match(/^(\d+\.\d+(?:\.\d+)?)/);
  return m ? m[1] : instanceId;
}
