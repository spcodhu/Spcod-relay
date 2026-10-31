/** 每 origin/host + channel + role + device 的票据，仅用于 WebSocket 握手。 */
export interface TicketRequestBody {
  channelId: string;
  role: "host" | "device";
  deviceId?: string;
}

export function parseTicketBody(value: unknown): TicketRequestBody | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  if (typeof body.channelId !== "string" || (body.role !== "host" && body.role !== "device")) return null;
  if (body.deviceId !== undefined && typeof body.deviceId !== "string") return null;
  return {
    channelId: body.channelId,
    role: body.role,
    ...(typeof body.deviceId === "string" && body.deviceId ? { deviceId: body.deviceId } : {}),
  };
}
