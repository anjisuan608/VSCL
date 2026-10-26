// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 VSCL contributors
/**
 * 最小 ZIP 解压实现（零依赖，供 natives 解压与整合包 overrides 使用）。
 * 支持 STORED(0) 与 DEFLATE(8) 两种方法（覆盖 99.9% 的 jar/zip）；
 * 含 Zip Slip 防护（目标路径必须位于目标目录内）。
 */
import * as fs from "fs";
import * as path from "path";
import * as zlib from "zlib";

const EOCD_SIG = 0x06054b50;
const CD_SIG = 0x02014b50;

/**
 * 读取 ZIP 中单个条目的数据（供 Mod 元数据解析使用，不解压落盘）。
 * @param entryName 条目完整路径（如 "fabric.mod.json"）
 */
export function readZipEntry(zipPath: string, entryName: string): Buffer | undefined {
  const buf = fs.readFileSync(zipPath);
  let eocd = -1;
  const scanStart = Math.max(0, buf.length - 22 - 65535);
  for (let i = buf.length - 22; i >= scanStart; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) {
    return undefined;
  }
  const entryCount = buf.readUInt16LE(eocd + 10);
  let ptr = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < entryCount; n++) {
    if (ptr + 46 > buf.length || buf.readUInt32LE(ptr) !== CD_SIG) {
      break;
    }
    const method = buf.readUInt16LE(ptr + 10);
    const compSize = buf.readUInt32LE(ptr + 20);
    const nameLen = buf.readUInt16LE(ptr + 28);
    const extraLen = buf.readUInt16LE(ptr + 30);
    const commentLen = buf.readUInt16LE(ptr + 32);
    const localOffset = buf.readUInt32LE(ptr + 42);
    const name = buf.toString("utf8", ptr + 46, ptr + 46 + nameLen);
    ptr += 46 + nameLen + extraLen + commentLen;
    if (name !== entryName) {
      continue;
    }
    const localNameLen = buf.readUInt16LE(localOffset + 26);
    const localExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    if (dataStart + compSize > buf.length) {
      return undefined;
    }
    const data = buf.subarray(dataStart, dataStart + compSize);
    if (method === 0) {
      return Buffer.from(data);
    }
    if (method === 8) {
      return zlib.inflateRawSync(data);
    }
    return undefined;
  }
  return undefined;
}

/**
 * 解压 ZIP 到目标目录。
 * @returns 解压的文件数量
 * @throws 不是有效 ZIP 时抛错
 */
export function extractZip(zipPath: string, destDir: string): number {
  const buf = fs.readFileSync(zipPath);

  // 定位 EOCD（从尾部搜索，注释最长 65535）
  let eocd = -1;
  const scanStart = Math.max(0, buf.length - 22 - 65535);
  for (let i = buf.length - 22; i >= scanStart; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) {
    throw new Error(`无效的 ZIP 文件：${zipPath}`);
  }
  const entryCount = buf.readUInt16LE(eocd + 10);
  let ptr = buf.readUInt32LE(eocd + 16);
  const destRoot = path.resolve(destDir);
  let extracted = 0;

  for (let n = 0; n < entryCount; n++) {
    if (ptr + 46 > buf.length || buf.readUInt32LE(ptr) !== CD_SIG) {
      break;
    }
    const method = buf.readUInt16LE(ptr + 10);
    const compSize = buf.readUInt32LE(ptr + 20);
    const nameLen = buf.readUInt16LE(ptr + 28);
    const extraLen = buf.readUInt16LE(ptr + 30);
    const commentLen = buf.readUInt16LE(ptr + 32);
    const localOffset = buf.readUInt32LE(ptr + 42);
    const name = buf.toString("utf8", ptr + 46, ptr + 46 + nameLen);
    ptr += 46 + nameLen + extraLen + commentLen;

    if (name.endsWith("/")) {
      continue; // 目录项
    }
    const dest = path.resolve(destDir, name);
    if (!dest.startsWith(destRoot + path.sep) && dest !== destRoot) {
      continue; // Zip Slip 防护
    }
    // 本地文件头：跳过文件名与额外字段得到数据起点
    const localNameLen = buf.readUInt16LE(localOffset + 26);
    const localExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    if (dataStart + compSize > buf.length) {
      continue; // 数据越界，跳过损坏项
    }
    const data = buf.subarray(dataStart, dataStart + compSize);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    if (method === 0) {
      fs.writeFileSync(dest, data);
    } else if (method === 8) {
      fs.writeFileSync(dest, zlib.inflateRawSync(data));
    } else {
      continue; // 不支持的压缩方法（如 BZip2），跳过
    }
    extracted++;
  }
  return extracted;
}
