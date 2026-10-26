// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 VSCL contributors
//
// 安装流程参考 HMCL `OptiFineInstallTask` 的公开实现逻辑：installer jar 物化为
// optifine maven 库、嵌套 launchwrapper 提取、Patcher（新版 OF）经 Java 执行。
/**
 * OptiFine 安装（版本列表与下载均走 BMCLAPI——官方下载经 adfoc.us 广告页不可自动化）。
 * 流程：下载 installer → 校验 Config.class → 物化为 `optifine:OptiFine:<v>` 库
 *      （含 `optifine/Patcher.class` 时经 Java 生成补丁版 jar）→ 提取嵌套
 *      launchwrapper（launchwrapper-2.0 / launchwrapper-of，缺省回退
 *      net.minecraft:launchwrapper:1.12 由通用安装器下载）→ 生成 --tweakClass
 *      版本 JSON（inheritsFrom 基础实例）→ 补齐依赖库。
 */
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { DownloadPool, downloadFile, httpGetJson } from "../download/downloader";
import { installVersion } from "../download/gameInstaller";
import { extractZip, readZipEntry } from "../util/minimalZip";

/** BMCLAPI OptiFine 端点 */
const BMCL_OPTIFINE_LIST = "https://bmclapi2.bangbang93.com/optifine/versionlist";
const BMCL_OPTIFINE_DOWNLOAD = "https://bmclapi2.bangbang93.com/optifine";

/** OptiFine 版本列表项（BMCLAPI versionlist 原始结构子集） */
interface OptiFineRawVersion {
  mcversion: string;
  type: string;
  patch: string;
  filename?: string;
}

/** 规范化版本项 */
export interface OptiFineVersion {
  /** 组合 id，如 "1.20.1_HD_U_I5"（mcversion_type_patch） */
  id: string;
  mcversion: string;
  type: string;
  patch: string;
}

/** 拉取 OptiFine 版本列表（新→旧） */
export async function fetchOptiFineVersions(): Promise<OptiFineVersion[]> {
  const raw = await httpGetJson<OptiFineRawVersion[]>(BMCL_OPTIFINE_LIST);
  return raw
    .filter((v) => v.mcversion && v.type && v.patch)
    .map((v) => ({ id: `${v.mcversion}_${v.type}_${v.patch}`, mcversion: v.mcversion, type: v.type, patch: v.patch }))
    .reverse();
}

/** maven 坐标 → 库相对路径 */
function mavenPath(group: string, artifact: string, version: string, classifier?: string, ext = "jar"): string {
  const file = classifier ? `${artifact}-${version}-${classifier}.${ext}` : `${artifact}-${version}.${ext}`;
  return `${group.replace(/\./g, "/")}/${artifact}/${version}/${file}`;
}

/** 安装选项 */
export interface OptiFineInstallOptions {
  gameDir: string;
  /** 基础实例 id（原版或已装 Forge/Quilt 等） */
  baseInstanceId: string;
  version: OptiFineVersion;
  /** Patcher 需要 Java（仅含 optifine/Patcher.class 的新版 OF） */
  javaExe: string;
  threads: number;
  /** 自定义实例/客户端名称（默认 `<mc>-OptiFine_<type>_<patch>`） */
  customId?: string;
  onProgress?: (message: string) => void;
}

