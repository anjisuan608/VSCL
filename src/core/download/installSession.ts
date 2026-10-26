// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 VSCL contributors
/**
 * 安装会话（下载任务状态中心）。
 * 一个会话 = 一次安装（游戏版本/组件/整合包）；跟踪当前阶段、逐文件进度、
 * 实时速率与取消状态，事件广播给「下载与安装」面板与状态栏。
 */
import * as vscode from "vscode";

/** 单个下载项状态 */
export interface DownloadItemState {
  id: string;
  name: string;
  phase: string;
  received: number;
  total: number;
  status: "pending" | "downloading" | "done";
}

/** 取消信号（下载循环在检查点抛出中止会话） */
export class InstallCancelledError extends Error {
  constructor() {
    super("已取消");
    this.name = "InstallCancelledError";
  }
}

/** 安装会话 */
export class InstallSession {
  /** 阶段聚合进度（如 "安装 Minecraft" done/total） */
  phase = "";
  phaseDone = 0;
  phaseTotal = 0;
  /** 会话级聚合（阶段完成总数，用于通知百分比） */
  completed = false;
  cancelled = false;
  error?: string;

  private readonly items = new Map<string, DownloadItemState>();
  private readonly emitter = new vscode.EventEmitter<void>();
  /** 状态变更事件（面板/状态栏订阅） */
  readonly onDidChange = this.emitter.event;

  /** 速率统计（滑动窗口 2s） */
  private speedWindow: { at: number; bytes: number }[] = [];
  private lastBytes = 0;

  constructor(public readonly id: string, public readonly title: string) {}

  /** 广播 */
  private fire(): void {
    this.emitter.fire();
  }

  /** 进入新阶段 */
  setPhase(phase: string, total = 0): void {
    this.phase = phase;
    this.phaseDone = 0;
    this.phaseTotal = total;
    this.fire();
  }

  /** 阶段内完成一项聚合计数（如 10/100 个资源） */
  phaseStep(): void {
    this.phaseDone++;
    this.fire();
  }

  /** 新下载项（pending → 显示在列表，含待下载） */
  itemStart(id: string, name: string, total: number): void {
    this.items.set(id, { id, name, phase: this.phase, received: 0, total, status: "downloading" });
    this.fire();
  }

  /** 下载项进度（累计字节用于速率） */
  itemProgress(id: string, received: number, total: number): void {
    const item = this.items.get(id);
    if (!item) {
      return;
    }
    item.received = received;
    item.total = total || item.total;
    // 速率窗口
    const now = Date.now();
    this.speedWindow.push({ at: now, bytes: received });
    this.speedWindow = this.speedWindow.filter((s) => now - s.at <= 2000);
    this.fire();
  }

  /** 下载项完成（UI 侧淡出移除） */
  itemDone(id: string): void {
    const item = this.items.get(id);
    if (item) {
      item.status = "done";
      item.received = item.total;
    }
    this.phaseStep();
    this.fire();
  }

  /** 当前速率（bytes/s，基于最近 2s 窗口的总量差） */
  speed(): number {
    if (this.speedWindow.length < 2) {
      return 0;
    }
    const first = this.speedWindow[0];
    const last = this.speedWindow[this.speedWindow.length - 1];
    const dt = (last.at - first.at) / 1000;
    if (dt <= 0) {
      return 0;
    }
    return Math.max(0, (last.bytes - first.bytes) / dt);
  }

  /** 速率文本（如 "64MiB/s"） */
  speedText(): string {
    const bps = this.speed();
    if (bps < 1024) {
      return `${Math.round(bps)}B/s`;
    }
    if (bps < 1024 * 1024) {
      return `${(bps / 1024).toFixed(1)}KiB/s`;
    }
    return `${(bps / 1024 / 1024).toFixed(1)}MiB/s`;
  }

  /** 请求取消（下载循环在下一检查点抛 InstallCancelledError） */
  cancel(): void {
    if (!this.completed) {
      this.cancelled = true;
      this.fire();
    }
  }

  /** 取消检查（下载埋点调用） */
  checkCancelled(): void {
    if (this.cancelled) {
      throw new InstallCancelledError();
    }
  }

  /** 会话完成 */
  complete(error?: string): void {
    this.completed = true;
    this.error = error;
    this.fire();
  }

  /** 会话状态快照（面板渲染用） */
  snapshot(): { phase: string; phaseDone: number; phaseTotal: number; items: DownloadItemState[]; completed: boolean; cancelled: boolean; error?: string; speedText: string } {
    return {
      phase: this.phase,
      phaseDone: this.phaseDone,
      phaseTotal: this.phaseTotal,
      items: [...this.items.values()].filter((i) => i.status !== "done"), // 完成的项目不显示（UI 移除）
      completed: this.completed,
      cancelled: this.cancelled,
      error: this.error,
      speedText: this.completed ? "" : this.speedText(),
    };
  }
}

/** 全局会话注册表（sessionId → session；供通知/状态栏跳转） */
export class SessionRegistry {
  private readonly sessions = new Map<string, InstallSession>();

  add(session: InstallSession): void {
    this.sessions.set(session.id, session);
  }

  remove(id: string): void {
    this.sessions.delete(id);
  }

  get(id: string): InstallSession | undefined {
    return this.sessions.get(id);
  }

  /** 是否有进行中的会话 */
  anyRunning(): boolean {
    for (const s of this.sessions.values()) {
      if (!s.completed) {
        return true;
      }
    }
    return false;
  }
}
