import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { type AdmissionResult, type RelayIdentity } from "./admission.js";
import { CHANNEL_ID_RE } from "./channel.js";
import { RELAY_TICKET_TTL_MS, type RelayTicketBinding, type RelayTicketGrant } from "./protocol.js";
import type { TicketRequestBody } from "./ticket-request.js";

export type TicketResult = { ok: true; grant: RelayTicketGrant } | { ok: false; error: string };

function secretEquals(actual: string, expected: string): boolean {
  const a = createHash("sha256").update(actual).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

function authorizationKey(header: string | undefined): string {
  const match = /^Bearer\s+(.+)$/i.exec(header?.trim() ?? "");
  return match?.[1]?.trim() ?? "";
}

/**
 * 短期单次票据（协议 v3）：
 * 1. 准入验证——host 必须出示 channel 所有权证明，device 必须出示桌面签发的令牌（admission.ts）；
 * 2. 自托管访问密钥（可选）叠加为 Bearer 门槛；
 * 长期凭据只出现在 HTTPS 请求里，WS URL 只带 30s 单次 ticket。
 */
export class TicketService {
  private readonly tickets = new Map<string, { binding: RelayTicketBinding; expiresAt: number }>();

  constructor(
    private readonly identity: RelayIdentity,
    private readonly accessKey: string | null,
    private readonly now: () => number = Date.now,
  ) {}

  issue(body: TicketRequestBody, authorization: string | undefined): TicketResult {
    if (this.accessKey && !secretEquals(authorizationKey(authorization), this.accessKey)) {
      return { ok: false, error: "unauthorized" };
    }
    const admitted: AdmissionResult =
      body.role === "host"
        ? this.identity.verifyHostProof(body, this.now())
        : this.identity.verifyDeviceGrant(body, this.now());
    if (!admitted.ok) return admitted;
    const binding: RelayTicketBinding = {
      channelId: body.channelId,
      role: body.role,
      ...(body.role === "device" && body.deviceId ? { deviceId: body.deviceId } : {}),
    };
    if (!this.validBinding(binding)) return { ok: false, error: "bad_request" };
    const ticket = randomBytes(32).toString("base64url");
    const grant = { ...binding, ticket, expiresAt: this.now() + RELAY_TICKET_TTL_MS };
    this.tickets.set(ticket, { binding, expiresAt: grant.expiresAt });
    return { ok: true, grant };
  }

  consume(ticket: string, binding: RelayTicketBinding): boolean {
    const record = this.tickets.get(ticket);
    this.tickets.delete(ticket); // 所有路径都单次有效，防重放
    if (!record || record.expiresAt <= this.now()) return false;
    return (
      record.binding.channelId === binding.channelId &&
      record.binding.role === binding.role &&
      record.binding.deviceId === binding.deviceId
    );
  }

  /** 定时清理过期票据（未被消费的票据不应无限堆积） */
  sweep(): void {
    const now = this.now();
    for (const [ticket, record] of this.tickets) if (record.expiresAt <= now) this.tickets.delete(ticket);
  }

  private validBinding(binding: RelayTicketBinding): boolean {
    return (
      CHANNEL_ID_RE.test(binding.channelId) &&
      (binding.role === "host" || binding.role === "device") &&
      (binding.deviceId === undefined || /^[A-Za-z0-9_-]{1,64}$/.test(binding.deviceId))
    );
  }
}
