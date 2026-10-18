import { describe, expect, it } from "vitest";
import { type Conn, RelayCore, type Role } from "../src/channel.js";

const CID = "a".repeat(64);

class FakeConn implements Conn {
  messages: string[] = [];
  closedWith: number | undefined;
  constructor(public role: Role) {}
  send(data: string): void {
    this.messages.push(data);
  }
  close(code?: number): void {
    this.closedWith = code;
  }
  /** 跳过 relay.hello 后收到的业务帧 */
  frames(): string[] {
    return this.messages.filter((m) => !m.includes('"relay.'));
  }
  errors(): string[] {
    return this.messages.filter((m) => m.includes('"relay.error"')).map((m) => JSON.parse(m).error as string);
  }
  hello(): { t: string; role: string; queued: number } {
    const first = this.messages[0];
    if (!first) throw new Error("no hello");
    return JSON.parse(first);
  }
}

describe("channel 路由", () => {
  it("host 帧原样转发给所有 device", () => {
    const core = new RelayCore();
    const host = new FakeConn("host");
    const d1 = new FakeConn("device");
    const d2 = new FakeConn("device");
    core.connect(CID, "host", host);
    core.connect(CID, "device", d1);
    core.connect(CID, "device", d2);

    const frame = JSON.stringify({ id: "1", seq: 1, t: "encrypted", c: "YmxvYg==" });
    core.message(CID, host, frame);
    expect(d1.frames()).toEqual([frame]);
    expect(d2.frames()).toEqual([frame]);
    expect(host.frames()).toEqual([]); // 不回声给发送者
  });

  it("device 帧只转发给 host，不转给其他 device", () => {
    const core = new RelayCore();
    const host = new FakeConn("host");
    const d1 = new FakeConn("device");
    const d2 = new FakeConn("device");
    core.connect(CID, "host", host);
    core.connect(CID, "device", d1);
    core.connect(CID, "device", d2);

    core.message(CID, d1, '{"t":"pair"}');
    expect(host.frames()).toEqual(['{"t":"pair"}']);
    expect(d2.frames()).toEqual([]);
  });

  it("relay.hello 携带角色与补投条数", () => {
    const core = new RelayCore();
    const host = new FakeConn("host");
    core.connect(CID, "host", host);
    expect(host.hello()).toEqual({ t: "relay.hello", role: "host", queued: 0 });
  });
});

describe("离线队列", () => {
  it("host 离线时缓存 device→host 帧，host 上线后先 hello 再按序补投", () => {
    const core = new RelayCore();
    const dev = new FakeConn("device");
    core.connect(CID, "device", dev);
    core.message(CID, dev, "m1");
    core.message(CID, dev, "m2");

    const host = new FakeConn("host");
    core.connect(CID, "host", host);
    expect(host.messages).toEqual([JSON.stringify({ t: "relay.hello", role: "host", queued: 2 }), "m1", "m2"]);
  });

  it("无 device 时缓存 host→device 帧，首个 device 上线补投", () => {
    const core = new RelayCore();
    const host = new FakeConn("host");
    core.connect(CID, "host", host);
    core.message(CID, host, "h1");

    const dev = new FakeConn("device");
    core.connect(CID, "device", dev);
    expect(dev.messages).toEqual([JSON.stringify({ t: "relay.hello", role: "device", queued: 1 }), "h1"]);

    // 队列已排空，第二个 device 不再收到补投
    const dev2 = new FakeConn("device");
    core.connect(CID, "device", dev2);
    expect(dev2.hello().queued).toBe(0);
    expect(dev2.frames()).toEqual([]);
  });

  it("TTL 过期帧不补投，sweep 后回收", () => {
    let now = 1_000_000;
    const core = new RelayCore({ queueTtlMs: 1000, now: () => now });
    const dev = new FakeConn("device");
    core.connect(CID, "device", dev);
    core.message(CID, dev, "old");
    now += 2000; // 过期
    core.message(CID, dev, "fresh");

    const host = new FakeConn("host");
    core.connect(CID, "host", host);
    expect(host.frames()).toEqual(["fresh"]); // "old" 已过期
    expect(host.hello().queued).toBe(1);
  });

  it("队列满时回 relay.error channel_full 并丢弃新帧", () => {
    const core = new RelayCore({ queueMax: 2 });
    const dev = new FakeConn("device");
    core.connect(CID, "device", dev);
    core.message(CID, dev, "m1");
    core.message(CID, dev, "m2");
    core.message(CID, dev, "m3");
    expect(dev.errors()).toEqual(["channel_full"]);

    const host = new FakeConn("host");
    core.connect(CID, "host", host);
    expect(host.frames()).toEqual(["m1", "m2"]);
  });
});

