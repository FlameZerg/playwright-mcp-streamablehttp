#!/bin/sh
# 鍚屾鍚姩鍏ュ彛鑴氭湰 - 鏂规 A锛氶鐑悗鎵弿
# 绛栫暐锛氱‘淇濇祻瑙堝櫒鍜屽悗绔畬鍏ㄥ氨缁悗鎵嶅惎鍔ㄤ唬鐞嗘湇鍔″櫒

set -e

echo "=========================================="
echo "馃殌 Playwright MCP Server - Warmup Mode"
echo "=========================================="

# 姝ラ 1: 鍚屾鍒濆鍖栨祻瑙堝櫒
echo "鈴?[1/3] 鍒濆鍖栨祻瑙堝櫒..."
./init-browser.sh

if [ ! -d "${PLAYWRIGHT_BROWSERS_PATH:-/ms-playwright}" ]; then
  echo "鉂?娴忚鍣ㄥ垵濮嬪寲澶辫触"
  exit 1
fi

echo "鉁?[1/3] 娴忚鍣ㄥ氨缁?

# 姝ラ 2: 鍚姩 Playwright 鍚庣(鍚庡彴)
echo "鈴?[2/3] 鍚姩 Playwright 鍚庣..."
node cli.js \
  --headless \
  --browser chromium \
  --no-sandbox \
  --port 8082 \
  --isolated \
  --shared-browser-context \
  --save-session \
  --timeout-action=60000 \
  --timeout-navigation=60000 \
  --output-dir=/tmp/playwright-output &

BACKEND_PID=$!

# 绛夊緟鍚庣灏辩华(鏈€澶?30 绉?
echo "鈴?绛夊緟鍚庣鍚姩..."
for i in $(seq 1 30); do
  if nc -z localhost 8082 2>/dev/null; then
    echo "鉁?[2/3] 鍚庣灏辩华"
    break
  fi
  if [ $i -eq 30 ]; then
    echo "鉂?鍚庣鍚姩瓒呮椂"
    kill $BACKEND_PID 2>/dev/null || true
    exit 1
  fi
  sleep 1
done

# 姝ラ 3: 鍚姩浠ｇ悊鏈嶅姟鍣?
echo "鈴?[3/3] 鍚姩浠ｇ悊鏈嶅姟鍣?.."
echo "鉁?鏈嶅姟瀹屽叏灏辩华锛屽紑濮嬬洃鍚姹?
echo "=========================================="

# 鍚姩浠ｇ悊鏈嶅姟鍣?鍓嶅彴)
exec node proxy-server.js
