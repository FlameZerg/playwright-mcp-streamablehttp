# 常用模式和最佳实践

- Smithery 部署优化：1. Dockerfile 已实现浏览器固化到镜像（/ms-playwright）2. proxy-server.js 添加启动时浏览器验证日志 3. 使用多阶段构建缓存优化 4. 运行时验证浏览器存在
- Chrome CDP 模式实现：1. 预启动单例 Chrome 实例（CDP 9222端口）2. Playwright 通过 --cdp-endpoint 连接 3. 真正的单浏览器实例，避免 ETXTBSY 4. Chrome 自动重启机制 5. 等待5秒确保 Chrome 就绪 6. 移除 user-data-dir 和 shared-browser-context 参数
- 添加并发连接限制：1. 跟踪 activeConnections 计数 2. MAX_CONCURRENT_CONNECTIONS=1 3. MCP 端点检测到超过限制返回 429 Too Many Requests 4. 友好错误消息提示用户稍后重试 5. 在 finish 和 close 事件中减少计数 6. 避免 ETXTBSY 错误暴露给用户
- 方案B待实施：探索切换到 WebSocket 模式实现 MCP 传输，优势是双向实时通信和连接保持，可能支持真正的浏览器实例共享。需验证 Playwright MCP 和 Smithery 平台对 WebSocket 的支持
- Smithery scanner 兼容：当扫描器连续发送多个 initialize 请求时，不应短暂返回 503；必须在 "整个初始化流程中一致返回 initialize response"（即使后端未完全就绪）。同时为避免竞态，增加全局初始化事务锁，确保 initialize 仅由第一个请求完整触发，并让后续同类请求等待或附加状态。已反复多次遇到 scanner 轮询 initialize → 503 → 构建失败的问题。
- Session not found 修复：移除所有超时限制以支持长期会话（24h+）。1) proxy-server.js：REQUEST_TIMEOUT=0，keepAliveTimeout=0，requestTimeout=0，仅保留 headersTimeout=60s（防慢速攻击）。2) cli.js 启动参数：移除 --timeout-action / --timeout-navigation，依赖 --save-session 持久化会话。3) 客户端无需重新 initialize，单次连接可持续使用。4) Smithery 平台 60s 限制已规避（单次请求可超过 60s，但需客户端定期发送请求保持连接活跃）。
