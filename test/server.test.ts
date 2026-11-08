import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { RelayIdentity } from "../src/admission.js";
import { createRelayServer, loadConfig, type RelayConfig, type RelayServer } from "../src/index.js";
import { type FakeDesktop, fakeDesktop } from "./helpers.js";

/** 每个 describe 一把固定 relay 身份，便于桌面侧预先算好证明 */
const identity = RelayIdentity.generate();

function config(overrides: Partial<RelayConfig> = {}): RelayConfig {
  return {
    port: 0,
    staticDir: path.join(tmpdir(), "spcode-relay-test-nonexistent"),
    queueMax: 1000,
    queueTtlMs: 72 * 3600 * 1000,
    frameMaxBytes: 256 * 1024,
    ratePerSec: 60,
    identity,
    ...overrides,
  };
}

async function postTicket(
  base: string,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(`http://${base}/v1/tickets`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function ticketFor(base: string, body: Record<string, unknown>, headers: Record<string, string> = {}): Promise<string> {
  const res = await postTicket(base, body, headers);
  if (res.status !== 200) throw new Error(`ticket ${res.status}`);
  const grant = (await res.json()) as { ticket: string };
  return encodeURIComponent(grant.ticket);
}

/** 以 host 身份完成 v3 准入并建连 */
async function connectHost(base: string, desktop: FakeDesktop, accessKey?: string): Promise<TestClient> {
  const ticket = await ticketFor(
    base,
    desktop.hostTicketBody(identity.publicKey),
    accessKey ? { authorization: `Bearer ${accessKey}` } : {},
  );
  return connect(base, `/channel/${desktop.channelId}?role=host&ticket=${ticket}`);
}

/** 以 device 身份（可带 deviceId）凭桌面令牌建连 */
async function connectDevice(base: string, desktop: FakeDesktop, deviceId?: string): Promise<TestClient> {
  const ticket = await ticketFor(base, desktop.deviceTicketBody(identity.publicKey, deviceId));
  const dev = deviceId ? `&device=${encodeURIComponent(deviceId)}` : "";
  return connect(base, `/channel/${desktop.channelId}?role=device${dev}&ticket=${ticket}`);
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
    expect(await res.json()).toEqual({ ok: true, version: 3 });
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
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("default-src 'self'");
    expect(csp).toMatch(/script-src 'self';/);
    expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/);
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

describe("部署配置", () => {
  it("访问密钥可选叠加；relay 身份来自 RELAY_SECRET_KEY；per-IP 上限可配", () => {
    const secret = Buffer.alloc(32, 9).toString("base64");
    const cfg = loadConfig({ RELAY_ACCESS_KEY: " secret ", RELAY_SECRET_KEY: secret, MAX_CONNS_PER_IP: "5" });
    expect(cfg.accessKey).toBe("secret");
    expect(cfg.identity?.publicKey).toBe(RelayIdentity.fromSecretKey(secret).publicKey);
    expect(cfg.maxConnsPerIp).toBe(5);
    const open = loadConfig({ RELAY_SECRET_KEY: secret });
    expect(open.accessKey).toBeNull();
  });
});

describe("relay-info", () => {
  it("GET /v1/relay-info 返回协议版本与 relay 公钥，带 CORS", async () => {
    const { relay, base } = await start(config({ corsAllowedOrigins: ["https://pwa.example"] }));
    try {
      const res = await fetch(`http://${base}/v1/relay-info`, { headers: { origin: "https://pwa.example" } });
      expect(res.status).toBe(200);
      expect(res.headers.get("access-control-allow-origin")).toBe("https://pwa.example");
      expect(await res.json()).toEqual({ version: 3, relayPk: identity.publicKey });
      const denied = await fetch(`http://${base}/v1/relay-info`, { headers: { origin: "https://evil.example" } });
      expect(denied.status).toBe(403);
    } finally {
      await relay.close();
    }
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

  it("非法 channelId / role 在升级阶段以 400 拒绝；无票据 401", async () => {
    const desktop = fakeDesktop();
    for (const url of ["/channel/not-hex?role=host", `/channel/${desktop.channelId}?role=admin`, "/other/path?role=host"]) {
      await expect(connect(base, url)).rejects.toThrow(/400/);
    }
    await expect(connect(base, `/channel/${desktop.channelId}?role=host`)).rejects.toThrow(/401/);
    await expect(connect(base, `/channel/${desktop.channelId}?role=device`)).rejects.toThrow(/401/);
  });

  it("host↔device 全链路：hello 在前，业务帧原样送达", async () => {
    const desktop = fakeDesktop();
    const host = await connectHost(base, desktop);
    const helloHost = JSON.parse(await host.next());
    expect(helloHost).toEqual({ t: "relay.hello", role: "host", queued: 0, version: 3 });

    const dev = await connectDevice(base, desktop, "phone");
    const helloDev = JSON.parse(await dev.next());
    expect(helloDev).toEqual({ t: "relay.hello", role: "device", queued: 0, version: 3 });

    const frame = JSON.stringify({ id: "x", seq: 1, t: "encrypted", c: "AA==", deviceId: "phone" });
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

  it("第二个 host（同一桌面身份）接管 channel：旧连接收 4001，新连接收 hello 与补投", async () => {
    const desktop = fakeDesktop();
    const dev = await connectDevice(base, desktop, "phone");
    await dev.next(); // hello
    const h1 = await connectHost(base, desktop);
    await h1.next(); // hello

    const h2 = await connectHost(base, desktop);
    expect(await h1.closed).toBe(4001);
    expect(JSON.parse(await h2.next())).toMatchObject({ t: "relay.hello", role: "host" });
    // 新 host 正常收发
    const toHost = h2.next();
    dev.ws.send('{"t":"auth","deviceId":"phone"}');
    expect(await toHost).toBe('{"t":"auth","deviceId":"phone"}');
    h2.ws.close();
    dev.ws.close();
    await Promise.all([h2.closed, dev.closed]);
  });

  it("离线消息经真实链路补投", async () => {
    const desktop = fakeDesktop();
    const dev = await connectDevice(base, desktop, "phone");
    await dev.next(); // hello
    dev.ws.send("offline-1");
    await new Promise((r) => setTimeout(r, 50));

    const host = await connectHost(base, desktop);
    const hello = JSON.parse(await host.next());
    expect(hello).toEqual({ t: "relay.hello", role: "host", queued: 1, version: 3 });
    expect(await host.next()).toBe("offline-1");

    host.ws.close();
    dev.ws.close();
    await Promise.all([host.closed, dev.closed]);
  });

  it("票据单次有效：重放 401；错 channel 的票据 401", async () => {
    const desktop = fakeDesktop();
    const ticket = await ticketFor(base, desktop.deviceTicketBody(identity.publicKey, "phone"));
    const dev = await connect(base, `/channel/${desktop.channelId}?role=device&device=phone&ticket=${ticket}`);
    await dev.next();
    dev.ws.close();
    await dev.closed;
    await expect(
      connect(base, `/channel/${desktop.channelId}?role=device&device=phone&ticket=${ticket}`),
    ).rejects.toThrow(/401/);
    const other = fakeDesktop();
    const t2 = await ticketFor(base, desktop.deviceTicketBody(identity.publicKey, "phone"));
    await expect(connect(base, `/channel/${other.channelId}?role=device&device=phone&ticket=${t2}`)).rejects.toThrow(
      /401/,
    );
  });

  it("票据接口：伪造证明 401，形状错误 400", async () => {
    const desktop = fakeDesktop();
    const forged = { ...desktop.hostTicketBody(identity.publicKey), proof: Buffer.alloc(32, 1).toString("base64") };
    expect((await postTicket(base, forged)).status).toBe(401);
    expect((await postTicket(base, { channelId: desktop.channelId, role: "host" })).status).toBe(400);
    const expired = desktop.deviceTicketBody(identity.publicKey, "phone", Date.now() - 1);
    const res = await postTicket(base, expired);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "grant_expired" });
  });
});

describe("票据与生产连接治理", () => {
  it("自托管访问密钥叠加：无 Bearer 401；正确 Bearer + 证明放行", async () => {
    const { relay, base } = await start(config({ accessKey: "secret" }));
    try {
      const desktop = fakeDesktop();
      const denied = await postTicket(base, desktop.hostTicketBody(identity.publicKey));
      expect(denied.status).toBe(401);
      const host = await connectHost(base, desktop, "secret");
      expect(JSON.parse(await host.next())).toMatchObject({ t: "relay.hello", version: 3 });
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
      const desktop = fakeDesktop();
      await expect(connect(base, `/channel/${desktop.channelId}?role=device&ticket=client-ticket-secret`)).rejects.toThrow(
        /401/,
      );
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

  it("per-IP 连接上限：第 N+1 条以 429 拒绝，断开后恢复", async () => {
    const { relay, base } = await start(config({ maxConnsPerIp: 2 }));
    try {
      const desktop = fakeDesktop();
      const a = await connectDevice(base, desktop, "a");
      const b = await connectDevice(base, desktop, "b");
      await Promise.all([a.next(), b.next()]);
      await expect(connectDevice(base, desktop, "c")).rejects.toThrow(/429/);
      a.ws.close();
      await a.closed;
      await new Promise((r) => setTimeout(r, 20));
      const c = await connectDevice(base, desktop, "c");
      await c.next();
      b.ws.close();
      c.ws.close();
      await Promise.all([b.closed, c.closed]);
    } finally {
      await relay.close();
    }
  });

  it("限流按连接：一台设备刷爆不影响另一台与 host", async () => {
    const { relay, base } = await start(config({ ratePerSec: 2 }));
    try {
      const desktop = fakeDesktop();
      const host = await connectHost(base, desktop);
      await host.next();
      const noisy = await connectDevice(base, desktop, "noisy");
      await noisy.next();
      const quiet = await connectDevice(base, desktop, "quiet");
      await quiet.next();
      for (let i = 0; i < 5; i++) noisy.ws.send(`n${i}`);
      // 被限流的设备收到 relay.error，host 只收到前 2 帧
      let limited = false;
      for (let i = 0; i < 3; i++) {
        if (JSON.parse(await noisy.next()).error === "rate_limited") limited = true;
      }
      expect(limited).toBe(true);
      expect(await host.next()).toBe("n0");
      expect(await host.next()).toBe("n1");
      const fromQuiet = host.next();
      quiet.ws.send("q0");
      expect(await fromQuiet).toBe("q0");
      host.ws.close();
      noisy.ws.close();
      quiet.ws.close();
      await Promise.all([host.closed, noisy.closed, quiet.closed]);
    } finally {
      await relay.close();
    }
  });

  it("ping/pong 保持活跃连接", async () => {
    const { relay, base } = await start(config({ heartbeatMs: 20 }));
    try {
      const desktop = fakeDesktop();
      const host = await connectHost(base, desktop);
      await host.next();
      const dev = await connectDevice(base, desktop, "phone");
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
