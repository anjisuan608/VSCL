// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 VSCL contributors
/**
 * 下载源镜像映射（BMCLAPI，对齐 HMCL `HMCLDownloadProvider` 的域名前缀规则）。
 * 仅做 URL 前缀替换；下载文件内容与官方一致（BMCLAPI 为社区维护镜像）。
 */

/** BMCLAPI 域名 */
const BMCL = "https://bmclapi2.bangbang93.com";

/** 官方域名 → BMCLAPI 路径映射（按序应用，首个命中生效） */
const MAPPING: { from: RegExp; to: string }[] = [
  { from: /^https:\/\/piston-meta\.mojang\.com\//, to: `${BMCL}/` },
  { from: /^https:\/\/launchermeta\.mojang\.com\//, to: `${BMCL}/` },
  { from: /^https:\/\/piston-data\.mojang\.com\//, to: `${BMCL}/` },
  { from: /^https:\/\/resources\.download\.minecraft\.net\//, to: `${BMCL}/assets/` },
  { from: /^https:\/\/libraries\.minecraft\.net\//, to: `${BMCL}/maven/` },
  { from: /^https:\/\/maven\.minecraftforge\.net\//, to: `${BMCL}/maven/` },
  { from: /^https:\/\/maven\.neoforged\.net\/releases\//, to: `${BMCL}/maven/` },
  { from: /^https:\/\/meta\.fabricmc\.net\//, to: `${BMCL}/fabric-meta/` },
];

/** 版本清单地址（官方 v2） */
export const VERSION_MANIFEST_URL = "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json";

/**
 * 按下载源设置映射 URL。
 * @param source official=原样；bmclapi=镜像替换
 */
export function mapUrl(url: string, source: "official" | "bmclapi"): string {
  if (source === "official") {
    return url;
  }
  for (const rule of MAPPING) {
    if (rule.from.test(url)) {
      return url.replace(rule.from, rule.to);
    }
  }
  return url;
}
