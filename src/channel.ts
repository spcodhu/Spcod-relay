import { TokenBucket } from "./ratelimit.js";
import { RELAY_CLOSE, RELAY_PROTOCOL_VERSION } from "./protocol.js";

/**
 * 哑中继核心：channel 注册表、按角色路由、离线队列。
 * relay 不解析、不修改任何业务帧，只做转发与缓存。
 */

export type Role = "host" | "device";

/** 最小连接抽象——ws 适配层与测试假连接都实现它。 */
export interface Conn {
  readonly role: Role;
  /** device 连接的可选稳定标识：用于定向直发、离线分槽和单活跃连接替换。 */
  readonly deviceId?: string;
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
  /**
   * 每条 device 连接每秒帧数上限（令牌桶），默认 60。
   * 按连接而非按 channel 计——否则一台刷爆的设备会让同 channel 的 host 与其他设备一起饿死。
   * host 一条连接承载全部设备流量，桶容量 = ratePerSec × maxDevices。
   */
  ratePerSec?: number;
  /** 全局 channel 数上限（默认 1024）——channel 只由已证明所有权的 host / 持令牌的 device 创建 */
  maxChannels?: number;
  /** 每 channel 设备数上限（默认 16） */
  maxDevices?: number;
  /** 全局离线队列总字节预算（默认 32MB，超出拒入队） */
  queueBytesMax?: number;
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
  /**
   * host → device 离线队列：按帧外层 deviceId 分槽（评审 R3-C9——原来全 channel 一个队列，
   * 第一个上线的设备会收走全部帧，逐设备加密的他设备帧永久丢失）。
   * "*" 槽 = 无 deviceId 的帧（pair_ack 等配对期帧，任何上线设备都可收）。
   */
  toDevices: Map<string, QueuedFrame[]>;
}

export class RelayCore {
  private readonly channels = new Map<string, ChannelState>();
  /** 每条连接一个令牌桶（连接断开即回收） */
  private readonly buckets = new WeakMap<Conn, TokenBucket>();
  private readonly queueMax: number;
  private readonly queueTtlMs: number;
  private readonly frameMaxBytes: number;
  private readonly ratePerSec: number;
  private readonly maxChannels: number;
  private readonly maxDevices: number;
  private readonly queueBytesMax: number;
  private queuedBytes = 0;
  private readonly now: () => number;

  constructor(opts: RelayOptions = {}) {
    this.queueMax = opts.queueMax ?? 1000;
    this.queueTtlMs = opts.queueTtlMs ?? 72 * 3600 * 1000;
    this.frameMaxBytes = opts.frameMaxBytes ?? 256 * 1024;
    this.ratePerSec = opts.ratePerSec ?? 60;
    this.maxChannels = opts.maxChannels ?? 1024;
    this.maxDevices = opts.maxDevices ?? 16;
    this.queueBytesMax = opts.queueBytesMax ?? 32 * 1024 * 1024;
    this.now = opts.now ?? Date.now;
  }

  /** 活跃 channel 数（含仅有离线队列的 channel） */
  channelCount(): number {
    return this.channels.size;
  }

  /**
   * 注册连接。host 已存在时**新连接接管**（准入层已证明两者持有同一桌面私钥；旧连接多半是
   * 尚未被心跳发现的死连接），旧连接以 4001 关闭；设备数超限以 4002 拒绝；同 deviceId 替换以 4003。
   * 成功后先发 relay.hello，再按序补投该方向的离线帧（device 按 deviceId 槽位 + "*" 槽）。
   */
  connect(channelId: string, role: Role, conn: Conn, opts?: { deviceId?: string }): ConnectResult {
    if (!CHANNEL_ID_RE.test(channelId)) return { ok: false, reason: "invalid_channel" };
    if (role !== "host" && role !== "device") return { ok: false, reason: "invalid_role" };

    let ch = this.channels.get(channelId);
    if (!ch) {
      if (this.channels.size >= this.maxChannels) {
        conn.close(RELAY_CLOSE.SERVER_FULL, "server_full");
        return { ok: false, reason: "server_full" };
      }
      ch = {
        host: null,
        devices: new Set(),
        toHost: [],
        toDevices: new Map(),
      };
      this.channels.set(channelId, ch);
    }

    if (role === "host") {
      if (ch.host) {
        const old = ch.host;
        ch.host = null;
        old.close(RELAY_CLOSE.HOST_REPLACED, "host_replaced");
      }
      ch.host = conn;
      this.buckets.set(conn, new TokenBucket(this.ratePerSec * this.maxDevices, this.now));
    } else {
      if (ch.devices.size >= this.maxDevices) {
        conn.close(RELAY_CLOSE.CHANNEL_FULL, "channel_full");
        return { ok: false, reason: "channel_full" };
      }
      if (opts?.deviceId) {
        // 同一设备只保留一个活跃逻辑连接；新连接明确替换旧连接，避免重复消费和 seq 分叉。
        for (const existing of ch.devices) {
          if (existing.deviceId === opts.deviceId) {
            ch.devices.delete(existing);
            existing.close(RELAY_CLOSE.DEVICE_REPLACED, "device_replaced");
          }
        }
      }
      ch.devices.add(conn);
      this.buckets.set(conn, new TokenBucket(this.ratePerSec, this.now));
    }

    // 补投：host 收 toHost 全部；device 收自己槽位 + "*" 槽（配对期无 deviceId 的帧）
    let replay: QueuedFrame[];
    if (role === "host") {
      replay = this.drain(ch.toHost);
    } else {
      replay = [];
      const slot = opts?.deviceId;
      if (slot) replay.push(...this.drainSlot(ch.toDevices, slot));
      replay.push(...this.drainSlot(ch.toDevices, "*"));
    }
    conn.send(JSON.stringify({ t: "relay.hello", role, queued: replay.length, version: RELAY_PROTOCOL_VERSION }));
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
    const bucket = this.buckets.get(conn);
    if (!bucket || !bucket.tryTake()) {
      this.error(conn, "rate_limited");
      return;
    }

    if (conn.role === "host") {
      const slot = slotOf(data);
      if (slot === "*") {
        // 配对期 wildcard：在线设备广播；完全无设备时才进入共享离线槽。
        if (ch.devices.size === 0) this.enqueue(ch.toDevices, "*", data, conn);
        else for (const d of ch.devices) d.send(data);
      } else {
        // 定向帧按目标设备独立判断：其他设备在线不代表目标设备已收到，离线必须入队。
        let delivered = false;
        for (const d of ch.devices) {
          if (d.deviceId === slot) {
            d.send(data);
            delivered = true;
          }
        }
        if (!delivered) this.enqueue(ch.toDevices, slot, data, conn);
      }
    } else {
      if (!ch.host) this.enqueueArray(ch.toHost, data, conn);
      else ch.host.send(data);
    }
  }

