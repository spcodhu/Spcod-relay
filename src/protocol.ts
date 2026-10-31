/** relay 对外协议常量；业务密文帧不属于本文件。 */
export const RELAY_PROTOCOL_VERSION = 2;
export const RELAY_TICKET_PATH = "/v1/tickets";
export const RELAY_TICKET_TTL_MS = 30_000;

export const RELAY_CLOSE = {
  HOST_EXISTS: 4001,
  CHANNEL_FULL: 4002,
  DEVICE_REPLACED: 4003,
  SLOW_CONSUMER: 4008,
  SERVER_FULL: 4013,
} as const;

export interface RelayTicketBinding {
  channelId: string;
  role: "host" | "device";
  deviceId?: string;
}

export interface RelayTicketGrant extends RelayTicketBinding {
  ticket: string;
  expiresAt: number;
}
