# ------------------------------
# Base
# ------------------------------
# Base stage: Contains only the minimal dependencies required for runtime
# (node_modules and Playwright system dependencies)
FROM node:22-bookworm-slim AS base

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

ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

RUN npx -y playwright-core install --no-shell chromium

# ------------------------------
# Runtime
# ------------------------------
FROM base

ARG USERNAME=node
ENV NODE_ENV=production
# 保障中文日志显示正常
ENV LANG=C.UTF-8
ENV LC_ALL=C.UTF-8
ENV LANGUAGE=zh_CN:zh
ENV PLAYWRIGHT_MCP_OUTPUT_DIR=/tmp/playwright-output

# Set the correct ownership for the runtime user on production `node_modules`
RUN chown -R ${USERNAME}:${USERNAME} node_modules

USER ${USERNAME}

# 将浏览器直接固化到镜像
COPY --from=browser --chown=${USERNAME}:${USERNAME} /ms-playwright /ms-playwright
COPY --chown=${USERNAME}:${USERNAME} cli.js package.json smithery-config.json proxy-server.js ./

# Set environment variables to force binding to all interfaces
ENV HOST=0.0.0.0
ENV PORT=8081

# 直接启动代理服务器（浏览器已固化到镜像）
ENTRYPOINT ["node", "proxy-server.js"]
