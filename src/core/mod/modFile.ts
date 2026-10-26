// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 VSCL contributors
/**
 * Mod 元数据解析（读取 jar 内元数据文件，不解压落盘）。
 * 支持：fabric.mod.json / quilt.mod.json / META-INF/mods.toml（Forge 新）/ mcmod.info（Forge 老）。
 */
import * as path from "path";
import { readZipEntry } from "../util/minimalZip";

/** Mod 加载器类型 */
export type ModLoader = "fabric" | "quilt" | "forge" | "neoforge" | "liteloader" | "unknown";

/** 解析出的 Mod 元数据 */
export interface ModMeta {
  name?: string;
  version?: string;
  authors?: string;
  description?: string;
  loader: ModLoader;
}

/** 安全 JSON 解析（jar 内文件可能损坏） */
function tryJson(text: Buffer | undefined): unknown | undefined {
  if (!text) {
    return undefined;
  }
  try {
    return JSON.parse(text.toString("utf8"));
  } catch {
    return undefined;
  }
}

/** 解析 mod jar 的元数据 */
export function parseModMeta(filePath: string): ModMeta {
  const lower = filePath.toLowerCase();
  try {
    // —— Fabric ——
    const fabric = tryJson(readZipEntry(filePath, "fabric.mod.json")) as
      | { name?: string; version?: string | { toString(): string }; authors?: (string | { name?: string })[]; description?: string; custom?: Record<string, unknown> }
      | undefined;
    if (fabric) {
      const author0 = fabric.authors?.[0];
      return {
        name: fabric.name,
        version: typeof fabric.version === "string" ? fabric.version : undefined,
        authors: typeof author0 === "string" ? author0 : author0?.name,
        description: fabric.description,
        loader: "fabric",
      };
    }
    // —— Quilt ——
    const quilt = tryJson(readZipEntry(filePath, "quilt.mod.json")) as
      | { quilt_loader?: { quilt_metadata?: { name?: string; version?: string; contributors?: Record<string, string>; description?: string } } }
      | undefined;
    if (quilt?.quilt_loader) {
      const meta = quilt.quilt_loader.quilt_metadata ?? {};
      const contributor = meta.contributors ? Object.keys(meta.contributors)[0] : undefined;
      return { name: meta.name, version: meta.version, authors: contributor, description: meta.description, loader: "quilt" };
    }
    // —— Forge / NeoForge 新（TOML 简版正则提取；NeoForge 20.2+ 使用 neoforge.mods.toml） ——
    const tomlNeo = readZipEntry(filePath, "META-INF/neoforge.mods.toml");
    const toml = tomlNeo ?? readZipEntry(filePath, "META-INF/mods.toml");
    if (toml) {
      const text = toml.toString("utf8");
      // TOML 值：`key="带引号值" #注释` 或 `key=裸值 #注释`
      const pick = (key: string): string | undefined => {
        const m = text.match(new RegExp(`^${key}\\s*=\\s*(?:"([^"]*)"|([^\\s#]+))`, "m"));
        return m ? (m[1] ?? m[2]) : undefined;
      };
      let version = pick("version");
      if (version?.includes("${file.jarVersion}")) {
        // Gradle 占位符：回退 jar 的 MANIFEST Implementation-Version
        const mf = readZipEntry(filePath, "META-INF/MANIFEST.MF")?.toString("utf8") ?? "";
        version = mf.match(/^Implementation-Version:\s*(.+)$/m)?.[1]?.trim();
      }
      return {
        name: pick("displayName"),
        version,
        authors: pick("authors"),
        description: pick("description"),
        loader: tomlNeo ? "neoforge" : "forge",
      };
    }
    // —— Forge 老（mcmod.info，JSON 数组） ——
    const legacy = tryJson(readZipEntry(filePath, "mcmod.info")) as { modList?: unknown } | unknown[] | undefined;
    const first = Array.isArray(legacy) ? (legacy[0] as Record<string, unknown>) : undefined;
    if (first) {
      return {
        name: first["name"] as string | undefined,
        version: first["version"] as string | undefined,
        authors: Array.isArray(first["authorList"]) ? (first["authorList"] as string[]).join(", ") : undefined,
        description: first["description"] as string | undefined,
        loader: "forge",
      };
    }
  } catch {
    /* 损坏的 jar → 未知元数据 */
  }
  // 兜底：按扩展名猜测
  const guess: ModLoader = lower.endsWith(".litemod") ? "liteloader" : "unknown";
  return { loader: guess };
}
