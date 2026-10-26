// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 VSCL contributors
/**
 * 游戏日志终端（设计基线 5.8：Pseudoterminal 方案）。
 * 能力：ANSI 彩色透传（xterm.js 自动映射当前主题调色板）、高频日志节流合并、
 *       用户敲键回传游戏 stdin（游戏内控制台）、行尾 \r\n 终端语义。
 */
import * as vscode from "vscode";

/** 单次合并窗口内最多缓存的行数（防极端日志洪峰内存膨胀） */
const MAX_PENDING_LINES = 2000;
/** 合并窗口（ms） */
const FLUSH_INTERVAL = 80;

/** 一个游戏实例的日志终端 */
export class GameTerminal implements vscode.Pseudoterminal {
  private readonly write$ = new vscode.EventEmitter<string>();
  readonly onDidWrite = this.write$.event;
  private readonly close$ = new vscode.EventEmitter<number>();
  readonly onDidClose = this.close$.event;

  private pending: string[] = [];
  private flushTimer: NodeJS.Timeout | undefined;
  private inputBuffer = "";
  private opened = false;

  /** 用户输入回调（回车时触发，数据带 \n） */
  onUserInput?: (data: string) => void;

  constructor(public readonly title: string) {}

  open(): void {
    this.opened = true;
    this.raw("\x1b[90m── VSCL 游戏终端 ── 输入命令回车可发送到游戏内控制台 ──\x1b[0m\r\n");
  }

  close(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = undefined;
    }
  }

  /** 直接写入（立即，绕过节流） */
  private raw(text: string): void {
    if (this.opened) {
      this.write$.fire(text);
    }
  }

  /** 单行写入（节流合并窗口） */
  writeLine(line: string): void {
    if (this.pending.length >= MAX_PENDING_LINES) {
      this.pending.shift(); // 丢最旧行
    }
    this.pending.push(line);
    if (!this.flushTimer) {
      this.flushTimer = setInterval(() => this.flush(), FLUSH_INTERVAL);
    }
  }

  /** 批量刷出 */
  private flush(): void {
    if (this.pending.length === 0) {
      if (this.flushTimer) {
        clearInterval(this.flushTimer);
        this.flushTimer = undefined;
      }
      return;
    }
    const lines = this.pending;
    this.pending = [];
    this.raw(lines.map((l) => (l.includes("\r") ? l : `${l}\r\n`)).join(""));
  }

  /** 游戏输出（stdout/stderr 行）→ 终端 */
  onGameLine(line: string): void {
    this.writeLine(line);
  }

  /** 系统信息行（灰色） */
  info(text: string): void {
    this.writeLine(`\x1b[90m${text}\x1b[0m`);
  }

  /** 错误信息行（红色） */
  error(text: string): void {
    this.writeLine(`\x1b[31m${text}\x1b[0m`);
  }

  /** 警告信息行（黄色） */
  warning(text: string): void {
    this.writeLine(`\x1b[33m${text}\x1b[0m`);
  }

  /** 终端按键输入 → 游戏 stdin（回车提交整行） */
  handleInput(data: string): void {
    for (const ch of data) {
      if (ch === "\r" || ch === "\n") {
        this.raw(`\r\n`);
        this.onUserInput?.(`${this.inputBuffer}\n`);
        this.inputBuffer = "";
      } else if (ch === "\u007f") {
        // 退格
        if (this.inputBuffer.length > 0) {
          this.inputBuffer = this.inputBuffer.slice(0, -1);
          this.raw("\b \b");
        }
      } else if (ch >= " ") {
        this.inputBuffer += ch;
        this.raw(ch);
      }
    }
  }

  /** 关闭终端（游戏退出后可选保留——由扩展侧决定调用时机） */
  dispose(exitCode?: number): void {
    this.flush();
    this.close$.fire(exitCode ?? 0);
  }
}
