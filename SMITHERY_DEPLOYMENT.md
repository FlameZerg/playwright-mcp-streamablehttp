# Smithery 部署配置说明

## 持久化方案架构

本项目实现了完整的 Smithery 平台持久化方案，包含以下特性：

### 1. 浏览器二进制持久化（镜像层）

**位置**: `/ms-playwright`  
**实现**: Dockerfile 多阶段构建  
**生命周期**: 固化到镜像，只要镜像缓存存在就不需要重新下载

```dockerfile
# Browser 阶段安装
RUN npx -y playwright-core install --no-shell chromium

# Runtime 阶段复制
COPY --from=browser ${PLAYWRIGHT_BROWSERS_PATH} ${PLAYWRIGHT_BROWSERS_PATH}
```

### 2. 用户数据持久化（存储卷）

**位置**: `/home/node/.cache/ms-playwright-mcp`  
**内容**: 登录状态、cookies、localStorage、session 数据  
**保留时间**: 24小时

**配置** (smithery.yaml):
```yaml
volumes:
  - name: "playwright-user-data"
    mountPath: "/home/node/.cache/ms-playwright-mcp"
    retention: "24h"
```

### 3. 输出文件持久化（存储卷）

**位置**: `/tmp/playwright-output`  
**内容**: 截图、PDF、trace 文件  
**保留时间**: 24小时

**配置** (smithery.yaml):
```yaml
volumes:
  - name: "playwright-output"
    mountPath: "/tmp/playwright-output"
    retention: "24h"
```

---

## 自动修复机制

### 浏览器自动安装

**触发条件**:
- 容器启动时检测 `/ms-playwright` 目录为空或不包含 chromium
- `PLAYWRIGHT_AUTO_INSTALL=true` 环境变量启用（默认）

**流程**:
1. proxy-server.js 启动时执行 `checkBrowserInstalled()`
2. 如果缺失，自动运行 `npx playwright-core install chromium`
3. 安装成功后继续启动后端服务
4. 首次安装耗时 1-2 分钟，用户无感知

**日志示例**:
```
🔧 Auto-installing Chromium browser...
   This may take 1-2 minutes on first run.
✅ Browser installation completed successfully
✅ Browser cache found at: /ms-playwright
   Contents: chromium-1234
```

### 健康检查

**端点**: `/health` 或 `/healthz`  
**检查内容**: 代理服务器和后端服务可用性

**Docker 健康检查**:
```dockerfile
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3
```

**响应**:
- `200 OK`: `{"status": "healthy", "backend": "ready"}`
- `503 Service Unavailable`: `{"status": "starting", "backend": "not ready"}`

---

## 错误处理优化

### 502 Bad Gateway
**原因**: 后端服务未就绪  
**解决**: proxy-server.js 等待后端启动完成后才监听端口  
**用户体验**: 初始化期间返回 503，提示稍后重试

### 连接失败重试
**策略**: 最多重试 3 次，间隔 1 秒  
**触发**: `ECONNREFUSED` 或 `ECONNRESET` 错误  
**超时**: 单次请求 30 秒

---

## 部署流程

### 1. 推送到 Smithery

```bash
# 确保所有修改已提交
git add .
git commit -m "feat: 添加持久化和自动安装支持"
git push
```

### 2. Smithery 自动构建

构建日志应包含：
```
✓ Browser installation completed at /ms-playwright
✓ Runtime browser verification successful
```

### 3. 首次启动

容器启动日志：
```
Starting Playwright MCP server proxy on 0.0.0.0:8081
Environment: NODE_ENV=production, PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
✅ Browser cache found at: /ms-playwright
[Backend] Server listening on port 8082
Backend ready after 2345ms
Proxy server listening on http://0.0.0.0:8081
```

### 4. 验证持久化

**测试用户数据持久化**:
1. 访问需要登录的网站并登录
2. 等待容器闲置回收（或手动重启）
3. 再次访问，应自动保持登录状态（24小时内）

**测试输出文件持久化**:
1. 使用 `browser_take_screenshot` 生成截图
2. 重启容器
3. 文件应仍然存在于 `/tmp/playwright-output`

---

## 故障排查

### 浏览器仍提示需要安装

**检查步骤**:

1. **查看启动日志**，确认自动安装是否执行：
   ```
   🔧 Auto-installing Chromium browser...
   ```

2. **验证环境变量**：
   ```
   PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
   PLAYWRIGHT_AUTO_INSTALL=true
   ```

3. **检查镜像构建日志**：
   ```
   Browser installation completed at /ms-playwright
   Runtime browser verification successful
   ```

4. **如果 Smithery 不支持 volumes**，联系平台支持确认存储卷语法

### 持久化未生效

**可能原因**:
1. Smithery 平台不支持 `volumes` 配置
2. `retention` 语法不正确（参考 Smithery 文档）
3. 容器在不同节点重启（分布式环境）

**解决方案**:
1. 查看 Smithery 官方文档确认存储卷配置格式
2. 如果不支持，考虑使用外部存储（S3、Redis 等）
3. 联系 Smithery 支持

---

## 环境变量

| 变量名 | 默认值 | 说明 |
|--------|--------|------|
| `PORT` | `8081` | 代理服务器监听端口 |
| `HOST` | `0.0.0.0` | 绑定地址 |
| `PLAYWRIGHT_BROWSERS_PATH` | `/ms-playwright` | 浏览器缓存路径 |
| `PLAYWRIGHT_AUTO_INSTALL` | `true` | 启用浏览器自动安装 |
| `PLAYWRIGHT_MCP_OUTPUT_DIR` | `/tmp/playwright-output` | 输出文件目录 |
| `NODE_ENV` | `production` | Node.js 环境 |

---

## 性能优化

- **构建缓存**: 使用 Docker 多阶段构建，浏览器层独立缓存
- **启动优化**: 并行启动后端和健康检查，减少冷启动时间
- **连接池**: 代理服务器自动重试，避免瞬时网络抖动

---

## 维护建议

1. **定期更新 Playwright 版本**（当前为 alpha 版本）
2. **监控日志**，关注浏览器自动安装频率
3. **调整 retention 时间**，根据实际使用情况优化（24h → 7d）
4. **如果 Smithery 限制存储卷**，考虑使用 Redis/S3 存储 session
