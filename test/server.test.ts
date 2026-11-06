import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { createRelayServer, loadConfig, type RelayConfig, type RelayServer } from "../src/index.js";

const CID = "b".repeat(64);

function config(overrides: Partial<RelayConfig> = {}): RelayConfig {
  return {
    port: 0,
    staticDir: path.join(tmpdir(), "spcode-relay-test-nonexistent"),
    queueMax: 1000,
    queueTtlMs: 72 * 3600 * 1000,
    frameMaxBytes: 256 * 1024,
    ratePerSec: 60,
    ...overrides,
  };
}

async function start(cfg: RelayConfig): Promise<{ relay: RelayServer; base: string }> {
  const relay = createRelayServer(cfg);
  await new Promise<void>((resolve) => relay.server.listen(0, "127.0.0.1", resolve));
  const addr = relay.server.address();
  if (!addr || typeof addr === "string") throw new Error("no address");
  return { relay, base: `127.0.0.1:${addr.port}` };
}

/** 构造即挂监听并缓冲消息，避免 open 与首帧同包到达时丢帧。 */
class TestClient {
  private buf: string[] = [];
  private pending: ((s: string) => void)[] = [];
  readonly closed: Promise<number>;

  constructor(readonly ws: WebSocket) {
    ws.on("message", (d) => {
      const s = d.toString();
      const w = this.pending.shift();
      if (w) w(s);
      else this.buf.push(s);
    });
    this.closed = new Promise((resolve) => ws.once("close", (code) => resolve(code)));
  }

  next(): Promise<string> {
    const s = this.buf.shift();
    return s !== undefined ? Promise.resolve(s) : new Promise((r) => this.pending.push(r));
  }
}

