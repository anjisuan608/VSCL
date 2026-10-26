// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 VSCL contributors
/**
 * 实例图标发现与安全检查（HMCL `icon.png` 惯例的多格式超集）。
 *
 * 安全限制（防扩展卡死 / 内存爆炸 / 像素炸弹）：
 *  ① 只枚举固定白名单文件名（icon.png …），无用户输入拼接 → 无路径穿越风险
 *  ② 文件大小上限 MAX_FILE_BYTES（stat 读取，不解码）
 *  ③ 魔数校验：必须是真实图片头（防改名伪装的任意文件）
 *  ④ 仅读取文件头部 HEADER_READ_BYTES 解析宽高，超过 MAX_DIMENSION 直接拒绝
 *     —— 全程不做完整图片解码；Chromium 自身的解码上限作为第二道兜底
 *  ⑤ TIFF 格式识别后跳过：VS Code Webview（Chromium）不原生渲染 TIFF，
 *     无法显示时退回组件默认图标，避免"看得见目录却加载不出"的困惑
 *  ⑥ 检查结果按 path+mtime 缓存，避免重复读盘
 */
import * as fs from "fs";
import * as path from "path";

/** 支持的图标文件名（按优先级；全部为 Chromium 可直接渲染的格式） */
const ICON_FILENAMES = [
  "icon.png",
  "icon.jpg",
  "icon.jpeg",
  "icon.webp",
  "icon.bmp",
  "icon.gif",
  "icon.ico",
] as const;

/** 识别但不渲染的格式（浏览器不支持，直接跳过） */
const UNSUPPORTED_FILENAMES = ["icon.tiff", "icon.tif"];

/** 单文件大小上限：512KB（base64 后约 700KB，data URI 传输可控） */
const MAX_FILE_BYTES = 512 * 1024;

/** 图片宽高上限：1024 × 1024（实例图标通常 64–256px） */
const MAX_DIMENSION = 1024;

/** 头部读取量：JPEG 的 SOF 段一般位于前几 KB，64KB 足够覆盖 */
const HEADER_READ_BYTES = 64 * 1024;

/** 通过全部安全检查的图标描述 */
export interface InstanceIcon {
  /** 图标绝对路径 */
  path: string;
  /** 图片格式（小写扩展名语义：png/jpeg/webp/bmp/gif/ico） */
  format: string;
  width: number;
  height: number;
  /** 文件修改时间（缓存键） */
  mtimeMs: number;
}

/** MIME 映射 */
const MIME: Record<string, string> = {
  png: "image/png",
  jpeg: "image/jpeg",
  webp: "image/webp",
  bmp: "image/bmp",
  gif: "image/gif",
  ico: "image/x-icon",
};

/** 尺寸解析结果 */
interface Dimensions {
  format: string;
  width: number;
  height: number;
}

