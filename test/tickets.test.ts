import { describe, expect, it } from "vitest";
import { parseTicketBody } from "../src/ticket-request.js";
import { TicketService } from "../src/tickets.js";

const binding = { channelId: "a".repeat(64), role: "device" as const, deviceId: "phone" };

describe("relay 短时单次票据", () => {
  it("正确密钥签发并绑定 channel/role/device；单次消费与重放拒绝", () => {
    let now = 1_000;
    const service = new TicketService("secret", () => now);
    const issued = service.issue(binding, "Bearer secret");
    expect(issued.ok).toBe(true);
    if (!issued.ok) return;
    expect(service.consume(issued.grant.ticket, binding)).toBe(true);
    expect(service.consume(issued.grant.ticket, binding)).toBe(false); // 重放
  });

  it("错误密钥、错误绑定和过期均拒绝", () => {
    let now = 1_000;
    const service = new TicketService("secret", () => now);
    expect(service.issue(binding, "Bearer wrong").ok).toBe(false);
    const issued = service.issue(binding, "Bearer secret");
    expect(issued.ok).toBe(true);
    if (!issued.ok) return;
    expect(service.consume(issued.grant.ticket, { ...binding, deviceId: "other" })).toBe(false);
    const second = service.issue(binding, "Bearer secret");
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    now += 30_001;
    expect(service.consume(second.grant.ticket, binding)).toBe(false);
  });

  it("官方匿名模式无需 Authorization，但请求结构仍严格校验", () => {
    const service = new TicketService(null);
    expect(service.issue(binding, undefined).ok).toBe(true);
    expect(service.issue({ ...binding, channelId: "bad" }, undefined)).toEqual({ ok: false, error: "bad_request" });
    expect(parseTicketBody(binding)).toEqual(binding);
    expect(parseTicketBody({ ...binding, role: "admin" })).toBeNull();
  });
});