async function connect(base: string, url: string): Promise<TestClient> {
  const ws = new WebSocket(`ws://${base}${url}`);
  const client = new TestClient(ws);
  await new Promise<void>((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  return client;
}

describe("HTTP 服务", () => {
  let relay: RelayServer;
  let base: string;
  let staticDir: string;

  beforeAll(async () => {
    staticDir = await mkdtemp(path.join(tmpdir(), "spcode-relay-static-"));
    await writeFile(path.join(staticDir, "index.html"), "<h1>pwa</h1>");
    await writeFile(path.join(staticDir, "app.js"), "console.log(1)");
    ({ relay, base } = await start(config({ staticDir })));
  });

  afterAll(async () => {
    await relay.close();
    await rm(staticDir, { recursive: true, force: true });
  });

  it("GET /health 为命令行与自动化返回 JSON", async () => {
    const res = await fetch(`http://${base}/health`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({ ok: true, version: 2 });
  });

  it("GET /health 为浏览器返回中英文健康页面", async () => {
    const english = await fetch(`http://${base}/health`, {
      headers: { accept: "text/html,application/xhtml+xml", "accept-language": "en-US,en;q=0.9" },
    });
    expect(english.status).toBe(200);
    expect(english.headers.get("content-type")).toContain("text/html");
    expect(english.headers.get("cache-control")).toBe("no-store");
    const englishPage = await english.text();
    expect(englishPage).toContain("Service is operational");
    expect(englishPage).toContain("Protocol version");
    expect(englishPage).not.toMatch(/[\u4e00-\u9fff]/);

    const chinese = await fetch(`http://${base}/health`, { headers: { accept: "text/html" } });
    expect(await chinese.text()).toContain("服务运行正常");
  });

  it("静态资源按 MIME 服务", async () => {
    const res = await fetch(`http://${base}/app.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("javascript");
    expect(res.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await res.text()).toBe("console.log(1)");
  });

  it("未知路径 SPA fallback 到 index.html；拒绝目录穿越", async () => {
    const spa = await fetch(`http://${base}/session/abc`);
    expect(await spa.text()).toBe("<h1>pwa</h1>");
    const evil = await fetch(`http://${base}/../../etc/passwd`);
    expect(await evil.text()).toBe("<h1>pwa</h1>");
  });

  it("畸形 URL（GET /%）返回 400 而不是打崩进程（评审 R3-C9）", async () => {
    // 原生 http 客户端绕过 fetch 的 URL 预解析（fetch 自己会拒），直发畸形请求行
    const res = await new Promise<{ status: number }>((resolvePromise, rejectPromise) => {
      const req = httpRequest(`http://${base}/%`, (r) => {
        r.resume();
        resolvePromise({ status: r.statusCode ?? 0 });
      });
      req.on("error", rejectPromise);
      req.end();
    });
    expect(res.status).toBe(400);
    // 进程还活着：health 正常
    const health = await fetch(`http://${base}/health`);
    expect(health.status).toBe(200);
  });
});

describe("无静态目录时", () => {
  it("GET / 返回简短说明页", async () => {
    const { relay, base } = await start(config());
    try {
      const res = await fetch(`http://${base}/`);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("零知识哑中继");
      const english = await fetch(`http://${base}/`, { headers: { "accept-language": "en-US,en;q=0.9" } });
      const page = await english.text();
      expect(page).toContain('lang="en"');
      expect(page).not.toMatch(/[\u4e00-\u9fff]/);
      expect(page).toContain("zero-knowledge relay");
    } finally {
      await relay.close();
    }
  });
});

describe("认证部署配置", () => {
  it("默认保留自托管访问密钥与 ALLOW_LEGACY_WS 行为", () => {
    const cfg = loadConfig({ RELAY_ACCESS_KEY: " secret ", ALLOW_LEGACY_WS: "false" });
    expect(cfg.allowAnonymous).toBe(false);
    expect(cfg.accessKey).toBe("secret");
    expect(cfg.allowLegacyWs).toBe(false);
  });

  it("显式匿名模式忽略遗留密钥并兼容官方无 ticket 客户端", () => {
    const cfg = loadConfig({
      RELAY_ALLOW_ANONYMOUS: "true",
      RELAY_ACCESS_KEY: "old-secret",
      ALLOW_LEGACY_WS: "false",
    });
    expect(cfg.allowAnonymous).toBe(true);
    expect(cfg.accessKey).toBeNull();
    expect(cfg.allowLegacyWs).toBe(true);
  });
});

describe("WebSocket 协议", () => {
  let relay: RelayServer;
  let base: string;

  beforeAll(async () => {
    ({ relay, base } = await start(config()));
  });

  afterAll(async () => {
    await relay.close();
  });

  it("非法 channelId / role 在升级阶段以 400 拒绝", async () => {
    for (const url of ["/channel/not-hex?role=host", `/channel/${CID}?role=admin`, "/other/path?role=host"]) {
      await expect(connect(base, url)).rejects.toThrow(/400/);
    }
  });

  it("host↔device 全链路：hello 在前，业务帧原样送达", async () => {
    const host = await connect(base, `/channel/${CID}?role=host`);
    const helloHost = JSON.parse(await host.next());
    expect(helloHost).toEqual({ t: "relay.hello", role: "host", queued: 0, version: 2 });

    const dev = await connect(base, `/channel/${CID}?role=device`);
    const helloDev = JSON.parse(await dev.next());
    expect(helloDev).toEqual({ t: "relay.hello", role: "device", queued: 0, version: 2 });

    const frame = JSON.stringify({ id: "x", seq: 1, t: "encrypted", c: "AA==" });
    const got = dev.next();
    host.ws.send(frame);
    expect(await got).toBe(frame);

    const back = host.next();
    dev.ws.send('{"t":"pair"}');
    expect(await back).toBe('{"t":"pair"}');

    host.ws.close();
    dev.ws.close();
    await Promise.all([host.closed, dev.closed]);
  });

  it("第二个 host 被 close code 4001 拒绝", async () => {
    const cid = "c".repeat(64);
    const h1 = await connect(base, `/channel/${cid}?role=host`);
    await h1.next(); // hello

    const h2 = await connect(base, `/channel/${cid}?role=host`);
    expect(await h2.closed).toBe(4001);
    expect(h1.ws.readyState).toBe(WebSocket.OPEN); // 旧 host 不受影响
    h1.ws.close();
    await h1.closed;
  });

  it("离线消息经真实链路补投", async () => {
    const cid = "d".repeat(64);
    const dev = await connect(base, `/channel/${cid}?role=device`);
    await dev.next(); // hello
    dev.ws.send("offline-1");
    await new Promise((r) => setTimeout(r, 50));

    const host = await connect(base, `/channel/${cid}?role=host`);
    const hello = JSON.parse(await host.next());
    expect(hello).toEqual({ t: "relay.hello", role: "host", queued: 1, version: 2 });
    expect(await host.next()).toBe("offline-1");

    host.ws.close();
    dev.ws.close();
    await Promise.all([host.closed, dev.closed]);
  });
});

describe("票据与生产连接治理", () => {
  it("访问密钥 → 单次 ticket 建连；无 ticket 与重放均拒绝", async () => {
    const { relay, base } = await start(config({ accessKey: "secret" }));
    try {
      const body = JSON.stringify({ channelId: CID, role: "device", deviceId: "phone" });
      const denied = await fetch(`http://${base}/v1/tickets`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
      expect(denied.status).toBe(401);
      const issued = await fetch(`http://${base}/v1/tickets`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer secret" },
        body,
      });
      expect(issued.status).toBe(200);
      const grant = (await issued.json()) as { ticket: string; expiresAt: number };
      expect(grant.ticket).toBeTruthy();
      const dev = await connect(base, `/channel/${CID}?role=device&device=phone&ticket=${encodeURIComponent(grant.ticket)}`);
      expect(JSON.parse(await dev.next())).toMatchObject({ t: "relay.hello", version: 2 });
      dev.ws.close();
      await dev.closed;
      await expect(
        connect(base, `/channel/${CID}?role=device&device=phone&ticket=${encodeURIComponent(grant.ticket)}`),
      ).rejects.toThrow(/401/);
      await expect(connect(base, `/channel/${CID}?role=device`)).rejects.toThrow(/401/);
    } finally {
      await relay.close();
    }
  });

  it("官方匿名模式忽略残留旧密钥，无 ticket 也能完成 WS 握手", async () => {
    const { relay, base } = await start(
      config({ accessKey: "old-secret", allowAnonymous: true, allowLegacyWs: false }),
    );
    try {
      const host = await connect(base, `/channel/${CID}?role=host`);
      expect(JSON.parse(await host.next())).toMatchObject({ t: "relay.hello", role: "host", version: 2 });
      host.ws.close();
      await host.closed;
    } finally {
      await relay.close();
    }
  });

  it("WS 401 日志记录原因元数据但不泄露 ticket、密钥或查询串", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { relay, base } = await start(config({ accessKey: "server-secret" }));
    try {
      await expect(connect(base, `/channel/${CID}?role=device&ticket=client-ticket-secret`)).rejects.toThrow(/401/);
      const output = warn.mock.calls
        .map((call) => call.map((value) => (typeof value === "string" ? value : JSON.stringify(value))).join(" "))
        .join("\n");
      expect(output).toContain("ticket_required");
      expect(output).toContain('"status":401');
      expect(output).not.toContain("client-ticket-secret");
      expect(output).not.toContain("server-secret");
      expect(output).not.toContain("ticket=");
    } finally {
      await relay.close();
      warn.mockRestore();
    }
  });

  it("ping/pong 保持活跃连接", async () => {
    const { relay, base } = await start(config({ heartbeatMs: 20 }));
    try {
      const host = await connect(base, `/channel/${CID}?role=host`);
      await host.next();
      const dev = await connect(base, `/channel/${CID}?role=device`);
      await dev.next();
      await new Promise((resolve) => setTimeout(resolve, 70));
      expect(dev.ws.readyState).toBe(WebSocket.OPEN);
      host.ws.terminate();
      dev.ws.terminate();
    } finally {
      await relay.close();
    }
  });
});