/** PNG：签名 8 字节后 IHDR 中的宽高（big-endian uint32） */
function parsePng(buf: Buffer): Dimensions | undefined {
  if (buf.length < 24) {
    return undefined;
  }
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (!sig.every((b, i) => buf[i] === b)) {
    return undefined;
  }
  return { format: "png", width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/** GIF：头 6 字节签名后的小端 uint16 宽高 */
function parseGif(buf: Buffer): Dimensions | undefined {
  if (buf.length < 10) {
    return undefined;
  }
  const head = buf.toString("ascii", 0, 6);
  if (head !== "GIF87a" && head !== "GIF89a") {
    return undefined;
  }
  return { format: "gif", width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
}

/** BMP：DIB 头（BITMAPINFOHEADER 起）中的宽高（int32，高度可为负表示自底向上） */
function parseBmp(buf: Buffer): Dimensions | undefined {
  if (buf.length < 26 || buf.toString("ascii", 0, 2) !== "BM") {
    return undefined;
  }
  const width = buf.readInt32LE(18);
  const height = Math.abs(buf.readInt32LE(22));
  return { format: "bmp", width: Math.abs(width), height };
}

/** JPEG：扫描 marker 段定位 SOFn（排除 DHT/JPG/DAC），读取帧宽高 */
function parseJpeg(buf: Buffer): Dimensions | undefined {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) {
    return undefined;
  }
  let pos = 2;
  while (pos + 9 < buf.length) {
    if (buf[pos] !== 0xff) {
      pos++;
      continue;
    }
    const marker = buf[pos + 1];
    if (marker === 0xff) {
      pos++; // 填充字节
      continue;
    }
    // SOF0–SOF15，排除 C4(DHT)/C8(JPG)/CC(DAC)
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const height = buf.readUInt16BE(pos + 5);
      const width = buf.readUInt16BE(pos + 7);
      return { format: "jpeg", width, height };
    }
    if (pos + 4 > buf.length) {
      break;
    }
    pos += 2 + buf.readUInt16BE(pos + 2); // 跳过本段
  }
  return undefined; // 头截断内未找到 SOF → 视为异常
}

/** WebP：RIFF 容器下的 VP8X / VP8 / VP8L 三种 chunk */
function parseWebp(buf: Buffer): Dimensions | undefined {
  if (buf.length < 30 || buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WEBP") {
    return undefined;
  }
  const chunk = buf.toString("ascii", 12, 16);
  if (chunk === "VP8X") {
    const width = 1 + buf.readUIntLE(24, 3);
    const height = 1 + buf.readUIntLE(27, 3);
    return { format: "webp", width, height };
  }
  if (chunk === "VP8L") {
    if (buf[20] !== 0x2f) {
      return undefined;
    }
    const bits = buf.readUInt32LE(21);
    return { format: "webp", width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (chunk === "VP8 ") {
    // 位流同步码 0x9d 0x01 0x2a 后跟 14bit 宽高
    for (let i = 20; i + 6 < Math.min(buf.length, 64); i++) {
      if (buf[i] === 0x9d && buf[i + 1] === 0x01 && buf[i + 2] === 0x2a) {
        return {
          format: "webp",
          width: buf.readUInt16LE(i + 3) & 0x3fff,
          height: buf.readUInt16LE(i + 5) & 0x3fff,
        };
      }
    }
    return undefined;
  }
  return undefined;
}

/** ICO：ICONDIR 后第一个目录项的宽高（0 表示 256） */
function parseIco(buf: Buffer): Dimensions | undefined {
  if (buf.length < 8 || buf[0] !== 0 || buf[1] !== 0 || buf[2] !== 1 || buf[3] !== 0) {
    return undefined;
  }
  const width = buf[6] || 256;
  const height = buf[7] || 256;
  return { format: "ico", width, height };
}

/** TIFF 魔数识别（Chromium 不渲染，仅用于确认格式后跳过） */
function isTiff(buf: Buffer): boolean {
  if (buf.length < 4) {
    return false;
  }
  const le = buf.toString("ascii", 0, 2) === "II" && buf.readUInt16LE(2) === 0x002a;
  const be = buf.toString("ascii", 0, 2) === "MM" && buf.readUInt16BE(2) === 0x002a;
  return le || be;
}

/** 按魔数分发解析（先校验头、再取尺寸，全程不解码像素） */
function readImageDimensions(buf: Buffer): Dimensions | undefined {
  return parsePng(buf) ?? parseGif(buf) ?? parseBmp(buf) ?? parseJpeg(buf) ?? parseWebp(buf) ?? parseIco(buf);
}

/** 检查结果缓存（key: 文件路径；value: mtime+size+结果），上限 512 条 */
const probeCache = new Map<string, { mtimeMs: number; size: number; icon?: InstanceIcon }>();
const CACHE_LIMIT = 512;

/**
 * 探测实例目录下的自定义图标（icon.* 白名单 + 四道安全检查）。
 * @returns 通过检查的图标描述；无图标或全部被安全限制拒绝时返回 undefined
 */
export function probeInstanceIcon(instanceDir: string): InstanceIcon | undefined {
  for (const name of [...ICON_FILENAMES, ...UNSUPPORTED_FILENAMES]) {
    const iconPath = path.join(instanceDir, name);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(iconPath);
    } catch {
      continue; // 不存在
    }
    if (!stat.isFile() || stat.size === 0) {
      continue;
    }
    // 缓存命中（同 mtime+size）
    const cached = probeCache.get(iconPath);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      return cached.icon;
    }
    let icon: InstanceIcon | undefined;
    // ② 大小限制
    if (stat.size <= MAX_FILE_BYTES) {
      let buf: Buffer | undefined;
      const fd = fs.openSync(iconPath, "r");
      try {
        buf = Buffer.allocUnsafe(Math.min(HEADER_READ_BYTES, stat.size));
        fs.readSync(fd, buf, 0, buf.length, 0);
      } catch {
        buf = undefined;
      } finally {
        fs.closeSync(fd);
      }
      if (buf) {
        // ⑤ TIFF：识别后跳过（Webview 无法渲染）
        if (!isTiff(buf)) {
          // ③ 魔数 + ④ 尺寸限制
          const dims = readImageDimensions(buf);
          if (dims && dims.width > 0 && dims.height > 0 && dims.width <= MAX_DIMENSION && dims.height <= MAX_DIMENSION) {
            icon = { path: iconPath, format: dims.format, width: dims.width, height: dims.height, mtimeMs: stat.mtimeMs };
          }
        }
      }
    }
    // 写缓存（含"被拒绝"结果，避免重复做检查）
    if (probeCache.size >= CACHE_LIMIT) {
      const first = probeCache.keys().next().value;
      if (first !== undefined) {
        probeCache.delete(first);
      }
    }
    probeCache.set(iconPath, { mtimeMs: stat.mtimeMs, size: stat.size, icon });
    if (icon) {
      return icon;
    }
  }
  return undefined;
}

/** data URI 读取缓存（key: path+mtime → base64 URI） */
const dataUriCache = new Map<string, string>();

/**
 * 将通过检查的图标读为 data URI（供 Webview 显示；受 MAX_FILE_BYTES 约束，
 * base64 后体积 ≈ 源文件 × 1.34，内存可控）。
 */
export function readIconDataUri(icon: InstanceIcon): string {
  const key = `${icon.path}|${icon.mtimeMs}`;
  const hit = dataUriCache.get(key);
  if (hit) {
    return hit;
  }
  try {
    const raw = fs.readFileSync(icon.path);
    if (raw.length > MAX_FILE_BYTES) {
      return ""; // 双保险：读取时再次校验大小
    }
    const mime = MIME[icon.format] ?? "image/png";
    const uri = `data:${mime};base64,${raw.toString("base64")}`;
    if (dataUriCache.size >= 64) {
      const first = dataUriCache.keys().next().value;
      if (first !== undefined) {
        dataUriCache.delete(first);
      }
    }
    dataUriCache.set(key, uri);
    return uri;
  } catch {
    return "";
  }
}