/** 安装 OptiFine，返回新实例 id */
export async function installOptiFine(o: OptiFineInstallOptions): Promise<string> {
  const v = `${o.version.mcversion}_${o.version.type}_${o.version.patch}`;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vscl-of-"));
  try {
    // ① 下载 installer（仅 BMCLAPI）
    o.onProgress?.("下载 OptiFine 安装器…");
    const installer = path.join(tmpDir, "OptiFine-installer.jar");
    await downloadFile(`${BMCL_OPTIFINE_DOWNLOAD}/${o.version.mcversion}/${o.version.type}/${o.version.patch}`, installer, {
      retries: 2,
    });
    if (!readZipEntry(installer, "Config.class") && !readZipEntry(installer, "net/optifine/Config.class")) {
      throw new Error("无效的 OptiFine 安装包（缺少 Config.class）");
    }

    // ② 物化 OptiFine 库：有 Patcher（新版）则经 Java 生成补丁 jar，否则直接复制
    o.onProgress?.("生成 OptiFine 组件…");
    const librariesDir = path.join(o.gameDir, "libraries");
    const ofLibRel = mavenPath("optifine", "OptiFine", v);
    const ofLibPath = path.join(librariesDir, ofLibRel);
    fs.mkdirSync(path.dirname(ofLibPath), { recursive: true });
    const clientJar = path.join(o.gameDir, "versions", o.baseInstanceId, `${o.baseInstanceId}.jar`);
    if (readZipEntry(installer, "optifine/Patcher.class")) {
      if (!fs.existsSync(clientJar)) {
        throw new Error(`基础版本 jar 缺失：${clientJar}（请先完整安装基础版本）`);
      }
      const r = spawnSync(
        o.javaExe,
        ["-cp", installer, "optifine.Patcher", clientJar, installer, ofLibPath],
        { encoding: "utf8", timeout: 10 * 60 * 1000, windowsHide: true }
      );
      if (r.status !== 0 || !fs.existsSync(ofLibPath)) {
        throw new Error(`OptiFine Patcher 失败：${(r.stderr || r.stdout || "").trim().slice(-300) || `exit=${r.status}`}`);
      }
    } else {
      fs.copyFileSync(installer, ofLibPath);
    }

    // ③ 嵌套 launchwrapper 提取（HMCL 同款三分支）
    const libraries: { name: string }[] = [];
    if (readZipEntry(installer, "launchwrapper-2.0.jar")) {
      const rel = mavenPath("optifine", "launchwrapper", "2.0");
      const dest = path.join(librariesDir, rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, readZipEntry(installer, "launchwrapper-2.0.jar")!);
      libraries.push({ name: "optifine:launchwrapper:2.0" });
    } else {
      const verText = readZipEntry(installer, "launchwrapper-of.txt")?.toString("utf8").trim();
      const nestedJar = verText ? readZipEntry(installer, `launchwrapper-of-${verText}.jar`) : undefined;
      if (verText && nestedJar) {
        const rel = mavenPath("optifine", "launchwrapper-of", verText);
        const dest = path.join(librariesDir, rel);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, nestedJar);
        libraries.push({ name: `optifine:launchwrapper-of:${verText}` });
      } else {
        // 回退：官方 launchwrapper（通用安装器从 libraries.minecraft.net 下载）
        libraries.push({ name: "net.minecraft:launchwrapper:1.12" });
      }
    }
    libraries.push({ name: `optifine:OptiFine:${v}` });

    // ④ 生成版本 JSON（装于 Forge 实例之上时使用 ForgeTweaker，XMCL 同款）
    const baseJsonPath = path.join(o.gameDir, "versions", o.baseInstanceId, `${o.baseInstanceId}.json`);
    const baseJson = JSON.parse(fs.readFileSync(baseJsonPath, "utf8")) as { libraries?: { name?: string }[] };
    const onForge = (baseJson.libraries ?? []).some((l) => (l.name ?? "").startsWith("net.neoforged.fancymodloader"));
    const newId = o.customId?.trim() || `${o.version.mcversion}-OptiFine_${o.version.type}_${o.version.patch}`;
    const instanceDir = path.join(o.gameDir, "versions", newId);
    fs.mkdirSync(instanceDir, { recursive: true });
    const json = {
      id: newId,
      inheritsFrom: o.baseInstanceId,
      type: "release",
      mainClass: "net.minecraft.launchwrapper.Launch",
      arguments: { game: ["--tweakClass", onForge ? "optifine.OptiFineForgeTweaker" : "optifine.OptiFineTweaker"], jvm: [] },
      libraries,
    };
    fs.writeFileSync(path.join(instanceDir, `${newId}.json`), `${JSON.stringify(json, null, 2)}\n`, "utf8");

    // ⑤ 补齐依赖库（回退 launchwrapper 等）
    o.onProgress?.("补齐依赖库…");
    await installVersion({ gameDir: o.gameDir, versionId: newId, source: "bmclapi", threads: o.threads });
    return newId;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}
