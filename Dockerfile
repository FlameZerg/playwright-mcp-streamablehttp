ARG PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

# ------------------------------
# Base
# ------------------------------
# Base stage: Contains only the minimal dependencies required for runtime
# (node_modules and Playwright system dependencies)
FROM node:22-bookworm-slim AS base

ARG PLAYWRIGHT_BROWSERS_PATH
ENV PLAYWRIGHT_BROWSERS_PATH=${PLAYWRIGHT_BROWSERS_PATH}

# Set the working directory
WORKDIR /app

RUN --mount=type=cache,target=/root/.npm,sharing=locked,id=npm-cache \
    --mount=type=bind,source=package.json,target=package.json \
    --mount=type=bind,source=package-lock.json,target=package-lock.json \
  npm ci --omit=dev && \
  # Install system dependencies for playwright
  npx -y playwright-core install-deps chromium

# ------------------------------
# Builder
# ------------------------------
FROM base AS builder

RUN --mount=type=cache,target=/root/.npm,sharing=locked,id=npm-cache \
    --mount=type=bind,source=package.json,target=package.json \
    --mount=type=bind,source=package-lock.json,target=package-lock.json \
  npm ci

# Copy the rest of the app
COPY *.json *.js *.ts .

# ------------------------------
# Browser
# ------------------------------
# Cache optimization:
# - Browser is downloaded only when node_modules or Playwright system dependencies change
# - Cache is reused when only source code changes
FROM base AS browser

ARG PLAYWRIGHT_BROWSERS_PATH

# 安装浏览器到备份目录（用于首次启动时复制到卷）
RUN npx -y playwright-core install --no-shell chromium && \
  ls -la ${PLAYWRIGHT_BROWSERS_PATH} && \
  echo "✅ Browser installation completed"

# ------------------------------
# Runtime
# ------------------------------
FROM base

ARG PLAYWRIGHT_BROWSERS_PATH
ARG USERNAME=node
ENV NODE_ENV=production
ENV PLAYWRIGHT_BROWSERS_PATH=${PLAYWRIGHT_BROWSERS_PATH}
ENV PLAYWRIGHT_MCP_OUTPUT_DIR=/tmp/playwright-output
ENV PLAYWRIGHT_BROWSERS_BACKUP=/tmp/playwright-browsers-backup

# Set the correct ownership for the runtime user on production `node_modules`
RUN chown -R ${USERNAME}:${USERNAME} node_modules

# 安装 netcat 用于端口检测
RUN apt-get update && apt-get install -y netcat-openbsd && rm -rf /var/lib/apt/lists/*

# 创建必要的目录结构
RUN mkdir -p /app/browser-profile /tmp/playwright-output /tmp/playwright-browsers-backup /app/storage && \
  chown -R ${USERNAME}:${USERNAME} /app/browser-profile /tmp/playwright-output /tmp/playwright-browsers-backup /app/storage

USER ${USERNAME}

# 将浏览器复制到备份目录（镜像内保留副本）
COPY --from=browser --chown=${USERNAME}:${USERNAME} ${PLAYWRIGHT_BROWSERS_PATH} /tmp/playwright-browsers-backup
COPY --chown=${USERNAME}:${USERNAME} cli.js package.json smithery-config.json proxy-server.js verify-browser.js init-browser.sh ./

# 设置脚本执行权限
USER root
RUN chmod +x init-browser.sh
USER ${USERNAME}

# 运行时验证备份
RUN ls -la /tmp/playwright-browsers-backup || echo "Browser backup check" && \
  echo "✅ Runtime stage ready"

# Set environment variables to force binding to all interfaces
ENV HOST=0.0.0.0
ENV PORT=8081

# 健康检查 - 验证代理服务器可用（方案 A：需要更长的预热时间）
HEALTHCHECK --interval=30s --timeout=10s --start-period=90s --retries=3 \
  CMD node -e "const http = require('http'); \
    http.get('http://localhost:8081/health', (res) => { \
      process.exit(res.statusCode === 200 ? 0 : 1); \
    }).on('error', () => process.exit(1));"

# 启动流程：方案 A - 同步预热后启动
COPY --chown=${USERNAME}:${USERNAME} entrypoint.sh ./
USER root
RUN chmod +x entrypoint.sh
USER ${USERNAME}
ENTRYPOINT ["./entrypoint.sh"]
