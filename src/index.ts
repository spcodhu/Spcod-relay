import { createReadStream, existsSync, statSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket, WebSocketServer } from "ws";
import { RelayIdentity } from "./admission.js";
import { CHANNEL_ID_RE, type Conn, RelayCore, type Role } from "./channel.js";
import { RELAY_INFO_PATH, RELAY_PROTOCOL_VERSION, RELAY_TICKET_PATH } from "./protocol.js";
import { parseTicketBody } from "./ticket-request.js";
import { TicketService } from "./tickets.js";

/** 日志纪律：只记录元数据，绝不记录帧、ticket、访问密钥、准入证明或查询字符串。 */
export interface RelayConfig {
  port: number;
  staticDir: string;
  queueMax: number;
  queueTtlMs: number;
  frameMaxBytes: number;
  ratePerSec: number;
  maxChannels: number;
  maxDevices: number;
  queueBytesMax: number;
  /** relay X25519 身份（协议 v3 准入根）；缺省由 RelayIdentity.fromEnv 决定 */
  identity?: RelayIdentity;
  /** 自托管可选共享访问密钥：叠加在准入证明之上的 Bearer 门槛；官方公共实例为空。 */
  accessKey?: string | null;
  /** 除 same-origin 外，允许调用票据 API/WS 的 PWA origins。 */
  corsAllowedOrigins?: string[];
  heartbeatMs?: number;
  maxBufferedBytes?: number;
  ticketRatePerMin?: number;
  /** 单 IP 同时持有的 WebSocket 连接上限（默认 64；前置反代时必须开 TRUST_PROXY，否则全站同 IP） */
  maxConnsPerIp?: number;
  trustProxy?: boolean;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): RelayConfig {
  const int = (v: string | undefined, dflt: number): number => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : dflt;
  };
  const bool = (v: string | undefined, dflt: boolean): boolean => (v == null ? dflt : v === "true");
  return {
    port: int(env.PORT, 8787),
    staticDir: env.STATIC_DIR ?? "./public",
    queueMax: int(env.QUEUE_MAX, 1000),
    queueTtlMs: int(env.QUEUE_TTL_HOURS, 72) * 3600 * 1000,
    frameMaxBytes: 256 * 1024,
    ratePerSec: 60,
    maxChannels: int(env.MAX_CHANNELS, 1024),
    maxDevices: int(env.MAX_DEVICES_PER_CHANNEL, 16),
    queueBytesMax: int(env.QUEUE_BYTES_MAX_MB, 32) * 1024 * 1024,
    identity: RelayIdentity.fromEnv(env),
    accessKey: env.RELAY_ACCESS_KEY?.trim() || null,
    corsAllowedOrigins: (env.CORS_ALLOWED_ORIGINS ?? "")
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
    heartbeatMs: int(env.HEARTBEAT_MS, 30_000),
    maxBufferedBytes: int(env.MAX_BUFFERED_BYTES, 1024 * 1024),
    ticketRatePerMin: int(env.TICKET_RATE_PER_MIN, 60),
    maxConnsPerIp: int(env.MAX_CONNS_PER_IP, 64),
    trustProxy: bool(env.TRUST_PROXY, false),
  };
}

export interface RelayServer {
  server: http.Server;
  core: RelayCore;
  close(): Promise<void>;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".webmanifest": "application/manifest+json",
  ".txt": "text/plain; charset=utf-8",
};

const SECURITY_HEADERS: Record<string, string> = {
  // script-src 不含 'unsafe-inline'：PWA 的首屏主题脚本已外置为 theme-boot.js；
  // style-src 保留 'unsafe-inline'（React 内联 style 属性与代码高亮依赖）。
  "content-security-policy":
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' https: wss:; worker-src 'self' blob:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "cross-origin-opener-policy": "same-origin",
};

const FALLBACK_TEXT = {
  "zh-CN": {
    title: "Spcod Relay 运行中",
    privacy: "这是一个零知识哑中继：它只按通道转发端到端加密的数据，看不到任何明文内容。",
    missing: "此实例未托管手机端 PWA（STATIC_DIR 不存在）。请在客户端中填入本中继地址，或部署 PWA 构建产物后刷新。",
  },
  en: {
    title: "Spcod Relay is running",
    privacy: "This zero-knowledge relay forwards end-to-end encrypted data by channel. It cannot read the contents.",
    missing:
      "This instance does not host the mobile PWA (STATIC_DIR is missing). Enter this relay address in your client, or deploy the PWA build and refresh.",
  },
};

