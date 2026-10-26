// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 VSCL contributors
/**
 * 微软账户认证（设备码流程，端点/协议对齐 HMCL `MicrosoftService` + `OAuth`）。
 * 链路：OAuth20 device code → Xbox Live (XBL1.0) → XSTS → Minecraft Services → profile。
 * client_id 需自注册 Azure Application（设置项 vscl.microsoftClientId），不复用第三方 id。
 * 凭据经 SecretStorage 存储（refresh_token 长期有效）。
 */
import * as https from "https";
import { URLSearchParams } from "url";

/** scope（HMCL 同款） */
const SCOPE = "XboxLive.signin offline_access";

/** 存储的账户凭据 */
export interface MsCredential {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // epoch ms
  uuid: string;
  username: string;
}

/** JSON POST（https） */
function postJson(url: string, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(typeof body === "string" ? body : JSON.stringify(body), "utf8");
    const u = new URL(url);
    const req = https.request(
      {
        method: "POST",
        hostname: u.hostname,
        path: u.pathname + u.search,
        headers: {
          "Content-Type": typeof body === "string" ? "application/x-www-form-urlencoded" : "application/json",
          "Content-Length": data.length,
          ...headers,
        },
        timeout: 30000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json: unknown;
          try {
            json = JSON.parse(text);
          } catch {
            json = { raw: text };
          }
          resolve({ status: res.statusCode ?? 0, json });
        });
        res.on("error", reject);
      }
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("请求超时")));
    req.write(data);
    req.end();
  });
}

/** JSON GET */
function getJson<T>(url: string, headers: Record<string, string> = {}): Promise<{ status: number; json: T }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request(
      { method: "GET", hostname: u.hostname, path: u.pathname + u.search, headers, timeout: 30000 },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json: unknown;
          try {
            json = JSON.parse(text);
          } catch {
            json = { raw: text };
          }
          resolve({ status: res.statusCode ?? 0, json: json as T });
        });
        res.on("error", reject);
      }
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("请求超时")));
    req.end();
  });
}

/** base64url 编码 */
function b64url(input: object): string {
  return Buffer.from(JSON.stringify(input), "utf8").toString("base64url");
}

/** 设备码流程的提示信息 */
export interface DevicePrompt {
  userCode: string;
  verificationUri: string;
  /** 轮询间隔（ms） */
  intervalMs: number;
}

/**
 * 完整登录链（设备码 → XBL → XSTS → MC → profile）。
 * @param onPrompt 展示用户码与验证链接（由 UI 层 openExternal + 通知）
 */
