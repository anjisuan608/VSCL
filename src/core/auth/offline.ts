// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 VSCL contributors
/**
 * 离线账户身份。
 * 离线 UUID 生成规则与 Mojang 一致：UUIDv3(MD5) of "OfflinePlayer:<name>"，
 * 保证同一用户名离线登录获得稳定且与第三方工具一致的 UUID（存档/皮肤识别）。
 */
import * as crypto from "crypto";

/** 生成离线 UUID（8-4-4-4-12 格式，version=3 / variant=RFC4122） */
export function offlineUuid(username: string): string {
  const hash = crypto.createHash("md5").update(`OfflinePlayer:${username}`, "utf8").digest();
  hash[6] = (hash[6] & 0x0f) | 0x30; // UUID version 3
  hash[8] = (hash[8] & 0x3f) | 0x80; // variant RFC 4122
  const hex = hash.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** 离线启动的身份三元组（accessToken 为占位 "0"，userType=legacy） */
export function offlineIdentity(username: string): {
  username: string;
  uuid: string;
  accessToken: string;
  userType: "legacy";
} {
  const name = username.trim() || "Steve";
  return { username: name, uuid: offlineUuid(name), accessToken: "0", userType: "legacy" };
}