export function fallbackPage(acceptLanguage = ""): string {
  const preferred = acceptLanguage
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .find((value) => /^(?:zh|en)(?:[-;]|$)/.test(value));
  const locale = preferred?.startsWith("en") ? "en" : "zh-CN";
  const text = FALLBACK_TEXT[locale];
  return `<!doctype html><html lang="${locale}"><meta charset="utf-8">
<title>Spcod Relay</title><body style="font-family:system-ui;max-width:40em;margin:4em auto;padding:0 1em">
<h1>${text.title}</h1><p>${text.privacy}</p><p>${text.missing}</p></body></html>`;
}

function json(res: http.ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", ...SECURITY_HEADERS, ...headers });
  res.end(JSON.stringify(value));
}

const HEALTH_TEXT = {
  "zh-CN": {
    title: "Spcod Relay 健康检查",
    status: "服务运行正常",
    version: "协议版本",
    checkedAt: "检查时间（UTC）",
    privacy: "此公开页面仅显示服务状态，不包含连接、密钥或消息数据。",
  },
  en: {
    title: "Spcod Relay health check",
    status: "Service is operational",
    version: "Protocol version",
    checkedAt: "Checked at (UTC)",
    privacy: "This public page only reports service status. It contains no connection, credential, or message data.",
  },
};

export function healthPage(acceptLanguage = ""): string {
  const preferred = acceptLanguage
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .find((value) => /^(?:zh|en)(?:[-;]|$)/.test(value));
  const locale = preferred?.startsWith("en") ? "en" : "zh-CN";
  const text = HEALTH_TEXT[locale];
  const checkedAt = new Date().toISOString();
  return `<!doctype html><html lang="${locale}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${text.title}</title>
<style>:root{color-scheme:light dark;font-family:system-ui,sans-serif}body{max-width:38rem;margin:12vh auto;padding:0 1.25rem;line-height:1.6}.status{display:flex;align-items:center;gap:.65rem;font-size:1.35rem;font-weight:650}.dot{width:.8rem;height:.8rem;border-radius:50%;background:#22c55e;box-shadow:0 0 0 .3rem #22c55e26}dl{display:grid;grid-template-columns:auto 1fr;gap:.5rem 1.5rem;padding:1.25rem 0;border-block:1px solid #8884}dt{color:#888}dd{margin:0;font-variant-numeric:tabular-nums}.privacy{color:#888;font-size:.9rem}</style></head>
<body><h1>Spcod Relay</h1><p class="status"><span class="dot" aria-hidden="true"></span>${text.status}</p>
<dl><dt>${text.version}</dt><dd>${RELAY_PROTOCOL_VERSION}</dd><dt>${text.checkedAt}</dt><dd>${checkedAt}</dd></dl>
<p class="privacy">${text.privacy}</p></body></html>`;
}

function html(res: http.ServerResponse, status: number, body: string): void {
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    ...SECURITY_HEADERS,
  });
  res.end(body);
}

function originAllowed(origin: string | undefined, host: string | undefined, allowed: string[]): boolean {
  if (!origin) return true;
  try {
    const url = new URL(origin);
    if ((url.protocol === "http:" || url.protocol === "https:") && host && url.host === host) return true;
  } catch {
    return false;
  }
  return allowed.includes(origin);
}

function corsHeaders(origin: string | undefined): Record<string, string> {
  return origin
    ? {
        "access-control-allow-origin": origin,
        "access-control-allow-headers": "authorization,content-type",
        "access-control-allow-methods": "GET,POST,OPTIONS",
        vary: "Origin",
      }
    : {};
}

async function readJson(req: http.IncomingMessage, limit = 16 * 1024): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    if (size > limit) throw new Error("body_too_large");
    chunks.push(buf);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

export function sendWithBackpressure(ws: WebSocket, data: string, maxBufferedBytes: number): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  if (ws.bufferedAmount > maxBufferedBytes) {
    ws.terminate(); // 慢消费者无法完成优雅关闭握手，直接断开并触发客户端补拉
    return;
  }
  ws.send(data, (error) => {
    if (error) ws.terminate();
  });
}

