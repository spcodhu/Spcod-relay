import { TokenBucket } from "./ratelimit.js";

/**
 * 哑中继核心：channel 注册表、按角色路由、离线队列。
 * relay 不解析、不修改任何业务帧，只做转发与缓存。
 */

export type Role = "host" | "device";

/** 最小连接抽象——ws 适配层与测试假连接都实现它。 */
export interface Conn {
  readonly role: Role;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

/** channelId = SHA-256(桌面端 X25519 公钥) 的 64 位小写 hex。 */
export const CHANNEL_ID_RE = /^[0-9a-f]{64}$/;

export interface RelayOptions {
  /** 每 channel 每方向离线队列上限，默认 1000 */
  queueMax?: number;
  /** 离线帧存活时长（毫秒），默认 72h */
  queueTtlMs?: number;
  /** 单帧最大字节数，默认 256KB */
  frameMaxBytes?: number;
  /** 每 channel 每秒帧数上限（令牌桶），默认 60 */
  ratePerSec?: number;
  /** 时钟注入（测试用） */
  now?: () => number;
}

export type ConnectResult = { ok: true } | { ok: false; reason: string };

interface QueuedFrame {
  data: string;
  at: number;
}

interface ChannelState {
  host: Conn | null;
  devices: Set<Conn>;
  /** device → host 离线队列（host 不在线时缓存） */
  toHost: QueuedFrame[];
  /** host → device 离线队列（无任何 device 在线时缓存） */
  toDevices: QueuedFrame[];
  bucket: TokenBucket;
}

export class RelayCore {
  private readonly channels = new Map<string, ChannelState>();
  private readonly queueMax: number;
  private readonly queueTtlMs: number;
  private readonly frameMaxBytes: number;
  private readonly ratePerSec: number;
  private readonly now: () => number;

  constructor(opts: RelayOptions = {}) {
    this.queueMax = opts.queueMax ?? 1000;
    this.queueTtlMs = opts.queueTtlMs ?? 72 * 3600 * 1000;
    this.frameMaxBytes = opts.frameMaxBytes ?? 256 * 1024;
    this.ratePerSec = opts.ratePerSec ?? 60;
    this.now = opts.now ?? Date.now;
  }

  /** 活跃 channel 数（含仅有离线队列的 channel） */
  channelCount(): number {
    return this.channels.size;
  }

  /**
   * 注册连接。host 冲突时以 close code 4001 拒绝后者。
   * 成功后先发 relay.hello，再按序补投该方向的离线帧。
   */
  connect(channelId: string, role: Role, conn: Conn): ConnectResult {
    if (!CHANNEL_ID_RE.test(channelId)) return { ok: false, reason: "invalid_channel" };
    if (role !== "host" && role !== "device") return { ok: false, reason: "invalid_role" };

    let ch = this.channels.get(channelId);
    if (!ch) {
      ch = {
        host: null,
        devices: new Set(),
        toHost: [],
        toDevices: [],
        bucket: new TokenBucket(this.ratePerSec, this.now),
      };
      this.channels.set(channelId, ch);
    }

    if (role === "host") {
      if (ch.host) {
        conn.close(4001, "host_exists");
        return { ok: false, reason: "host_exists" };
      }
      ch.host = conn;
    } else {
      ch.devices.add(conn);
    }

    const queue = role === "host" ? ch.toHost : ch.toDevices;
    const replay = this.drain(queue);
    conn.send(JSON.stringify({ t: "relay.hello", role, queued: replay.length }));
    for (const f of replay) conn.send(f.data);
    return { ok: true };
  }

  /**
   * 处理一帧：限流/尺寸检查后原样转发给对方角色；
   * 对方不在线则进离线队列（满则回 relay.error channel_full 并丢弃）。
   */
  message(channelId: string, conn: Conn, data: string): void {
    const ch = this.channels.get(channelId);
    if (!ch) return;
    if (Buffer.byteLength(data, "utf8") > this.frameMaxBytes) {
      this.error(conn, "frame_too_large");
      return;
    }
    if (!ch.bucket.tryTake()) {
      this.error(conn, "rate_limited");
      return;
    }

    if (conn.role === "host") {
      if (ch.devices.size === 0) this.enqueue(ch.toDevices, data, conn);
      else for (const d of ch.devices) d.send(data);
    } else {
      if (!ch.host) this.enqueue(ch.toHost, data, conn);
      else ch.host.send(data);
    }
  }

  /** 连接断开。无任何连接且无离线帧时回收 channel。 */
  disconnect(channelId: string, conn: Conn): void {
    const ch = this.channels.get(channelId);
    if (!ch) return;
    if (conn.role === "host") {
      if (ch.host === conn) ch.host = null;
    } else {
      ch.devices.delete(conn);
    }
    this.maybeRecycle(channelId, ch);
  }

  /** 定时清理：丢弃所有过期离线帧，回收空 channel。 */
  sweep(): void {
    for (const [id, ch] of this.channels) {
      this.prune(ch.toHost);
      this.prune(ch.toDevices);
      this.maybeRecycle(id, ch);
    }
  }

  private enqueue(queue: QueuedFrame[], data: string, from: Conn): void {
    this.prune(queue);
    if (queue.length >= this.queueMax) {
      this.error(from, "channel_full");
      return;
    }
    queue.push({ data, at: this.now() });
  }

  /** 取出队列中未过期的帧并清空队列（对方角色上线补投）。 */
  private drain(queue: QueuedFrame[]): QueuedFrame[] {
    const now = this.now();
    const fresh = queue.filter((f) => now - f.at < this.queueTtlMs);
    queue.length = 0;
    return fresh;
  }

  private prune(queue: QueuedFrame[]): void {
    const now = this.now();
    for (;;) {
      const first = queue[0];
      if (first === undefined || now - first.at < this.queueTtlMs) return;
      queue.shift();
    }
  }

  private maybeRecycle(id: string, ch: ChannelState): void {
    if (!ch.host && ch.devices.size === 0 && ch.toHost.length === 0 && ch.toDevices.length === 0) {
      this.channels.delete(id);
    }
  }

  private error(conn: Conn, code: string): void {
    conn.send(JSON.stringify({ t: "relay.error", error: code }));
  }
}
