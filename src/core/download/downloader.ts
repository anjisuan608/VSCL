// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 VSCL contributors
/**
 * 文件下载引擎（对应 HMCL `FetchTask` 核心能力的 TS 实现）：
 * 流式下载 + 临时文件原子替换 + SHA-1 校验 + 存在即跳过 + 指数退避重试 + 并发池限流。
 */
import * as crypto from "crypto";
import * as fs from "fs";
import * as http from "http";
import * as https from "https";
import * as path from "path";
import { URL } from "url";

/** 进度回调：已接收字节 / 总字节（未知为 0） */
export type ProgressCallback = (received: number, total: number) => void;

/** 计算文件 SHA-1（十六进制小写） */
export function fileSha1(filePath: string): string {
  const hash = crypto.createHash("sha1");
  const fd = fs.openSync(filePath, "r");
  try {
    const buf = Buffer.allocUnsafe(64 * 1024);
    let bytesRead: number;
    while ((bytesRead = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
      hash.update(buf.subarray(0, bytesRead));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}

/** 单次 HTTP GET（跟随重定向 ≤ 20），成功返回响应流收集 */
function httpGet(url: string, redirects = 0): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith("https:") ? https : http;
    const req = mod.get(url, { timeout: 60000 }, (res) => {
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400 && res.headers.location && redirects < 20) {
        res.resume();
        resolve(httpGet(new URL(res.headers.location, url).toString(), redirects + 1));
        return;
      }
      if (status !== 200) {
        res.resume();
        reject(new Error(`HTTP ${status}`));
        return;
      }
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks)));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("请求超时")));
  });
}

/** HTTP GET 小文件文本/JSON（版本清单、Fabric meta 等） */
export async function httpGetText(url: string): Promise<string> {
  return (await httpGet(url)).toString("utf8");
}

/** HTTP GET JSON */
export async function httpGetJson<T>(url: string): Promise<T> {
  return JSON.parse(await httpGetText(url)) as T;
}

export interface DownloadOptions {
  /** SHA-1 校验（十六进制）；提供且目标已存在且校验通过时跳过下载 */
  sha1?: string;
  onProgress?: ProgressCallback;
  /** 失败重试次数（默认 3，指数退避） */
  retries?: number;
}

/**
 * 下载文件（流式写入临时文件，完成后原子替换；含 SHA-1 校验）。
 * @returns "downloaded" 实际下载；"skipped" 已存在且校验通过
 */
export async function downloadFile(url: string, dest: string, opts: DownloadOptions = {}): Promise<"downloaded" | "skipped"> {
  const { sha1, onProgress, retries = 3 } = opts;
  // 命中校验缓存（有 sha1 按校验；无 sha1 时按存在性——写入经 part+rename 原子保证完整）
  if (fs.existsSync(dest)) {
    if (!sha1) {
      return "skipped";
    }
    try {
      if (fileSha1(dest) === sha1) {
        return "skipped";
      }
    } catch {
      /* 重新下载 */
    }
  }
  let lastError: Error | undefined;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      await downloadStream(url, dest, sha1, onProgress);
      return "downloaded";
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e));
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, 400 * 2 ** attempt));
      }
    }
  }
  throw lastError ?? new Error("下载失败");
}

/** 流式下载一次（含重定向跟随） */
function downloadStream(url: string, dest: string, sha1?: string, onProgress?: ProgressCallback, redirects = 0): Promise<void> {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith("https:") ? https : http;
    const req = mod.get(url, { timeout: 120000 }, (res) => {
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400 && res.headers.location && redirects < 20) {
        res.resume();
        resolve(downloadStream(new URL(res.headers.location, url).toString(), dest, sha1, onProgress, redirects + 1));
        return;
      }
      if (status !== 200) {
        res.resume();
        reject(new Error(`HTTP ${status}`));
        return;
      }
      const total = Number(res.headers["content-length"] ?? 0);
      let received = 0;
      const tmp = `${dest}.part`;
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      const ws = fs.createWriteStream(tmp);
      res.on("data", (c: Buffer) => {
        received += c.length;
        onProgress?.(received, total);
      });
      res.pipe(ws);
      ws.on("finish", () => {
        ws.close(() => {
          try {
            if (sha1) {
              const actual = fileSha1(tmp);
              if (actual !== sha1) {
                fs.rmSync(tmp, { force: true });
                reject(new Error(`SHA-1 校验失败（期望 ${sha1.slice(0, 8)}…，实际 ${actual.slice(0, 8)}…）`));
                return;
              }
            }
            fs.renameSync(tmp, dest); // 原子替换
            resolve();
          } catch (e) {
            reject(e instanceof Error ? e : new Error(String(e)));
          }
        });
      });
      ws.on("error", reject);
      res.on("error", reject);
    });
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("请求超时")));
  });
}

/**
 * 镜像优先、失败回落官方（BMCLAPI 部分 CDN 节点——如 mirrors.cernet.edu.cn——
 * 间歇性 403，重试同一镜像 URL 无效，必须回落官方源）。
 */
export async function downloadWithFallback(
  mappedUrl: string,
  officialUrl: string,
  dest: string,
  opts: DownloadOptions = {}
): Promise<"downloaded" | "skipped"> {
  try {
    return await downloadFile(mappedUrl, dest, opts);
  } catch (mirrorError) {
    if (mappedUrl === officialUrl) {
      throw mirrorError;
    }
    return await downloadFile(officialUrl, dest, opts);
  }
}

/** 简单并发池（信号量） */
export class DownloadPool {
  private active = 0;
  private readonly queue: (() => void)[] = [];

  constructor(private readonly limit: number) {}

  /** 提交任务（超出并发时排队） */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      await new Promise<void>((r) => this.queue.push(r));
    }
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.queue.shift()?.();
    }
  }
}
