// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 VSCL contributors
/**
 * 链接打开统一入口（设计基线 5.13）。
 * 由设置 `vscl.useIntegratedBrowser` 分流：
 *  - true  → VS Code 内置 Simple Browser（`vscode.simpleBrowser.show`）
 *  - false → 系统默认浏览器（`vscode.env.openExternal`）
 * 例外：账户登录/OAuth 类链接强制走系统浏览器（Simple Browser 内登录流程受限且安全体验差）。
 */
import * as vscode from "vscode";
import { Settings } from "../../config/settings";

/** 链接类型：auth 类强制系统浏览器 */
export type LinkKind = "default" | "auth";

/** 判断 URL 是否属于账户登录/OAuth 类 */
function isAuthUrl(url: string): boolean {
  return /login\.live\.com|microsoftonline\.com|xboxlive\.com|accounts\.mojang\.com/i.test(url);
}

/** 打开链接（按设置分流，失败自动回落系统浏览器） */
export async function openLink(url: string, kind: LinkKind = "default"): Promise<void> {
  const useIntegrated = Settings.useIntegratedBrowser();
  if (useIntegrated && kind !== "auth" && !isAuthUrl(url)) {
    try {
      await vscode.commands.executeCommand("vscode.simpleBrowser.show", url);
      return;
    } catch {
      // Simple Browser 不可用（如 web 环境）→ 回落系统浏览器
    }
  }
  await vscode.env.openExternal(vscode.Uri.parse(url));
}