  /** 连接断开。无任何连接且无离线帧时回收 channel。 */
  disconnect(channelId: string, conn: Conn): void {
    this.buckets.delete(conn);
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
      for (const [slot, q] of ch.toDevices) {
        this.prune(q);
        if (q.length === 0) ch.toDevices.delete(slot);
      }
      this.maybeRecycle(id, ch);
    }
  }

  /** 离线入队（toHost 用） */
  private enqueueArray(queue: QueuedFrame[], data: string, from: Conn): void {
    this.prune(queue);
    if (queue.length >= this.queueMax) {
      this.error(from, "channel_full");
      return;
    }
    this.pushFrame(queue, data, from);
  }

  /** 离线入队（toDevices 按槽位） */
  private enqueue(map: Map<string, QueuedFrame[]>, slot: string, data: string, from: Conn): void {
    let q = map.get(slot);
    if (!q) {
      q = [];
      map.set(slot, q);
    }
    this.prune(q);
    if (q.length >= this.queueMax) {
      this.error(from, "channel_full");
      return;
    }
    this.pushFrame(q, data, from);
  }

  /** 入队 + 全局字节预算记账（超限拒收） */
  private pushFrame(queue: QueuedFrame[], data: string, from: Conn): void {
    const bytes = Buffer.byteLength(data, "utf8");
    if (this.queuedBytes + bytes > this.queueBytesMax) {
      this.error(from, "channel_full");
      return;
    }
    queue.push({ data, at: this.now() });
    this.queuedBytes += bytes;
  }

  /** 取出队列中未过期的帧并清空队列（对方角色上线补投）；归还字节预算 */
  private drain(queue: QueuedFrame[]): QueuedFrame[] {
    const now = this.now();
    const fresh = queue.filter((f) => now - f.at < this.queueTtlMs);
    for (const f of queue) this.queuedBytes -= Buffer.byteLength(f.data, "utf8");
    queue.length = 0;
    return fresh;
  }

  /** 按槽位补投（槽空即删） */
  private drainSlot(map: Map<string, QueuedFrame[]>, slot: string): QueuedFrame[] {
    const q = map.get(slot);
    if (!q) return [];
    map.delete(slot);
    return this.drain(q);
  }

  private prune(queue: QueuedFrame[]): void {
    const now = this.now();
    for (;;) {
      const first = queue[0];
      if (first === undefined || now - first.at < this.queueTtlMs) return;
      this.queuedBytes -= Buffer.byteLength(first.data, "utf8");
      queue.shift();
    }
  }

  private maybeRecycle(id: string, ch: ChannelState): void {
    if (!ch.host && ch.devices.size === 0 && ch.toHost.length === 0 && ch.toDevices.size === 0) {
      this.channels.delete(id);
    }
  }

  private error(conn: Conn, code: string): void {
    conn.send(JSON.stringify({ t: "relay.error", error: code }));
  }
}

/** host→device 帧的槽位键：帧外层 deviceId（配对期无 deviceId 的帧进 "*" 槽） */
function slotOf(data: string): string {
  try {
    const f = JSON.parse(data) as { deviceId?: unknown };
    const id = f.deviceId;
    return typeof id === "string" && id.length > 0 && id.length <= 64 ? id : "*";
  } catch {
    return "*";
  }
}
