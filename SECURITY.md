# 安全政策

## 报告漏洞

请通过 GitHub Security Advisory 或仓库所有者提供的私密渠道报告，不要先在公开 Issue 中披露可复现的安全漏洞。报告请包含影响版本、复现步骤、潜在影响与建议修复方式。

## 信任边界

- relay 只转发端到端加密的业务帧，不持有手机或桌面的 E2E 私钥，不能解密提示词、代码或会话内容。
- relay 可见 channelId、deviceId、host/device 角色、连接时间、帧大小、流量与限流事件等元数据。
- v3 要求 host 以基于 X25519 的 NaCl 预计算共享密钥生成 HMAC-SHA256 proof，证明 channel 所有权；device 凭桌面签发的 grant 取票。自托管 accessKey 是叠加的 Bearer 门槛，不是 E2E 私钥，也不能替代 v3 准入。
- `RELAY_SECRET_KEY` 是 relay 的 X25519 身份私钥，必须由 `deploy.sh` 生成并持久化；生产环境缺失会退出。换钥会使全部已签发设备 grant 失效。
- 公网部署必须使用 HTTPS/WSS，并配置连接、票据与队列限额。前置反代必须传递真实 `X-Forwarded-For` 并启用 `TRUST_PROXY`，否则 per-IP 限额会作用于代理地址。

## 保留、吊销与可用性

- 默认配置下，离线队列最多保留 72 小时的密文与相关元数据，仅存在内存中，受条数和全局字节预算限制；重启即清除。`QUEUE_TTL_HOURS` 可调整保留期限。
- 设备吊销不会立即撤销 relay 已签发的 grant。未过期设备 grant 在签发后最长 7 天内仍可用于新取票/连接，但桌面会拒绝其 auth；relay 连接不等于通过桌面认证。relay 也不会按 grant 到期主动断开既有 WebSocket。
- relay 自身可以拒绝连接、丢弃或延迟帧、注入垃圾配对帧，从而对其转发的流量实施 DoS。E2E 与 v3 准入不提供可用性保证。
- 离线队列是 best-effort 缓存，不是持久化历史库；relay 重启后由桌面快照、历史和输出补拉恢复。

## PWA 代码分发

relay 同源托管并分发手机 PWA。E2E 的前提还包括信任该代码分发源及其构建链：被篡改的 PWA JavaScript 可能在浏览器内接触明文或私钥，传输加密无法防止这种客户端被控制的风险。自托管可同时控制 relay、PWA 源码固定版本与构建分发过程。

relay 响应的 CSP 使用 `script-src 'self'`，不允许内联脚本；PWA 首屏主题脚本已外置为 `theme-boot.js`。严格 CSP 是浏览器防护层，不能消除恶意分发源、依赖供应链或所有 XSS 风险。

## 支持版本

安全修复只应用到当前主分支与最新发布版本。生产环境请使用固定版本标签或镜像摘要，不要长期跟随浮动 latest。