describe("连接约束", () => {
  it("每 channel 仅一个 host，后者被 4001 拒绝", () => {
    const core = new RelayCore();
    const h1 = new FakeConn("host");
    const h2 = new FakeConn("host");
    expect(core.connect(CID, "host", h1).ok).toBe(true);
    const res = core.connect(CID, "host", h2);
    expect(res).toEqual({ ok: false, reason: "host_exists" });
    expect(h2.closedWith).toBe(4001);
  });

  it("非法 channelId 拒绝连接", () => {
    const core = new RelayCore();
    for (const bad of ["", "xyz", "A".repeat(64), "a".repeat(63), "a".repeat(65), "g".repeat(64)]) {
      expect(core.connect(bad, "host", new FakeConn("host"))).toEqual({
        ok: false,
        reason: "invalid_channel",
      });
    }
  });

  it("host 断开后允许新 host 接管并收到离线帧", () => {
    const core = new RelayCore();
    const h1 = new FakeConn("host");
    core.connect(CID, "host", h1);
    core.disconnect(CID, h1);

    const dev = new FakeConn("device");
    core.connect(CID, "device", dev);
    core.message(CID, dev, "queued");

    const h2 = new FakeConn("host");
    expect(core.connect(CID, "host", h2).ok).toBe(true);
    expect(h2.frames()).toEqual(["queued"]);
  });
});

describe("限流与帧大小", () => {
  it("超过每 channel 每秒帧数上限：回 rate_limited，丢弃且不踢连接", () => {
    const core = new RelayCore({ ratePerSec: 2 });
    const host = new FakeConn("host");
    const dev = new FakeConn("device");
    core.connect(CID, "host", host);
    core.connect(CID, "device", dev);

    core.message(CID, dev, "f1");
    core.message(CID, dev, "f2");
    core.message(CID, dev, "f3"); // 超限
    expect(host.frames()).toEqual(["f1", "f2"]);
    expect(dev.errors()).toEqual(["rate_limited"]);

    // 连接保留，后续仍可通信（等令牌回补——这里用新 core 简化语义验证）
    expect(dev.closedWith).toBeUndefined();
  });

  it("单帧超过 256KB：回 frame_too_large，不转发", () => {
    const core = new RelayCore();
    const host = new FakeConn("host");
    const dev = new FakeConn("device");
    core.connect(CID, "host", host);
    core.connect(CID, "device", dev);

    const big = "x".repeat(256 * 1024 + 1);
    core.message(CID, host, big);
    expect(dev.frames()).toEqual([]);
    expect(host.errors()).toEqual(["frame_too_large"]);
  });
});

describe("channel 回收", () => {
  it("无连接且无离线帧时回收；有离线帧时保留", () => {
    const core = new RelayCore();
    const dev = new FakeConn("device");
    core.connect(CID, "device", dev);
    core.message(CID, dev, "pending"); // host 离线 → 入队
    core.disconnect(CID, dev);
    expect(core.channelCount()).toBe(1); // 队列非空，channel 保留

    const host = new FakeConn("host");
    core.connect(CID, "host", host);
    core.disconnect(CID, host);
    expect(core.channelCount()).toBe(0); // 队列已排空
  });
});

describe("评审 R3-C9：配额与按设备分槽", () => {
  it("host→device 离线帧按 deviceId 分槽：A 上线只收 A 的，B 的留队", () => {
    const core = new RelayCore();
    const host = new FakeConn("host");
    core.connect(CID, "host", host);
    // 无设备在线：帧按外层 deviceId 入各自槽位
    core.message(CID, host, JSON.stringify({ t: "encrypted", deviceId: "devA", c: "a1" }));
    core.message(CID, host, JSON.stringify({ t: "encrypted", deviceId: "devB", c: "b1" }));
    core.message(CID, host, JSON.stringify({ t: "pair_ack", ok: true })); // 无 deviceId → "*" 槽

    const devA = new FakeConn("device");
    core.connect(CID, "device", devA, { deviceId: "devA" });
    // A 收到自己槽位的 a1 + "*" 槽的 pair_ack；B 的 b1 不动
    expect(devA.frames().map((f) => JSON.parse(f).c ?? JSON.parse(f).t)).toEqual(["a1", "pair_ack"]);

    const devB = new FakeConn("device");
    core.connect(CID, "device", devB, { deviceId: "devB" });
    expect(devB.frames().map((f) => JSON.parse(f).c)).toEqual(["b1"]);
  });

  it("channel 数上限：超出拒绝新 channel（4013 server_full）", () => {
    const core = new RelayCore({ maxChannels: 1 });
    const a = new FakeConn("host");
    expect(core.connect(CID, "host", a).ok).toBe(true);
    const other = new FakeConn("host");
    const CID2 = "b".repeat(64);
    const r = core.connect(CID2, "host", other);
    expect(r).toEqual({ ok: false, reason: "server_full" });
    expect(other.closedWith).toBe(4013);
  });

  it("设备数上限：超出以 4002 拒绝", () => {
    const core = new RelayCore({ maxDevices: 2 });
    const host = new FakeConn("host");
    core.connect(CID, "host", host);
    expect(core.connect(CID, "device", new FakeConn("device")).ok).toBe(true);
    expect(core.connect(CID, "device", new FakeConn("device")).ok).toBe(true);
    const third = new FakeConn("device");
    expect(core.connect(CID, "device", third).ok).toBe(false);
    expect(third.closedWith).toBe(4002);
  });

  it("全局字节预算：超出后拒入队", () => {
    const core = new RelayCore({ queueMax: 100, queueBytesMax: 64 });
    const dev = new FakeConn("device");
    core.connect(CID, "device", dev);
    core.message(CID, dev, "x".repeat(40)); // 40B
    core.message(CID, dev, "y".repeat(40)); // 累计 80B > 64B → 拒
    expect(dev.errors()).toEqual(["channel_full"]);
    const host = new FakeConn("host");
    core.connect(CID, "host", host);
    expect(host.frames()).toHaveLength(1);
  });
});
