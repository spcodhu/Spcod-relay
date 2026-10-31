import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { CHANNEL_ID_RE } from "./channel.js";
import { RELAY_TICKET_TTL_MS, type RelayTicketBinding, type RelayTicketGrant } from "./protocol.js";

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

/** 短期单次票据：长期访问密钥只出现在 HTTPS Authorization 头，不进入 WS URL。 */
export class TicketService {
  private readonly tickets = new Map<string, { binding: RelayTicketBinding; expiresAt: number }>();

  constructor(
    private readonly accessKey: string | null,
    private readonly now: () => number = Date.now,
  ) {}

  issue(binding: RelayTicketBinding, authorization: string | undefined): TicketResult {
    if (!this.validBinding(binding)) return { ok: false, error: "bad_request" };
    if (this.accessKey && !secretEquals(authorizationKey(authorization), this.accessKey)) {
      return { ok: false, error: "unauthorized" };
    }
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

  private validBinding(binding: RelayTicketBinding): boolean {
    return (
      CHANNEL_ID_RE.test(binding.channelId) &&
      (binding.role === "host" || binding.role === "device") &&
      (binding.deviceId === undefined || /^[A-Za-z0-9_-]{1,64}$/.test(binding.deviceId))
    );
  }
}
