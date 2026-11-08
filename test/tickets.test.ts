import { describe, expect, it } from "vitest";
import fixture from "./fixtures/relay-admission-v3.json" with { type: "json" };
import { RelayIdentity } from "../src/admission.js";
import { parseTicketBody } from "../src/ticket-request.js";
import { TicketService } from "../src/tickets.js";
import { fakeDesktop, testIdentity } from "./helpers.js";

describe("relay 短时单次票据（协议 v3 准入）", () => {
  it("host 证明签发并绑定 channel/role；单次消费与重放拒绝", () => {
    let now = 1_000_000;
    const identity = testIdentity();
    const desktop = fakeDesktop();
    const service = new TicketService(identity, null, () => now);
    const body = parseTicketBody(desktop.hostTicketBody(identity.publicKey, now));
    expect(body).not.toBeNull();
    const issued = service.issue(body!, undefined);
    expect(issued.ok).toBe(true);
    if (!issued.ok) return;
    const binding = { channelId: desktop.channelId, role: "host" as const };
    expect(service.consume(issued.grant.ticket, binding)).toBe(true);
    expect(service.consume(issued.grant.ticket, binding)).toBe(false); // 重放
    now += 1;
  });

  it("设备令牌签发并绑定 deviceId；错误绑定与票据过期拒绝", () => {
    let now = 1_000_000;
    const identity = testIdentity();
    const desktop = fakeDesktop();
    const service = new TicketService(identity, null, () => now);
    const body = parseTicketBody(desktop.deviceTicketBody(identity.publicKey, "phone", now + 60_000))!;
    const issued = service.issue(body, undefined);
    expect(issued.ok).toBe(true);
    if (!issued.ok) return;
    const binding = { channelId: desktop.channelId, role: "device" as const, deviceId: "phone" };
    expect(service.consume(issued.grant.ticket, { ...binding, deviceId: "other" })).toBe(false);
    const second = service.issue(body, undefined);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    now += 30_001;
    expect(service.consume(second.grant.ticket, binding)).toBe(false);
  });

  it("host 证明：错 channel / 错 relay 密钥 / 时间戳超偏差 一律拒绝", () => {
    const now = 1_000_000;
    const identity = testIdentity();
    const other = testIdentity();
    const desktop = fakeDesktop();
    const service = new TicketService(identity, null, () => now);
    const good = desktop.hostTicketBody(identity.publicKey, now);
    expect(service.issue(parseTicketBody(good)!, undefined).ok).toBe(true);
    // channelId 与 hostPk 不对应（冒充别人的 channel）
    const stranger = fakeDesktop();
    expect(service.issue(parseTicketBody({ ...good, channelId: stranger.channelId })!, undefined)).toEqual({
      ok: false,
      error: "proof_invalid",
    });
    // 用别的 relay 公钥算的证明
    expect(service.issue(parseTicketBody(desktop.hostTicketBody(other.publicKey, now))!, undefined)).toEqual({
      ok: false,
      error: "proof_invalid",
    });
    // 时钟偏差超过 5 分钟
    expect(service.issue(parseTicketBody(desktop.hostTicketBody(identity.publicKey, now - 301_000))!, undefined)).toEqual({
      ok: false,
      error: "proof_expired",
    });
  });

  it("设备令牌：过期 / deviceId 不符 / 配对令牌带 deviceId 一律拒绝", () => {
    const now = 1_000_000;
    const identity = testIdentity();
    const desktop = fakeDesktop();
    const service = new TicketService(identity, null, () => now);
    expect(
      service.issue(parseTicketBody(desktop.deviceTicketBody(identity.publicKey, "phone", now - 1))!, undefined),
    ).toEqual({ ok: false, error: "grant_expired" });
    const body = desktop.deviceTicketBody(identity.publicKey, "phone", now + 60_000);
    expect(service.issue(parseTicketBody({ ...body, deviceId: "other" })!, undefined)).toEqual({
      ok: false,
      error: "grant_invalid",
    });
    // 配对令牌（subject "pair"）只能换无 deviceId 的票据
    const pair = desktop.deviceTicketBody(identity.publicKey, undefined, now + 60_000);
    expect(service.issue(parseTicketBody(pair)!, undefined).ok).toBe(true);
    expect(service.issue(parseTicketBody({ ...pair, deviceId: "phone" })!, undefined)).toEqual({
      ok: false,
      error: "grant_invalid",
    });
  });

  it("自托管访问密钥叠加为 Bearer 门槛：缺/错密钥 401，正确密钥仍需准入证明", () => {
    const now = 1_000_000;
    const identity = testIdentity();
    const desktop = fakeDesktop();
    const service = new TicketService(identity, "secret", () => now);
    const body = parseTicketBody(desktop.hostTicketBody(identity.publicKey, now))!;
    expect(service.issue(body, undefined)).toEqual({ ok: false, error: "unauthorized" });
    expect(service.issue(body, "Bearer wrong")).toEqual({ ok: false, error: "unauthorized" });
    expect(service.issue(body, "Bearer secret").ok).toBe(true);
    const forged = parseTicketBody({ ...desktop.hostTicketBody(identity.publicKey, now), proof: "AAAA" })!;
    expect(service.issue(forged, "Bearer secret")).toEqual({ ok: false, error: "proof_invalid" });
  });

  it("共享跨实现向量：Node relay 验证 shared 生成的 host proof 与设备令牌", () => {
    const identity = RelayIdentity.fromSecretKey(fixture.relaySk);
    expect(identity.publicKey).toBe(fixture.relayPk);
    expect(
      identity.verifyHostProof(
        {
          channelId: fixture.channelId,
          hostPk: fixture.desktopPk,
          ts: fixture.hostProof.ts,
          proof: fixture.hostProof.proof,
        },
        fixture.hostProof.ts,
      ),
    ).toEqual({ ok: true });
    expect(
      identity.verifyDeviceGrant(
        {
          channelId: fixture.channelId,
          hostPk: fixture.desktopPk,
          deviceId: fixture.deviceGrant.subject,
          grant: { exp: fixture.deviceGrant.exp, mac: fixture.deviceGrant.mac },
        },
        fixture.deviceGrant.exp - 1,
      ),
    ).toEqual({ ok: true });
    expect(
      identity.verifyDeviceGrant(
        {
          channelId: fixture.channelId,
          hostPk: fixture.desktopPk,
          grant: fixture.pairGrant,
        },
        fixture.pairGrant.exp - 1,
      ),
    ).toEqual({ ok: true });
  });

  it("请求体形状严格校验；relay 身份从环境读取且生产模式缺失即报错", () => {
    expect(parseTicketBody({ channelId: "a".repeat(64), role: "device", deviceId: "phone" })).toBeNull(); // 无 hostPk/grant
    expect(parseTicketBody({ channelId: "a".repeat(64), role: "admin", hostPk: "AA==" })).toBeNull();
    const identity = testIdentity();
    const fromEnv = RelayIdentity.fromEnv({ RELAY_SECRET_KEY: Buffer.alloc(32, 7).toString("base64") }, () => {});
    expect(fromEnv.publicKey).toHaveLength(44);
    expect(() => RelayIdentity.fromEnv({ NODE_ENV: "production" }, () => {})).toThrow(/RELAY_SECRET_KEY/);
    expect(() => RelayIdentity.fromEnv({ RELAY_SECRET_KEY: "short" }, () => {})).toThrow(/32-byte/);
    expect(identity.publicKey).not.toBe(fromEnv.publicKey);
  });
});
