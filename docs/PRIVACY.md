# 隐私与元数据

## relay 看不到什么

提示词、代码、模型回复、会话标题、定时任务内容、工具参数和权限卡内容都在手机与电脑之间端到端加密。relay 不持有设备 E2E 私钥，不能解密其转发的业务密文。

## relay 能看到和暂存什么

- channelId、deviceId、host/device 角色；
- 连接时间、断线重连、帧大小、流量和限流事件；
- 来源 IP，用于内存中的票据限流与 WS 并发计数；
- 取票请求中的 hostPk、proof、grant（含 `exp`）及可选 accessKey；
- 离线密文帧及路由所需的相关元数据。

默认配置下，离线队列最多保留 72 小时，仅存在内存中，并受条数和全局字节预算限制；`QUEUE_TTL_HOURS` 可调整期限，重启会清空队列。这些元数据可能推断“何时在使用编程工具”。有更高隐私要求时请自托管 relay 或使用 Tailscale。

## 密钥分层与 v3 准入

- 设备 E2E 私钥：只在手机/电脑上，relay 不需要。
- relay 身份私钥：`RELAY_SECRET_KEY` 用于验证 X25519/HMAC-SHA256 准入证明，必须由 `deploy.sh` 生成并持久保存；换钥会使全部设备 grant 失效。
- host proof / device grant：host 证明 channel 所有权；device 使用桌面签发的 grant。QR v4 携带配对 grant，已配对设备使用 7 天滚动 grant。
- relay accessKey：自托管默认配置的共享 Bearer 门槛，叠加在 v3 准入之上；官方公共实例无 accessKey，但仍要求 proof/grant。
- 单次 ticket：30 秒有效，绑定 channel/role/deviceId，用于 WS URL；不记录到应用日志。

accessKey 泄露不等于会话内容泄露，也不能单独绕过 v3 准入，但仍应立即轮换。设备吊销不会立即撤销已签发的 relay grant：未过期设备 grant 在签发后最长 7 天内仍可用于新取票/连接，但桌面会拒绝其 auth。relay 不会按 grant 到期主动断开既有 WebSocket。

## PWA 分发信任

relay 同源托管并分发手机 PWA，因此 E2E 还需信任该代码分发源及构建链。被篡改的 PWA 可能在浏览器内接触明文或私钥，传输加密无法防御此类客户端风险。自托管可控制 relay、PWA 固定源码版本和构建分发过程。

响应 CSP 使用 `script-src 'self'`，PWA 主题启动脚本已外置为 `theme-boot.js`。手机私钥存于 IndexedDB；严格 CSP 可降低部分注入风险，但不能消除恶意分发源、供应链或所有 XSS 风险。

## 日志、可用性与密码学边界

应用不记录业务帧、accessKey、proof、grant、ticket 或 WS 查询字符串。JSON 健康响应仅含 `{ok,version}`，当前版本为 3；HTML 健康页另含状态与 UTC 检查时间，均不含密钥或消息数据。生产反代访问日志也应关闭或脱敏查询字符串。

relay 自身仍可拒绝连接、丢弃或延迟帧、注入垃圾配对帧，从而对转发流量实施 DoS；E2E 和准入验证不保证可用性。

当前业务加密使用长期设备密钥的 NaCl box 与防重放序号，**不宣称前向保密**。离线队列是 best-effort 缓存，不是长期历史库；relay 重启后，会话恢复依赖桌面权威快照、历史和输出补拉。
