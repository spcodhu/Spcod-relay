# Relay 协议 v3

## 信任边界

relay 只路由端到端加密的文本帧，不解释 `RemoteCommand`、`RemoteEvent` 或会话业务。channelId 是桌面 X25519 公钥原始 32 字节的 SHA-256，表示为 64 位小写 hex。relay 持有自己的 X25519 身份密钥，用于验证准入证明；它不持有手机或桌面的 E2E 私钥。

## 获取 relay 身份

客户端通过此端点确认协议版本和 relay 公钥；桌面在生成 host proof 或 device grant 前必须取得 `relayPk`：

```http
GET /v1/relay-info
```

```json
{"version":3,"relayPk":"<base64 X25519 public key>"}
```

响应使用 `Cache-Control: no-store`，并遵循与票据接口相同的 origin/CORS 规则。`/health` 同样报告协议版本 3，但不返回密钥。

## 准入与短时票据

host 和 device 都必须先通过 `POST /v1/tickets` 完成 v3 准入验证，再凭返回的 ticket 建立 WebSocket。

### host：channel 所有权证明

请求体：

```json
{
  "channelId": "<64hex>",
  "role": "host",
  "hostPk": "<base64 desktop X25519 public key>",
  "ts": 1730000000000,
  "proof": "<base64 HMAC-SHA256>"
}
```

- `hostPk` 的 SHA-256 必须等于 `channelId`。
- 桌面调用 `nacl.box.before(relayPk, desktopSk)` 得到基于 X25519 的 32 字节 NaCl 预计算共享密钥，以其为 HMAC 密钥计算 `HMAC-SHA256("spcod-relay-host-v3:" + channelId + ":" + ts)`；relay 用 `nacl.box.before(hostPk, relaySk)` 复算并验证。
- `ts` 是 Unix 毫秒时间戳，与 relay 当前时间的偏差不得超过 ±5 分钟。
- 该证明绑定 channel 和时间戳，但不能代替下述单次 ticket。

### device：桌面签发的 grant

请求体：

```json
{
  "channelId": "<64hex>",
  "role": "device",
  "deviceId": "phone",
  "hostPk": "<base64 desktop X25519 public key>",
  "grant": {"exp": 1730604800000, "mac": "<base64 HMAC-SHA256>"}
}
```

- 桌面使用同一 NaCl 预计算共享密钥，计算 `HMAC-SHA256("spcod-relay-device-v3:" + channelId + ":" + subject + ":" + exp)`。`subject` 为 `deviceId`，配对阶段则为 `pair`。
- QR v4 携带 subject=`pair` 的配对 grant；此阶段请求体不带 `deviceId`，WS 不带 `device` 参数。配对成功后，桌面通过加密 `pair_ack` 下发绑定 deviceId 的设备 grant。
- 已配对设备通过加密 `auth_ack` 获得滚动续期的设备 grant，有效期为 7 天。`exp` 是 Unix 毫秒时间戳，过期后须在局域网完成 auth 续期，或重新扫码。
- grant 只证明桌面允许该 subject 接入指定 channel，不是业务加密私钥。

### ticket 与可选 accessKey

成功响应示例：

```json
{"channelId":"<64hex>","role":"device","deviceId":"phone","ticket":"<random>","expiresAt":1730000030000}
```

- ticket 为 base64url 编码的 32 字节随机值，30 秒内有效、单次消费，并绑定 channel/role，以及已配对设备的 deviceId（host 和 pair ticket 无 deviceId）。
- 错绑定、过期、重放或缺失 ticket 均拒绝。proof、grant 和可选 accessKey 仅随 HTTPS 取票请求提交，不进入 WS URL。
- 配置 `RELAY_ACCESS_KEY` 时，每次取票还必须在 v3 证明或 grant 之外叠加 `Authorization: Bearer <RELAY_ACCESS_KEY>`。accessKey 不能替代 v3 准入；未配置 accessKey 的公共实例也同样要求 host proof 或 device grant。
- 浏览器跨 origin 时，origin 必须在 `CORS_ALLOWED_ORIGINS` 中；same-origin 和 Node host 不需要该列表。

## WebSocket 连接

```text
wss://<relay>/channel/<channelId>?role=host&ticket=<ticket>
wss://<relay>/channel/<channelId>?role=device&device=<deviceId>&ticket=<ticket>
```

配对阶段使用 device 角色和 subject=`pair` 的 ticket，不带 `device` 参数。所有连接都必须消费有效 ticket，无 ticket 一律返回 401，没有免票据兼容路径。公网必须使用 WSS；WS 仅用于 loopback 或开发环境。

- 同身份 host 再次连接时，新连接替换旧连接，旧连接以 **4001 `host_replaced`** 关闭。
- 带同一 deviceId 的设备新连接以 4003 替换旧连接；设备数超限返回 4002。
- 每个 IP 的并发 WS 连接默认最多 64 条，可由 `MAX_CONNS_PER_IP` 调整。位于反向代理后时必须正确设置 `TRUST_PROXY`，否则会把代理 IP 当作所有客户端的共同 IP。

## 帧、限流与可靠性

- `relay.hello`：`{t,role,queued,version:3}`。
- `relay.error`：`channel_full`、`frame_too_large`、`rate_limited`、`invalid_frame`。
- 限流按连接计数：device 使用独立令牌桶；host 桶容量为 `ratePerSec × maxDevices`，一个设备的流量不会耗尽其他连接的配额。
- host→device 带 deviceId 的帧：目标在线时定向直发，目标离线时进入该设备独立队列。无 deviceId 的配对期帧使用受限 wildcard 语义。
- 默认配置下，内存离线队列最多保留 72 小时的密文与相关元数据，并受条数和全局字节预算限制；它是 best-effort 缓存，不是持久化保证。relay 重启后由桌面 snapshot/history/output backfill 恢复。
- 30 秒 ping/pong；慢消费者超过缓冲预算直接断开，客户端应重连并对账。
- relay 原样转发业务密文，不记录帧内容。握手拒绝日志只含状态、稳定原因码、role 和 channelId，不含 ticket、accessKey、准入证明或查询字符串。
