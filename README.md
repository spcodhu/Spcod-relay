# @spcode/relay —— 零知识哑中继

Spcode Harness 远程控制功能的中继服务器（dumb relay）。设计见仓库 `docs/remote-control-design.md` 第 4.5 节。

## 这是什么

一台**零知识**的消息中继：你的手机（PWA）和电脑（harness）之间所有通信都是端到端加密的（X25519 密钥交换 + NaCl box），relay 只在中间做三件事：

1. **按 channel 路由加密 blob**——channel 标识就是桌面端公钥的 SHA-256 哈希，业务帧一律不解析、不修改、原样转发；
2. **离线消息队列**——对方角色不在线时按 channel 分方向缓存密文帧，上线后按序补投；
3. **托管 PWA 静态文件**——可选，把手机端构建产物放在 `STATIC_DIR` 即可直接通过 relay 打开。

relay **看不到**代码、提示词、会话内容、定时任务内容——它只见过密文 blob 和连接元数据（连接时间、数据量）。没有账号体系，没有持久化，没有明文日志。

## 快速自托管

### Docker（推荐）

```bash
docker build -t spcode-relay apps/relay
docker run -d -p 8787:8787 --name spcode-relay spcode-relay
```

托管手机端 PWA（可选）：

```bash
docker run -d -p 8787:8787 -v $(pwd)/public:/app/public:ro spcode-relay
```

### 裸机（Node 20+）

```bash
cd apps/relay
pnpm install
pnpm build
pnpm start          # 默认监听 :8787
```

验证：`curl http://localhost:8787/health` → `{"ok":true,"channels":0}`。

## 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | `8787` | HTTP/WebSocket 监听端口 |
| `STATIC_DIR` | `./public` | PWA 静态构建产物目录（SPA fallback 到 `index.html`）；不存在时 `/` 返回简短说明页 |
| `QUEUE_MAX` | `1000` | 每 channel 每方向离线队列上限 |
| `QUEUE_TTL_HOURS` | `72` | 离线帧存活时长，过期自动清理 |

## 协议速览（与客户端严格一致）

- 连接：`wss://<relay>/channel/<channelId>?role=host|device`
  - `channelId`：64 位小写 hex（SHA-256 公钥哈希），非法直接 400；
  - 每 channel 仅允许一个 `host`，后者以 close code `4001` 拒绝；`device` 可多个。
- 帧：纯文本 JSON，relay **原样转发**——host 发的转给所有 device，device 发的转给 host。
- relay 自己只产生两种帧：
  - `{t:"relay.hello", role, queued}`——连接建立后立即下发，`queued` 为随后的补投条数；
  - `{t:"relay.error", error}`——`channel_full` / `frame_too_large` / `rate_limited` / `invalid_frame`，**只丢帧不踢连接**。
- 保护：每 channel 60 帧/秒（令牌桶），单帧最大 256KB。
- `GET /health` → `{ok:true, channels:<活跃数>}`。

## TLS 建议

relay 本身只讲明文 `ws`（面向容器/内网部署）。公网部署时请在前面用反代终止 TLS：

- **Caddy**（最省事，自动签证书）：

  ```
  relay.example.com {
      reverse_proxy 127.0.0.1:8787
  }
  ```

- **nginx**：标准 `proxy_pass` + `Upgrade`/`Connection` 头转发 WebSocket 即可。

客户端连接地址相应使用 `wss://relay.example.com`。

## 隐私承诺

- **不记录消息内容**：代码里只有元数据级日志（监听端口、静态目录），帧内容从不进日志，也从不落盘；
- **不解析业务帧**：转发路径上不反序列化、不修改任何业务帧（唯一的 JSON 解析发生在 relay 自己产生的 `relay.hello` / `relay.error`）；
- **无账号、无追踪**：channel 标识是公钥哈希，没有用户概念；离线队列仅在内存中，TTL 到期即销毁；
- **全部开源**：欢迎审计。relay 能看到的只有密文与连接元数据——不相信官方社区 relay？`docker run` 一键换成你自己的。
