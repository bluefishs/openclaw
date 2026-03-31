#!/bin/bash
# 偵測 ngrok URL 並更新 LINE webhook
# LINE 平台需要 HTTP/2 ALPN，Tailscale Funnel 不支援，因此 LINE 走 ngrok
# 由 startup.bat 和 watchdog.sh 呼叫

set -euo pipefail

CONTAINER_NAME="openclaw_engine"
NGROK_API="http://127.0.0.1:4040/api/tunnels"

# Get ngrok public URL
NGROK_URL=$(curl -s "$NGROK_API" 2>/dev/null | \
  grep -o '"public_url":"https://[^"]*"' | head -1 | cut -d'"' -f4 || true)

if [ -z "$NGROK_URL" ]; then
  echo "[update-line-webhook] ngrok not running, skipping"
  exit 1
fi

WEBHOOK_ENDPOINT="${NGROK_URL}/line/webhook"

# Get LINE token from container config
LINE_TOKEN=$(docker exec "$CONTAINER_NAME" sh -c \
  'cat /home/node/.openclaw/openclaw.json' 2>/dev/null | \
  python3 -c "import sys,json; print(json.load(sys.stdin)['channels']['line']['channelAccessToken'])" 2>/dev/null || true)

if [ -z "$LINE_TOKEN" ]; then
  echo "[update-line-webhook] Cannot read LINE token from container"
  exit 1
fi

# Check current webhook
CURRENT=$(curl -s -H "Authorization: Bearer $LINE_TOKEN" \
  https://api.line.me/v2/bot/channel/webhook/endpoint 2>/dev/null | \
  grep -o '"endpoint":"[^"]*"' | cut -d'"' -f4 || true)

if [ "$CURRENT" = "$WEBHOOK_ENDPOINT" ]; then
  echo "[update-line-webhook] Already correct: $WEBHOOK_ENDPOINT"
  exit 0
fi

# Update to ngrok URL
curl -s -X PUT \
  -H "Authorization: Bearer $LINE_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"endpoint\":\"$WEBHOOK_ENDPOINT\"}" \
  https://api.line.me/v2/bot/channel/webhook/endpoint >/dev/null 2>&1

echo "[update-line-webhook] Updated: $CURRENT -> $WEBHOOK_ENDPOINT"
