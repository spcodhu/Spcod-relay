import { createReadStream, existsSync, statSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket, WebSocketServer } from "ws";
import { CHANNEL_ID_RE, type Conn, RelayCore, type Role } from "./channel.js";

/** 日志纪律：relay 只记录元数据（连接/端口/数量），绝不记录帧内容。 */

export interface RelayConfig {
  port: number;
  staticDir: string;
  queueMax: number;
  queueTtlMs: number;
  frameMaxBytes: number;
  ratePerSec: number;
  /** 全局 channel 数上限（任意 64-hex 即建 channel 是 DoS 面） */
  maxChannels: number;
  /** 每 channel 设备数上限 */
  maxDevices: number;
  /** 全局离线队列总字节预算 */
  queueBytesMax: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): RelayConfig {
  const int = (v: string | undefined, dflt: number): number => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : dflt;
  };
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

const NO_STATIC_PAGE = `<!doctype html><html lang="zh-CN"><meta charset="utf-8">
<title>Spcod Relay</title><body style="font-family:system-ui;max-width:40em;margin:4em auto;padding:0 1em">
<h1>Spcod Relay 运行中</h1>
<p>这是一个零知识哑中继：它只按 channel 路由端到端加密的数据，看不到任何明文内容。</p>
<p>此实例未托管手机端 PWA（STATIC_DIR 不存在）。请在客户端中直接填入本 relay 地址，或部署 PWA 构建产物后刷新。</p>
</body></html>`;

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

  const server = http.createServer((req, res) => {
    // 评审 R3-C9：decodeURIComponent/URL 解析必须容错——`GET /%` 曾是未捕获异常直接打崩进程
    try {
      const url = new URL(req.url ?? "/", "http://localhost");

      if (url.pathname === "/health") {
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, channels: core.channelCount() }));
        return;
      }
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.writeHead(405).end();
        return;
      }
      if (!hasStatic) {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(NO_STATIC_PAGE);
        return;
      }

      // 静态资源；防目录穿越；找不到时 SPA fallback 到 index.html
      let filePath = path.join(staticDir, path.normalize(decodeURIComponent(url.pathname)));
      if (!filePath.startsWith(staticDir + path.sep)) filePath = path.join(staticDir, "index.html");
      if (!existsSync(filePath) || !statSync(filePath).isFile()) {
        filePath = path.join(staticDir, "index.html");
      }
      if (!existsSync(filePath)) {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(NO_STATIC_PAGE);
        return;
      }
      res.writeHead(200, { "content-type": MIME[path.extname(filePath).toLowerCase()] ?? "application/octet-stream" });
      if (req.method === "HEAD") res.end();
      else createReadStream(filePath).pipe(res);
    } catch {
      // 畸形请求（非法 % 转义、坏 URL）：400 而不是进程崩溃
      if (!res.headersSent) res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
      res.end("Bad Request");
    }
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: config.frameMaxBytes });

  server.on("upgrade", (req, socket, head) => {
    // 畸形请求不能打崩进程（评审 R3-C9）
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const m = /^\/channel\/([^/?]+)$/.exec(url.pathname);
      const channelId = m?.[1] ?? "";
      const role = url.searchParams.get("role") ?? "";
      // 设备可声明 deviceId（离线队列按设备分槽补投；缺省兼容旧客户端，收 "*" 槽）
      const deviceId = url.searchParams.get("device") ?? undefined;
      const safeDeviceId = deviceId && /^[A-Za-z0-9_-]{1,64}$/.test(deviceId) ? deviceId : undefined;
      if (!CHANNEL_ID_RE.test(channelId) || (role !== "host" && role !== "device")) {
        socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        attach(channelId, role as Role, ws, safeDeviceId);
      });
    } catch {
      socket.destroy();
    }
  });

  function attach(channelId: string, role: Role, ws: WebSocket, deviceId?: string): void {
    const conn: Conn = {
      role,
      send: (data) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(data);
      },
      close: (code, reason) => ws.close(code, reason),
    };
    const result = core.connect(channelId, role, conn, { deviceId });
    if (!result.ok) return; // host 冲突：core 已以 4001 关闭
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

  // 过期帧清理（不阻止进程退出）
  const sweeper = setInterval(() => core.sweep(), 60_000);
  sweeper.unref();

  return {
    server,
    core,
    close: () =>
      new Promise((resolve) => {
        clearInterval(sweeper);
        for (const ws of wss.clients) ws.terminate();
        wss.close(() => server.close(() => resolve()));
      }),
  };
}

// 直接运行（node dist/index.js）时启动服务
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  const config = loadConfig();
  const { server } = createRelayServer(config);
  server.listen(config.port, () => {
    console.log(`[relay] listening on :${config.port} static=${path.resolve(config.staticDir)}`);
  });
}
