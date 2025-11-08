# 项目上下文信息

- Smithery 持久化方案完成：1. smithery.yaml 添加 volumes 配置（24h 保留）2. Dockerfile 添加健康检查和目录初始化 3. proxy-server.js 实现浏览器自动安装 4. 用户数据目录 /home/node/.cache/ms-playwright-mcp 和输出目录 /tmp/playwright-output 持久化 5. 详细文档见 SMITHERY_DEPLOYMENT.md
- Playwright MCP 最终配置：1. 使用 --isolated + --shared-browser-context 组合 2. isolated 避免 ETXTBSY 文件锁错误 3. shared-browser-context 实现多客户端共享 4. 超时：action=30s, navigation=60s 5. 容器重启后需重新登录（临时目录） 6. 启用全部 6 个 capabilities: tabs, install, pdf, vision, testing, tracing
- 最终架构：使用固定用户数据目录 /app/browser-profile + shared-browser-context。避免 isolated 的临时目录问题，实现真正持久化。volumes 配置：browser-profile(24h) 和 playwright-output(24h)。解决浏览器偶尔丢失问题。
- 稳定性优化完成：1. 添加 --save-session 持久化 MCP 会话 2. 增加超时：action=60s, navigation=120s, request=120s 3. 添加后端健康监控（30秒间隔）4. 连续 3 次失败自动重启后端 5. 清理进程锁避免 ETXTBSY 6. 优雅降级不退出代理 7. 解决 Session not found 和 504 超时问题
- 最终方案：回归 isolated 模式。移除所有 CDP 相关代码。使用 --isolated + --shared-browser-context + --save-session。移除 user-data-dir 和 browser-profile volume。简化代码，减少启动时间。容器重启后需重新登录，但运行期间状态保持。适合 Smithery 快速冷启动。
- 项目基于 microsoft/playwright-mcp，已改造为 streamable HTTP 并部署在 Smithery 平台。关键需求：1) 构建时自动安装 Playwright 浏览器；2) Smithery 清理数据后能快速重新安装；3) 不生成文档/测试/不编译运行
- 最终架构（回归旧版 + SSE 改进）：1. Dockerfile 浏览器固化到镜像（COPY --from=browser /ms-playwright），移除 volumes/entrypoint.sh/init-browser.sh。2. ENTRYPOINT 直接 node proxy-server.js（无复制延迟，启动 < 3s）。3. proxy-server.js 立即启动后端 + SSE 占位响应（L318-L367）+ 500ms 健康检查。4. smithery.yaml 移除所有 volumes 配置。解决 scanner 0 工具问题（后端快速就绪）和浏览器缺失问题（镜像固化）。符合 KISS/YAGNI，对齐旧版稳定架构。
