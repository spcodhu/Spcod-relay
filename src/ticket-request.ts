/**
 * POST /v1/tickets 请求体（协议 v3）：
 * - host：{channelId, role:"host", hostPk, ts, proof}
 * - device：{channelId, role:"device", deviceId?, hostPk, grant:{exp, mac}}
 * 这里只做形状校验；密码学验证在 admission.ts。
 */
import type { RelayDeviceGrant } from "./protocol.js";

export type TicketRequestBody =
  | { channelId: string; role: "host"; hostPk: string; ts: number; proof: string }
  | { channelId: string; role: "device"; deviceId?: string; hostPk: string; grant: RelayDeviceGrant };

const B64_RE = /^[A-Za-z0-9+/]+=*$/;

function isB64(value: unknown, maxLen = 128): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLen && B64_RE.test(value);
}

export function parseTicketBody(value: unknown): TicketRequestBody | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  if (typeof body.channelId !== "string" || !isB64(body.hostPk)) return null;
  if (body.role === "host") {
    if (typeof body.ts !== "number" || !Number.isInteger(body.ts) || !isB64(body.proof)) return null;
    return { channelId: body.channelId, role: "host", hostPk: body.hostPk, ts: body.ts, proof: body.proof };
  }
  if (body.role === "device") {
    if (body.deviceId !== undefined && typeof body.deviceId !== "string") return null;
    const grant = body.grant as Record<string, unknown> | undefined;
    if (!grant || typeof grant !== "object") return null;
    if (typeof grant.exp !== "number" || !Number.isInteger(grant.exp) || !isB64(grant.mac)) return null;
    return {
      channelId: body.channelId,
      role: "device",
      hostPk: body.hostPk,
      grant: { exp: grant.exp, mac: grant.mac },
      ...(typeof body.deviceId === "string" && body.deviceId ? { deviceId: body.deviceId } : {}),
    };
  }
  return null;
}
