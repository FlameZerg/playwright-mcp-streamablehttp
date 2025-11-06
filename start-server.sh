#!/bin/sh

# Set the PORT environment variable if not set
export PORT=${PORT:-8081}

# 设置持久化目录
export PLAYWRIGHT_MCP_OUTPUT_DIR=${PLAYWRIGHT_MCP_OUTPUT_DIR:-/tmp/playwright-output}

# 配置用户数据目录（如果未使用 --isolated 模式）
if [ -n "$PLAYWRIGHT_USER_DATA_DIR" ]; then
  USER_DATA_ARG="--user-data-dir=$PLAYWRIGHT_USER_DATA_DIR"
else
  # 默认使用持久化目录
  USER_DATA_ARG="--user-data-dir=/home/node/.cache/ms-playwright-mcp"
fi

# Start the server with explicit host binding
# The server may ignore --host flag, so we'll use a different approach
exec node cli.js --headless --browser chromium --no-sandbox --port $PORT $USER_DATA_ARG
