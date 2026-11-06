# Relay 协议 v2

## 信任边界

relay 只路由端到端加密的文本帧，不解释 `RemoteCommand`、`RemoteEvent` 或任何会话业务。channelId 是桌面 X25519 公钥原始 32 字节的 SHA-256（64 位小写 hex）。

## 连接

```text
wss://<relay>/channel/<channelId>?role=host|device&device=<deviceId>&ticket=<ticket>
```

- 每个 channel 同时只允许一个 host，冲突关闭码 4001。
- 带 deviceId 的设备同时只有一个活跃逻辑连接，新连接以 4003 替换旧连接。
- `ALLOW_LEGACY_WS=true` 时迁移期允许无 ticket 连接；配置 `RELAY_ACCESS_KEY` 后始终强制 ticket。
- 官方公共实例通过 `RELAY_ALLOW_ANONYMOUS=true` 显式启用匿名模式：忽略遗留访问密钥并允许无 ticket 连接；自托管默认 `false`。
- 公网必须使用 WSS；WS 仅用于 loopback 或开发环境。

## 短时单次票据

长期访问密钥绝不放入 WS URL。客户端先请求：

```http
POST /v1/tickets
Authorization: Bearer <RELAY_ACCESS_KEY>
Content-Type: application/json

{"channelId":"<64hex>","role":"device","deviceId":"phone"}
```

响应：

```json
{"channelId":"<64hex>","role":"device","deviceId":"phone","ticket":"<random>","expiresAt":1730000000000}
```

- ticket 32 字节随机、30 秒 TTL、单次消费，绑定 channel/role/device。
- 未配置 `RELAY_ACCESS_KEY` 时为匿名签发模式，但受 IP 限流；官方实例通过显式匿名配置兼容匿名旧客户端。
- 错密钥、错绑定、过期、重放都拒绝。
- 浏览器跨 origin 时，origin 必须在 `CORS_ALLOWED_ORIGINS` 中；same-origin 和 Node host 不需要该列表。

## 帧与可靠性

- relay 原样转发密文帧，不写日志内容。握手拒绝日志只含状态、稳定原因码、role 和 channelId，不含 ticket、访问密钥或查询字符串。
- `relay.hello`：`{t,role,queued,version:2}`。
- `relay.error`：`channel_full`、`frame_too_large`、`rate_limited`、`invalid_frame`。
- host→device 带 deviceId 的帧：目标在线时定向直发，目标离线时进入该设备独立队列；其他设备在线不会吞掉它。
- 无 deviceId 的配对期帧使用受限 wildcard 语义。
- 内存队列按 TTL/条数/全局字节预算限制，是 best-effort 缓存，**不是持久化保证**。relay 重启后由桌面 snapshot/history/output backfill 恢复。
- 30 秒 ping/pong；慢消费者超过缓冲预算直接断开，客户端应重连并对账。
