// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 VSCL contributors
/**
 * 账户库（多账户模型）。
 *  - 账户元数据：globalStorage/accounts.json（跨工作区共享）
 *  - 微软令牌：SecretStorage，key 按账户 id 隔离（vscl.msCredential.<id>）
 *  - 选中账户：workspaceState（多窗口隔离，与选中实例一致）
 *  - 离线 UUID 规则与 Mojang 一致（UUIDv3 of "OfflinePlayer:<name>"）；
 *    无账户时启动使用默认用户名 "Dev"。
 */
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { offlineUuid } from "./offline";
import type { MsCredential } from "./microsoft";

/** 默认离线用户名（未添加任何账户时启动使用） */
export const DEFAULT_USERNAME = "Dev";

/** 账户条目（元数据；令牌不落此文件） */
export interface AccountEntry {
  id: string;
  type: "offline" | "microsoft";
  username: string;
  uuid: string;
}

const SELECTED_KEY = "vscl.selectedAccountId";
const msKey = (id: string) => `vscl.msCredential.${id}`;

/** 账户库 */
export class AccountStore {
  constructor(private readonly context: vscode.ExtensionContext) {}

  private get file(): string {
    return path.join(this.context.globalStorageUri.fsPath, "accounts.json");
  }

  /** 读取全部账户 */
  load(): AccountEntry[] {
    try {
      const list = JSON.parse(fs.readFileSync(this.file, "utf8")) as AccountEntry[];
      return Array.isArray(list) ? list : [];
    } catch {
      return [];
    }
  }

  private save(list: AccountEntry[]): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, `${JSON.stringify(list, null, 2)}\n`, "utf8");
  }

  /** 添加账户（离线自动生成 UUID；微软使用 profile UUID） */
  add(entry: Omit<AccountEntry, "id">): AccountEntry {
    const list = this.load();
    // 同类型同名账户去重（更新令牌场景复用 id）
    const existing = list.find((a) => a.type === entry.type && a.username === entry.username);
    if (existing) {
      existing.uuid = entry.uuid;
      this.save(list);
      return existing;
    }
    const created: AccountEntry = { ...entry, id: crypto.randomUUID() };
    list.push(created);
    this.save(list);
    return created;
  }

  /** 移除账户（含其微软令牌） */
  async remove(id: string): Promise<void> {
    this.save(this.load().filter((a) => a.id !== id));
    await this.context.secrets.delete(msKey(id));
  }

  /** 生成离线条目（不落盘） */
  static offlineEntry(username: string): Omit<AccountEntry, "id"> {
    const name = username.trim();
    return { type: "offline", username: name, uuid: offlineUuid(name) };
  }

  // ── 微软令牌（SecretStorage，按账户隔离） ──
  async loadMsCredential(id: string): Promise<MsCredential | undefined> {
    const raw = await this.context.secrets.get(msKey(id));
    if (!raw) {
      return undefined;
    }
    try {
      return JSON.parse(raw) as MsCredential;
    } catch {
      return undefined;
    }
  }

  async saveMsCredential(id: string, cred: MsCredential): Promise<void> {
    await this.context.secrets.store(msKey(id), JSON.stringify(cred));
  }

  // ── 选中账户（workspaceState，多窗口隔离） ──
  getSelectedId(): string | undefined {
    return this.context.workspaceState.get<string>(SELECTED_KEY);
  }

  async setSelectedId(id: string | undefined): Promise<void> {
    await this.context.workspaceState.update(SELECTED_KEY, id);
  }
}
