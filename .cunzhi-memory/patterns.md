# 常用模式和最佳实践

- Smithery 部署优化：1. Dockerfile 已实现浏览器固化到镜像（/ms-playwright）2. proxy-server.js 添加启动时浏览器验证日志 3. 使用多阶段构建缓存优化 4. 运行时验证浏览器存在
- Chrome CDP 模式实现：1. 预启动单例 Chrome 实例（CDP 9222端口）2. Playwright 通过 --cdp-endpoint 连接 3. 真正的单浏览器实例，避免 ETXTBSY 4. Chrome 自动重启机制 5. 等待5秒确保 Chrome 就绪 6. 移除 user-data-dir 和 shared-browser-context 参数
- 添加并发连接限制：1. 跟踪 activeConnections 计数 2. MAX_CONCURRENT_CONNECTIONS=1 3. MCP 端点检测到超过限制返回 429 Too Many Requests 4. 友好错误消息提示用户稍后重试 5. 在 finish 和 close 事件中减少计数 6. 避免 ETXTBSY 错误暴露给用户
