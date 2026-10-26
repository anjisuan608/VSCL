// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 VSCL contributors
/**
 * 游戏进程管理（对应 HMCL `ManagedProcess` / `ExitWaiter` 的简化实现）。
 * spawn 于独立 cwd（实例目录），行流监听 stdout/stderr，退出码回传。
 */
import { ChildProcess, spawn } from "child_process";

/** 游戏进程句柄 */
export interface GameProcess {
  readonly child: ChildProcess;
  /** 结束回调（code、signal）；只触发一次 */
  onExit(cb: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  /** 向游戏 stdin 写入（游戏内控制台） */
  write(data: string): void;
  /** 终止进程树 */
  kill(): void;
}

/** spawn 游戏进程（工作目录 = 实例目录，与官方启动器一致） */
export function spawnGame(
  command: string,
  args: string[],
  cwd: string,
  onLine: (line: string, stream: "stdout" | "stderr") => void,
  opts: { env?: Record<string, string>; nice?: number } = {}
): GameProcess {
  // Linux 下以 nice 包装实现进程优先级（正值 = 降低优先级）
  const useNice = (opts.nice ?? 0) > 0 && process.platform === "linux";
  const realCmd = useNice ? "nice" : command;
  const realArgs = useNice ? ["-n", String(opts.nice), command, ...args] : args;
  const child = spawn(realCmd, realArgs, {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    env: opts.env ? { ...process.env, ...opts.env } : process.env,
  });

  // 行缓冲（游戏日志以 \n 分隔）
  const attach = (stream: NodeJS.ReadableStream, name: "stdout" | "stderr") => {
    let buffer = "";
    stream.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let idx: number;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx).replace(/\r$/, "");
        buffer = buffer.slice(idx + 1);
        onLine(line, name);
      }
    });
    stream.on("end", () => {
      if (buffer.length > 0) {
        onLine(buffer, name);
        buffer = "";
      }
    });
  };
  if (child.stdout) {
    attach(child.stdout, "stdout");
  }
  if (child.stderr) {
    attach(child.stderr, "stderr");
  }

  return {
    child,
    onExit(cb) {
      child.once("exit", (code, signal) => cb(code, signal));
    },
    write(data) {
      if (child.stdin && !child.stdin.destroyed) {
        child.stdin.write(data);
      }
    },
    kill() {
      if (child.exitCode === null && !child.killed) {
        // Windows 下 spawn 的游戏可能派生 Java 子进程；taskkill 树终止更可靠
        if (process.platform === "win32" && child.pid) {
          try {
            spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
            return;
          } catch {
            /* 回落 kill */
          }
        }
        child.kill();
      }
    },
  };
}
