// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 VSCL contributors
/**
 * Java 版本规则（对齐 HMCL `JavaVersionConstraint` 思路，覆盖 26.x 日历版本号时代）。
 *
 * 优先级：版本 JSON 的 javaVersion 声明 > 版本号推断规则。
 * 硬约束：游戏按 class file 版本编译，JVM 低于目标版本时字节码校验直接拒绝启动；
 *         modded 1.16.5 及更老版本锁定 Java 8（高版本必崩）。
 */

/** 解析 `java -version` / release 文件中的版本串为主版本号："1.8.0_402" → 8，"21.0.2" → 21 */
export function parseJavaMajor(version: string): number | undefined {
  const legacy = version.match(/^1\.(\d+)/);
  if (legacy) {
    return Number(legacy[1]);
  }
  const modern = version.match(/^(\d+)/);
  if (modern) {
    return Number(modern[1]);
  }
  return undefined;
}

/**
 * 推断启动指定游戏版本所需的 Java 主版本。
 * @param versionId 游戏版本 id（如 "1.20.1-Forge"、"26.1"、"25w14a"）
 * @param declared 版本 JSON 中声明的 javaVersion.majorVersion（若有则直接采用）
 * @returns 所需 Java 主版本；无法推断（如周快照且无声明）时返回 undefined
 */
export function requiredJavaMajor(versionId: string, declared?: number): number | undefined {
  if (declared && declared > 0) {
    return declared;
  }
  const base = versionId;

  // 日历版本号（26.1、26.1.1 …）：主版本 ≥ 25（2026 起）→ Java 25
  const calendar = base.match(/^(\d+)\.(\d+)/);
  if (calendar && Number(calendar[1]) >= 25) {
    return 25;
  }

  // 周快照（25w14a 等）：Java 需求随主线演进，无法静态推断，交由版本 JSON 声明
  if (/\d+w\d+/i.test(base)) {
    return undefined;
  }

  // 经典 1.x 版本线
  if (calendar && Number(calendar[1]) === 1) {
    const minor = Number(calendar[2]);
    const patchText = base.match(/^1\.\d+\.(\d+)/)?.[1];
    const patch = patchText ? Number(patchText) : 0;
    if (minor >= 21) {
      return 21; // 1.21.x
    }
    if (minor === 20 && patch >= 5) {
      return 21; // 1.20.5+
    }
    if (minor === 20 || minor === 19 || minor === 18) {
      return 17; // 1.18 – 1.20.4
    }
    if (minor === 17) {
      return 16; // 1.17.x
    }
    return 8; // ≤ 1.16.x（modded 锁定 Java 8）
  }

  // alpha/beta（b1.7.3、a1.2.6 等）
  if (/^[ab]\d/.test(base)) {
    return 8;
  }

  return undefined;
}

/** 判断已安装的 Java 主版本能否运行目标游戏版本 */
export function javaSatisfies(javaMajor: number, required: number | undefined): boolean {
  if (required === undefined) {
    return true; // 未知需求时不阻断
  }
  // modded 老版本线（required === 8）严格锁定：更高版本会因模块系统/字节码行为崩溃
  if (required === 8) {
    return javaMajor === 8;
  }
  // 其余线允许向上兼容（原版行为）
  return javaMajor >= required;
}
