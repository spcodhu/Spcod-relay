/**
 * 测试用「桌面侧」准入签发：与 Spcode packages/shared/src/crypto.ts 同算法
 * （X25519(relayPk, desktopSk) 共享密钥 + HMAC-SHA256），用于驱动 relay 的 v3 准入。
 */
import { createHash, createHmac } from "node:crypto";
import nacl from "tweetnacl";
import { RelayIdentity } from "../src/admission.js";
import { RELAY_DEVICE_GRANT_DOMAIN, RELAY_HOST_PROOF_DOMAIN, RELAY_PAIR_SUBJECT } from "../src/protocol.js";

export interface FakeDesktop {
  publicKey: string;
  secretKey: Uint8Array;
  channelId: string;
  hostProof(relayPk: string, ts: number): string;
  deviceGrant(relayPk: string, subject: string, exp: number): { exp: number; mac: string };
  hostTicketBody(relayPk: string, ts?: number): Record<string, unknown>;
  deviceTicketBody(relayPk: string, deviceId: string | undefined, exp?: number): Record<string, unknown>;
}

function hmac(shared: Uint8Array, message: string): string {
  return createHmac("sha256", Buffer.from(shared)).update(message, "utf8").digest("base64");
}

export function fakeDesktop(seed?: Uint8Array): FakeDesktop {
  const kp = seed ? nacl.box.keyPair.fromSecretKey(seed) : nacl.box.keyPair();
  const publicKey = Buffer.from(kp.publicKey).toString("base64");
  const channelId = createHash("sha256").update(kp.publicKey).digest("hex");
  const shared = (relayPk: string) => nacl.box.before(new Uint8Array(Buffer.from(relayPk, "base64")), kp.secretKey);
  const desktop: FakeDesktop = {
    publicKey,
    secretKey: kp.secretKey,
    channelId,
    hostProof: (relayPk, ts) => hmac(shared(relayPk), `${RELAY_HOST_PROOF_DOMAIN}${channelId}:${ts}`),
    deviceGrant: (relayPk, subject, exp) => ({
      exp,
      mac: hmac(shared(relayPk), `${RELAY_DEVICE_GRANT_DOMAIN}${channelId}:${subject}:${exp}`),
    }),
    hostTicketBody: (relayPk, ts = Date.now()) => ({
      channelId,
      role: "host",
      hostPk: publicKey,
      ts,
      proof: desktop.hostProof(relayPk, ts),
    }),
    deviceTicketBody: (relayPk, deviceId, exp = Date.now() + 60_000) => ({
      channelId,
      role: "device",
      ...(deviceId ? { deviceId } : {}),
      hostPk: publicKey,
      grant: desktop.deviceGrant(relayPk, deviceId ?? RELAY_PAIR_SUBJECT, exp),
    }),
  };
  return desktop;
}

export function testIdentity(): RelayIdentity {
  return RelayIdentity.generate();
}