export function createRelayServer(config: RelayConfig): RelayServer {
  const core = new RelayCore({
    queueMax: config.queueMax,
    queueTtlMs: config.queueTtlMs,
    frameMaxBytes: config.frameMaxBytes,
    ratePerSec: config.ratePerSec,
    maxChannels: config.maxChannels,
    maxDevices: config.maxDevices,
    queueBytesMax: config.queueBytesMax,
  });
  const staticDir = path.resolve(config.staticDir);
  const hasStatic = existsSync(staticDir) && statSync(staticDir).isDirectory();
  const allowedOrigins = config.corsAllowedOrigins ?? [];
  const identity = config.identity ?? RelayIdentity.fromEnv();
  const accessKey = config.accessKey ?? null;
  const tickets = new TicketService(identity, accessKey);
  const heartbeatMs = config.heartbeatMs ?? 30_000;
  const maxBufferedBytes = config.maxBufferedBytes ?? 1024 * 1024;
  const ticketRatePerMin = config.ticketRatePerMin ?? 60;
  const maxConnsPerIp = config.maxConnsPerIp ?? 64;
  const ticketAttempts = new Map<string, { count: number; resetAt: number }>();
  /** 每 IP 当前持有的 WebSocket 连接数（attach +1 / close -1） */
  const connsPerIp = new Map<string, number>();

  function requestIp(req: http.IncomingMessage): string {
    if (config.trustProxy) {
      const forwarded = req.headers["x-forwarded-for"];
      const value = Array.isArray(forwarded) ? forwarded[0] : forwarded;
      if (value) return value.split(",")[0]!.trim();
    }
    return req.socket.remoteAddress ?? "unknown";
  }

  function ticketRateAllowed(ip: string): boolean {
    const now = Date.now();
    const current = ticketAttempts.get(ip);
    if (!current || current.resetAt <= now) {
      ticketAttempts.set(ip, { count: 1, resetAt: now + 60_000 });
      return true;
    }
    if (current.count >= ticketRatePerMin) return false;
    current.count += 1;
    return true;
  }

  function acquireConnSlot(ip: string): boolean {
    const current = connsPerIp.get(ip) ?? 0;
    if (current >= maxConnsPerIp) return false;
    connsPerIp.set(ip, current + 1);
    return true;
  }

  function releaseConnSlot(ip: string): void {
    const current = connsPerIp.get(ip) ?? 0;
    if (current <= 1) connsPerIp.delete(ip);
    else connsPerIp.set(ip, current - 1);
  }

  async function handleHttp(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname === "/health") {
        const acceptsHtml = (req.headers.accept ?? "")
          .split(",")
          .some((value) => value.trim().toLowerCase().startsWith("text/html"));
        if (acceptsHtml) html(res, 200, healthPage(req.headers["accept-language"]));
        else json(res, 200, { ok: true, version: RELAY_PROTOCOL_VERSION });
        return;
      }
      if (url.pathname === RELAY_INFO_PATH && (req.method === "GET" || req.method === "OPTIONS")) {
        const origin = req.headers.origin;
        if (!originAllowed(origin, req.headers.host, allowedOrigins)) return json(res, 403, { error: "origin_denied" });
        if (req.method === "OPTIONS") {
          res.writeHead(204, { ...SECURITY_HEADERS, ...corsHeaders(origin) });
          res.end();
          return;
        }
        return json(
          res,
          200,
          { version: RELAY_PROTOCOL_VERSION, relayPk: identity.publicKey },
          { "cache-control": "no-store", ...corsHeaders(origin) },
        );
      }
      if (url.pathname === RELAY_TICKET_PATH && req.method === "OPTIONS") {
        const origin = req.headers.origin;
        if (!originAllowed(origin, req.headers.host, allowedOrigins)) return json(res, 403, { error: "origin_denied" });
        res.writeHead(204, { ...SECURITY_HEADERS, ...corsHeaders(origin) });
        res.end();
        return;
      }
      if (url.pathname === RELAY_TICKET_PATH && req.method === "POST") {
        const origin = req.headers.origin;
        if (!originAllowed(origin, req.headers.host, allowedOrigins)) return json(res, 403, { error: "origin_denied" });
        if (!ticketRateAllowed(requestIp(req))) return json(res, 429, { error: "rate_limited" }, corsHeaders(origin));
        try {
          const body = parseTicketBody(await readJson(req));
          if (!body) return json(res, 400, { error: "bad_request" }, corsHeaders(origin));
          const result = tickets.issue(body, req.headers.authorization);
          if (!result.ok) {
            const status = result.error === "bad_request" ? 400 : 401;
            return json(res, status, { error: result.error }, corsHeaders(origin));
          }
          return json(res, 200, result.grant, corsHeaders(origin));
        } catch {
          return json(res, 400, { error: "bad_request" }, corsHeaders(origin));
        }
      }
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.writeHead(405, SECURITY_HEADERS).end();
        return;
      }
      if (!hasStatic) {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", ...SECURITY_HEADERS });
        res.end(fallbackPage(req.headers["accept-language"]));
        return;
      }

      let filePath = path.join(staticDir, path.normalize(decodeURIComponent(url.pathname)));
      if (!filePath.startsWith(staticDir + path.sep)) filePath = path.join(staticDir, "index.html");
      if (!existsSync(filePath) || !statSync(filePath).isFile()) filePath = path.join(staticDir, "index.html");
      if (!existsSync(filePath)) {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", ...SECURITY_HEADERS });
        res.end(fallbackPage(req.headers["accept-language"]));
        return;
      }
      res.writeHead(200, {
        "content-type": MIME[path.extname(filePath).toLowerCase()] ?? "application/octet-stream",
        ...SECURITY_HEADERS,
      });
      if (req.method === "HEAD") res.end();
      else createReadStream(filePath).pipe(res);
    } catch {
      if (!res.headersSent) res.writeHead(400, { "content-type": "text/plain; charset=utf-8", ...SECURITY_HEADERS });
      res.end("Bad Request");
    }
  }

  const server = http.createServer((req, res) => void handleHttp(req, res));
  const wss = new WebSocketServer({ noServer: true, maxPayload: config.frameMaxBytes });
  const alive = new WeakMap<WebSocket, boolean>();

  server.on("upgrade", (req, socket, head) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const m = /^\/channel\/([^/?]+)$/.exec(url.pathname);
      const channelId = m?.[1] ?? "";
      const role = url.searchParams.get("role") ?? "";
      const deviceId = url.searchParams.get("device") ?? undefined;
      const safeDeviceId = deviceId && /^[A-Za-z0-9_-]{1,64}$/.test(deviceId) ? deviceId : undefined;
      const reject = (status: number, text: string, reason: string) => {
        // 只记录稳定元数据；绝不能记录完整 URL、查询串、ticket、访问密钥或 Origin 请求头。
        console.warn("[relay] ws upgrade rejected", {
          status,
          reason,
          role: role === "host" || role === "device" ? role : "unknown",
          channelId: CHANNEL_ID_RE.test(channelId) ? channelId : "invalid",
        });
        socket.write(`HTTP/1.1 ${status} ${text}\r\n\r\n`);
        socket.destroy();
      };
      if (!originAllowed(req.headers.origin, req.headers.host, allowedOrigins)) {
        return reject(403, "Forbidden", "origin_denied");
      }
      if (!CHANNEL_ID_RE.test(channelId)) return reject(400, "Bad Request", "invalid_channel");
      if (role !== "host" && role !== "device") return reject(400, "Bad Request", "invalid_role");
      const binding = { channelId, role: role as Role, ...(safeDeviceId ? { deviceId: safeDeviceId } : {}) };
      // 协议 v3：票据无条件必需（票据签发时已完成 host 证明 / 设备令牌验证）
      const ticket = url.searchParams.get("ticket") ?? "";
      if (!ticket || !tickets.consume(ticket, binding)) return reject(401, "Unauthorized", "ticket_required");
      const ip = requestIp(req);
      if (!acquireConnSlot(ip)) return reject(429, "Too Many Requests", "too_many_connections");
      wss.handleUpgrade(req, socket, head, (ws) => {
        ws.once("close", () => releaseConnSlot(ip));
        attach(channelId, role as Role, ws, safeDeviceId);
      });
    } catch {
      socket.destroy();
    }
  });

  function attach(channelId: string, role: Role, ws: WebSocket, deviceId?: string): void {
    const conn: Conn = {
      role,
      ...(deviceId ? { deviceId } : {}),
      send: (data) => sendWithBackpressure(ws, data, maxBufferedBytes),
      close: (code, reason) => ws.close(code, reason),
    };
    const result = core.connect(channelId, role, conn, { deviceId });
    if (!result.ok) return;
    alive.set(ws, true);
    ws.on("pong", () => alive.set(ws, true));
    ws.on("message", (data, isBinary) => {
      if (isBinary) {
        conn.send(JSON.stringify({ t: "relay.error", error: "invalid_frame" }));
        return;
      }
      core.message(channelId, conn, data.toString());
    });
    ws.on("close", () => core.disconnect(channelId, conn));
    ws.on("error", () => core.disconnect(channelId, conn));
  }

  const sweeper = setInterval(() => {
    core.sweep();
    tickets.sweep();
    const now = Date.now();
    for (const [ip, value] of ticketAttempts) if (value.resetAt <= now) ticketAttempts.delete(ip);
  }, 60_000);
  sweeper.unref();
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (alive.get(ws) === false) {
        ws.terminate();
        continue;
      }
      alive.set(ws, false);
      ws.ping();
    }
  }, heartbeatMs);
  heartbeat.unref();

  return {
    server,
    core,
    close: () =>
      new Promise((resolve) => {
        clearInterval(sweeper);
        clearInterval(heartbeat);
        for (const ws of wss.clients) ws.terminate();
        wss.close(() => server.close(() => resolve()));
      }),
  };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  const config = loadConfig();
  const { server, close } = createRelayServer(config);
  server.listen(config.port, () => {
    const accessMode = config.accessKey ? "on" : "off";
    console.log(
      `[relay] listening on :${config.port} static=${path.resolve(config.staticDir)} admission=v3 accessKey=${accessMode}`,
    );
  });
  const shutdown = () => {
    void close().then(() => process.exit(0));
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}
