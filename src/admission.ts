/**
 * 协议 v3 准入：relay 持有一把 X25519 身份密钥；桌面（host）用 X25519(relayPk, desktopSk)
 * 推出的共享密钥做 HMAC-SHA256，relay 用 X25519(desktopPk, relaySk) 复算验证。
 * - host 证明：HMAC(`host-domain:channelId:ts`)，且 sha256(desktopPk) 必须等于 channelId——
 *   证明调用方持有该 channel 对应的桌面私钥，匿名者无法抢占 host 槽位或随机建 channel；
 * - 设备令牌：HMAC(`device-domain:channelId:subject:exp`)，由桌面签发后经加密 ack / QR 下发给手机，
 *   手机凭它换 device 票据——relay 不再接受匿名 device。
 * relay 全程看不到任何业务明文，令牌本身也不含秘密。
 * 算法与 Spcode 仓库 packages/shared/src/crypto.ts 完全一致，互通由共享测试向量锁定。
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import nacl from "tweetnacl";
import { CHANNEL_ID_RE } from "./channel.js";
import {
  RELAY_DEVICE_GRANT_DOMAIN,
  RELAY_HOST_PROOF_DOMAIN,
  RELAY_PAIR_SUBJECT,
  RELAY_PROOF_SKEW_MS,
  type RelayDeviceGrant,
} from "./protocol.js";

const DEVICE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export interface HostProofRequest {
  channelId: string;
  hostPk: string;
  ts: number;
  proof: string;
}

export interface DeviceGrantRequest {
  channelId: string;
  hostPk: string;
  deviceId?: string;
  grant: RelayDeviceGrant;
}

export type AdmissionResult = { ok: true } | { ok: false; error: string };

function decodeKey(b64: string): Uint8Array | null {
  try {
    const buf = Buffer.from(b64, "base64");
    return buf.length === nacl.box.publicKeyLength ? new Uint8Array(buf) : null;
  } catch {
    return null;
  }
}

export function hostProofMessage(channelId: string, ts: number): string {
  return `${RELAY_HOST_PROOF_DOMAIN}${channelId}:${ts}`;
}

export function deviceGrantMessage(channelId: string, subject: string, exp: number): string {
  return `${RELAY_DEVICE_GRANT_DOMAIN}${channelId}:${subject}:${exp}`;
}

export class RelayIdentity {
  readonly publicKey: string;
  private readonly secretKey: Uint8Array;

  private constructor(secretKey: Uint8Array) {
    this.secretKey = secretKey;
    this.publicKey = Buffer.from(nacl.box.keyPair.fromSecretKey(secretKey).publicKey).toString("base64");
  }

  /**
   * 从环境读取：RELAY_SECRET_KEY（base64 32B）。生产模式缺失直接报错——容器 read_only、
   * 每次重启随机换钥会让所有桌面已签发的设备令牌作废；开发/测试缺省随机生成并告警。
   */
  static fromEnv(env: NodeJS.ProcessEnv = process.env, log: (msg: string) => void = console.warn): RelayIdentity {
    const raw = env.RELAY_SECRET_KEY?.trim();
    if (raw) {
      const key = decodeKey(raw);
      if (!key) throw new Error("RELAY_SECRET_KEY must be a base64-encoded 32-byte X25519 secret key");
      return new RelayIdentity(key);
    }
    if (env.NODE_ENV === "production") {
      throw new Error("RELAY_SECRET_KEY is required in production (generate with: openssl rand -base64 32)");
    }
    log("[relay] RELAY_SECRET_KEY is not set; using an ephemeral identity (device grants will not survive restarts)");
    return new RelayIdentity(nacl.box.keyPair().secretKey);
  }

  static fromSecretKey(secretKeyB64: string): RelayIdentity {
    const key = decodeKey(secretKeyB64);
    if (!key) throw new Error("invalid relay secret key");
    return new RelayIdentity(key);
  }

  static generate(): RelayIdentity {
    return new RelayIdentity(nacl.box.keyPair().secretKey);
  }

  /** 测试/工具用：签发端同算法（桌面侧实现见 Spcode shared/crypto.ts） */
  macFor(peerPk: string, message: string): string | null {
    const pk = decodeKey(peerPk);
    if (!pk) return null;
    return this.mac(pk, message);
  }

  private mac(peerPk: Uint8Array, message: string): string {
    const shared = nacl.box.before(peerPk, this.secretKey);
    return createHmac("sha256", Buffer.from(shared)).update(message, "utf8").digest("base64");
  }

  private verifyMac(peerPk: Uint8Array, message: string, macB64: string): boolean {
    let given: Buffer;
    try {
      given = Buffer.from(macB64, "base64");
    } catch {
      return false;
    }
    const expected = Buffer.from(this.mac(peerPk, message), "base64");
    return given.length === expected.length && timingSafeEqual(given, expected);
  }

  verifyHostProof(req: HostProofRequest, now: number = Date.now()): AdmissionResult {
    const pk = decodeKey(req.hostPk);
    if (!pk || !CHANNEL_ID_RE.test(req.channelId)) return { ok: false, error: "proof_invalid" };
    if (createHash("sha256").update(pk).digest("hex") !== req.channelId) return { ok: false, error: "proof_invalid" };
    if (!Number.isInteger(req.ts) || Math.abs(now - req.ts) > RELAY_PROOF_SKEW_MS) {
      return { ok: false, error: "proof_expired" };
    }
    if (!this.verifyMac(pk, hostProofMessage(req.channelId, req.ts), req.proof)) {
      return { ok: false, error: "proof_invalid" };
    }
    return { ok: true };
  }

  verifyDeviceGrant(req: DeviceGrantRequest, now: number = Date.now()): AdmissionResult {
    const pk = decodeKey(req.hostPk);
    if (!pk || !CHANNEL_ID_RE.test(req.channelId)) return { ok: false, error: "grant_invalid" };
    if (createHash("sha256").update(pk).digest("hex") !== req.channelId) return { ok: false, error: "grant_invalid" };
    if (req.deviceId !== undefined && !DEVICE_ID_RE.test(req.deviceId)) return { ok: false, error: "grant_invalid" };
    if (!Number.isInteger(req.grant.exp)) return { ok: false, error: "grant_invalid" };
    if (req.grant.exp <= now) return { ok: false, error: "grant_expired" };
    const subject = req.deviceId ?? RELAY_PAIR_SUBJECT;
    if (!this.verifyMac(pk, deviceGrantMessage(req.channelId, subject, req.grant.exp), req.grant.mac)) {
      return { ok: false, error: "grant_invalid" };
    }
    return { ok: true };
  }
}

/** 生成一把可写进 RELAY_SECRET_KEY 的密钥（base64 32B） */
export function generateSecretKeyB64(): string {
  return Buffer.from(randomBytes(32)).toString("base64");
}
