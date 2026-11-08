/** relay 对外协议常量；业务密文帧不属于本文件。 */
export const RELAY_PROTOCOL_VERSION = 3;
export const RELAY_TICKET_PATH = "/v1/tickets";
export const RELAY_INFO_PATH = "/v1/relay-info";
export const RELAY_TICKET_TTL_MS = 30_000;
/** host 证明时间戳允许的时钟偏差（笔记本时钟漂移常见，放宽到 ±5 分钟） */
export const RELAY_PROOF_SKEW_MS = 300_000;

/** 准入 MAC 的域分隔前缀（与 Spcode packages/shared/src/crypto.ts 完全一致） */
export const RELAY_HOST_PROOF_DOMAIN = "spcod-relay-host-v3:";
export const RELAY_DEVICE_GRANT_DOMAIN = "spcod-relay-device-v3:";
/** 配对令牌的主体（设备尚无 deviceId 时） */
export const RELAY_PAIR_SUBJECT = "pair";

export const RELAY_CLOSE = {
  /** 同身份的另一 host 接管了 channel（旧连接被替换） */
  HOST_REPLACED: 4001,
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

/** 桌面签发的设备准入令牌：HMAC-SHA256(`device-domain:channelId:subject:exp`, X25519(relayPk, desktopSk)) */
export interface RelayDeviceGrant {
  exp: number;
  mac: string;
}