export async function loginWithMicrosoft(clientId: string, onPrompt: (p: DevicePrompt) => void): Promise<MsCredential> {
  // ① 设备码
  const dcBody = new URLSearchParams({ client_id: clientId, scope: SCOPE }).toString();
  const dc = await postJson("https://login.live.com/oauth20_connect.srf?grant_type=urn:ietf:params:oauth:grant-type:device_code", dcBody);
  const dcJson = dc.json as { device_code?: string; user_code?: string; verification_uri?: string; interval?: number; error?: string; error_description?: string };
  if (!dcJson.device_code || !dcJson.user_code) {
    throw new Error(`获取设备码失败：${dcJson.error_description ?? dcJson.error ?? dc.status}`);
  }
  onPrompt({ userCode: dcJson.user_code, verificationUri: dcJson.verification_uri ?? "https://microsoft.com/link", intervalMs: (dcJson.interval ?? 5) * 1000 });

  // ② 轮询 token
  const deadline = Date.now() + 15 * 60 * 1000;
  let msAccessToken = "";
  let refreshToken = "";
  while (!msAccessToken) {
    if (Date.now() > deadline) {
      throw new Error("登录超时（15 分钟未完成授权）");
    }
    await new Promise((r) => setTimeout(r, dcJson.interval ? dcJson.interval * 1000 : 5000));
    const tokenBody = new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      client_id: clientId,
      device_code: dcJson.device_code,
    }).toString();
    const tr = await postJson("https://login.live.com/oauth20_token.srf", tokenBody);
    const tj = tr.json as { access_token?: string; refresh_token?: string; error?: string; error_description?: string };
    if (tj.access_token) {
      msAccessToken = tj.access_token;
      refreshToken = tj.refresh_token ?? "";
    } else if (tj.error === "authorization_pending" || tj.error === "slow_down") {
      continue;
    } else {
      throw new Error(`获取令牌失败：${tj.error_description ?? tj.error ?? tr.status}`);
    }
  }

  // ③ Xbox Live 1.0
  const xblBody = {
    Properties: { AuthMethod: "RPS", SiteName: "user.auth.xboxlive.com", RpsTicket: `d=${msAccessToken}` },
    RelyingParty: "http://auth.xboxlive.com",
    TokenType: "JWT",
  };
  const xbl = await postJson("https://user.auth.xboxlive.com/user/authenticate", xblBody);
  const xblToken = (xbl.json as { Token?: string }).Token;
  const uhs = (xbl.json as { DisplayClaims?: { xui?: { uhs?: string }[] } }).DisplayClaims?.xui?.[0]?.uhs;
  if (!xblToken || !uhs) {
    throw new Error("Xbox Live 认证失败（可能未开通 Xbox 账户）");
  }

  // ④ XSTS 授权
  const xstsBody = {
    Properties: { SandboxId: "RETAIL", UserTokens: [xblToken] },
    RelyingParty: "rp://api.minecraftservices.com/",
    TokenType: "JWT",
  };
  const xsts = await postJson("https://xsts.auth.xboxlive.com/xsts/authorize", xstsBody);
  const xstsToken = (xsts.json as { Token?: string }).Token;
  if (!xstsToken) {
    const err = (xsts.json as { XErr?: number }).XErr;
    const reason: Record<number, string> = {
      2148916233: "没有 Xbox 账户",
      2148916238: "区域受限",
      2148916235: "Xbox 账户需家长确认",
    };
    throw new Error(`XSTS 授权失败：${reason[err ?? 0] ?? `XErr=${err ?? xsts.status}`}`);
  }

  // ⑤ Minecraft Services
  const mcBody = { userTokens: [xstsToken], identityToken: `XBL3.0 x=${uhs};${xstsToken}` };
  const mc = await postJson("https://api.minecraftservices.com/authentication/login_with_xbox", mcBody);
  const mcAccess = (mc.json as { access_token?: string }).access_token;
  if (!mcAccess) {
    throw new Error(`Minecraft 服务认证失败：${(mc.json as { error_description?: string }).error_description ?? mc.status}`);
  }

  // ⑥ profile（无 profile = 未拥有游戏）
  const profile = await getJson<{ id?: string; name?: string; error?: string }>("https://api.minecraftservices.com/minecraft/profile", {
    Authorization: `Bearer ${mcAccess}`,
  });
  if (!profile.json.id || !profile.json.name) {
    throw new Error("该微软账号未拥有 Minecraft（或未创建游戏档案）");
  }

  return {
    accessToken: mcAccess,
    refreshToken,
    expiresAt: Date.now() + 24 * 3600 * 1000, // MC access token 约 24h
    uuid: profile.json.id,
    username: profile.json.name,
  };
}

/** 用 refresh_token 刷新 Minecraft access token（失败返回 undefined） */
export async function refreshMicrosoft(clientId: string, refreshToken: string): Promise<{ accessToken: string; refreshToken: string } | undefined> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: clientId,
    refresh_token: refreshToken,
    scope: SCOPE,
  }).toString();
  const tr = await postJson("https://login.live.com/oauth20_token.srf", body);
  const tj = tr.json as { access_token?: string; refresh_token?: string };
  if (!tj.access_token) {
    return undefined;
  }
  // 刷新的是 MS 层 token，需重走 XBL→XSTS→MC 链
  const xbl = await postJson("https://user.auth.xboxlive.com/user/authenticate", {
    Properties: { AuthMethod: "RPS", SiteName: "user.auth.xboxlive.com", RpsTicket: `d=${tj.access_token}` },
    RelyingParty: "http://auth.xboxlive.com",
    TokenType: "JWT",
  });
  const xblToken = (xbl.json as { Token?: string }).Token;
  const uhs = (xbl.json as { DisplayClaims?: { xui?: { uhs?: string }[] } }).DisplayClaims?.xui?.[0]?.uhs;
  if (!xblToken || !uhs) {
    return undefined;
  }
  const xsts = await postJson("https://xsts.auth.xboxlive.com/xsts/authorize", {
    Properties: { SandboxId: "RETAIL", UserTokens: [xblToken] },
    RelyingParty: "rp://api.minecraftservices.com/",
    TokenType: "JWT",
  });
  const xstsToken = (xsts.json as { Token?: string }).Token;
  if (!xstsToken) {
    return undefined;
  }
  const mc = await postJson("https://api.minecraftservices.com/authentication/login_with_xbox", {
    userTokens: [xstsToken],
    identityToken: `XBL3.0 x=${uhs};${xstsToken}`,
  });
  const mcAccess = (mc.json as { access_token?: string }).access_token;
  if (!mcAccess) {
    return undefined;
  }
  return { accessToken: mcAccess, refreshToken: tj.refresh_token ?? refreshToken };
}
