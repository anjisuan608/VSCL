// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 VSCL contributors
/**
 * 单一状态源（Store）。
 * 架构原则：所有 UI（主侧栏 WebviewView、编辑器区页面、TreeView、StatusBar）
 * 只上报用户意图并订阅本 Store，UI 之间不直接通信（星型拓扑）。
 */
import * as vscode from "vscode";
import type { AccountEntry } from "../auth/accounts";

/** 实例信息（由 core/game/instance 扫描产生） */
export interface InstanceInfo {
  /** 版本 id，如 "1.20.1-Forge" 或 "26.1" */
  id: string;
  /** 实例目录（versions/<id>） */
  dir: string;
  /** 检测到的组件（Fabric / Forge / …），空数组表示原版 */
  components: string[];
  /** 启动所需的 Java 主版本（按版本 JSON 声明或版本规则推断） */
  javaMajor?: number;
  /** 实例显示图标（来自 vsclversion.json 的 icon 或组件推断） */
  icon?: string;
  /** 实例目录下 icon.* 自定义图标的绝对路径（已通过大小/魔数/尺寸安全检查；无则 undefined） */
  iconPath?: string;
  /** 是否存在实例覆盖配置（.vscl/config/vsclversion.json） */
  hasOverride: boolean;
}

/** 游戏目录来源 */
export type DirectorySource = "workspace" | "registered" | "official";

/** 全局状态快照 */
export interface State {
  /** 当前激活的游戏目录 */
  activeDirectory?: string;
  /** 当前目录来源 */
  activeSource?: DirectorySource;
  /** 全部实例 */
  instances: InstanceInfo[];
  /** 当前选中实例 id */
  selectedInstanceId?: string;
  /** 正在运行中的实例 id 列表 */
  runningInstanceIds: string[];
  /** 账户列表 */
  accounts: AccountEntry[];
  /** 当前选中账户 id（undefined = 无账户，启动默认使用 Dev） */
  selectedAccountId?: string;
}

/** 状态变更事件载荷 */
export type StateChange = State;

export class Store extends vscode.EventEmitter<StateChange> {
  private _state: State = { instances: [], runningInstanceIds: [], accounts: [] };

  /** 当前状态快照（只读） */
  get state(): State {
    return this._state;
  }

  /** 当前选中账户（无则 undefined；启动时回落默认用户名 Dev） */
  get selectedAccount(): AccountEntry | undefined {
    return this._state.accounts.find((a) => a.id === this._state.selectedAccountId);
  }

  /** 当前选中的实例（无则 undefined） */
  get selectedInstance(): InstanceInfo | undefined {
    return this._state.instances.find((i) => i.id === this._state.selectedInstanceId);
  }

  /** 局部更新状态并广播 */
  update(partial: Partial<State>): void {
    this._state = { ...this._state, ...partial };
    // 选中项被移除时回退：选第一个实例
    if (
      this._state.selectedInstanceId &&
      !this._state.instances.some((i) => i.id === this._state.selectedInstanceId)
    ) {
      this._state.selectedInstanceId = this._state.instances[0]?.id;
    }
    this.fire(this._state);
  }
}
