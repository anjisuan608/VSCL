// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 VSCL contributors
/**
 * 版本 JSON 合并（`inheritsFrom` 继承链展开，Mojang 官方合并规则的 TS 实现）。
 * 合并策略：
 *  - libraries：同 group:artifact 坐标去重，**子版本优先**
 *  - arguments.game / arguments.jvm：子数组在前 + 父数组在后（concat）
 *  - mainClass / javaVersion / jar / assetIndex / assets / logging：子优先，缺省取父
 */
import * as fs from "fs";
import * as path from "path";

/** 版本 JSON 中 arguments 元素（字符串或带规则的对象） */
export type ArgumentEntry = string | { rules?: RawRule[]; value?: string | string[] };

export interface RawRule {
  os?: { name?: string; arch?: string; version?: string };
  features?: Record<string, boolean>;
  action: "allow" | "disallow";
}

export interface RawLibrary {
  name?: string;
  downloads?: {
    artifact?: { path?: string; url?: string; sha1?: string; size?: number };
    classifiers?: Record<string, { path?: string; url?: string; sha1?: string; size?: number }>;
  };
  natives?: Record<string, string>;
  rules?: RawRule[];
  url?: string;
}

/** 完整版本 JSON（取启动所需字段的超集） */
export interface DetailedVersionJson {
  id?: string;
  inheritsFrom?: string;
  jar?: string;
  mainClass?: string;
  type?: string;
  arguments?: { game?: ArgumentEntry[]; jvm?: ArgumentEntry[] };
  minecraftArguments?: string; // 旧版（≤1.12）启动参数串
  assetIndex?: { id?: string; url?: string; sha1?: string };
  assets?: string;
  javaVersion?: { component?: string; majorVersion?: number };
  logging?: { client?: { argument?: string; file?: { id?: string; url?: string; sha1?: string } } };
  libraries?: RawLibrary[];
}

/** 合并结果 */
export interface MergedVersion {
  id: string;
  jarId: string; // 客户端 jar 所属版本目录名（继承链指向 vanilla）
  mainClass?: string;
  type?: string;
  gameArgs?: ArgumentEntry[]; // 现代 arguments.game（无则 undefined，走 minecraftArguments）
  jvmArgs?: ArgumentEntry[];
  minecraftArguments?: string;
  assetIndexId?: string;
  assetIndexUrl?: string;
  assetIndexSha1?: string;
  assets?: string;
  javaMajor?: number;
  loggingArgument?: string;
  loggingFileId?: string;
  loggingFileUrl?: string;
  libraries: RawLibrary[]; // 合并去重后的完整库列表（子优先）
}

/** 读取并解析版本 JSON */
export function readJson(gameDir: string, versionId: string): DetailedVersionJson | undefined {
  const p = path.join(gameDir, "versions", versionId, `${versionId}.json`);
  try {
    return JSON.parse(fs.readFileSync(p, "utf8")) as DetailedVersionJson;
  } catch {
    return undefined;
  }
}

/** libraries 去重键：group:artifact（classifier 属于下载细节，主体坐标优先） */
function libKey(lib: RawLibrary): string {
  const parts = (lib.name ?? "").split(":");
  return parts.length >= 2 ? `${parts[0]}:${parts[1]}` : lib.name ?? "";
}

/** 沿继承链合并（深度防环） */
export function mergeVersion(gameDir: string, versionId: string, depth = 0): MergedVersion | undefined {
  if (depth > 8) {
    return undefined;
  }
  const json = readJson(gameDir, versionId);
  if (!json) {
    return undefined;
  }
  let parent: MergedVersion | undefined;
  if (json.inheritsFrom) {
    parent = mergeVersion(gameDir, json.inheritsFrom, depth + 1);
  }

  // libraries：子优先去重
  const libs = new Map<string, RawLibrary>();
  if (parent) {
    for (const l of parent.libraries) {
      libs.set(libKey(l), l);
    }
  }
  for (const l of json.libraries ?? []) {
    libs.set(libKey(l), l); // 子覆盖父
  }

  return {
    id: json.id ?? versionId,
    jarId: json.jar ?? parent?.jarId ?? json.id ?? versionId,
    mainClass: json.mainClass ?? parent?.mainClass,
    type: json.type ?? parent?.type,
    gameArgs: json.arguments?.game ?? parent?.gameArgs,
    jvmArgs: json.arguments?.jvm ?? parent?.jvmArgs,
    minecraftArguments: json.minecraftArguments ?? parent?.minecraftArguments,
    assetIndexId: json.assetIndex?.id ?? parent?.assetIndexId,
    assetIndexUrl: json.assetIndex?.url ?? parent?.assetIndexUrl,
    assetIndexSha1: json.assetIndex?.sha1 ?? parent?.assetIndexSha1,
    assets: json.assets ?? parent?.assets,
    javaMajor: json.javaVersion?.majorVersion ?? parent?.javaMajor,
    loggingArgument: json.logging?.client?.argument ?? parent?.loggingArgument,
    loggingFileId: json.logging?.client?.file?.id ?? parent?.loggingFileId,
    loggingFileUrl: json.logging?.client?.file?.url ?? parent?.loggingFileUrl,
    libraries: [...libs.values()],
  };
}
