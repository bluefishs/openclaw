#!/bin/bash
# 確認 LINE webhook 指向 Tailscale Funnel 固定 URL
# 由 startup.bat 和 watchdog.sh 呼叫

set -euo pipefail

CONTAINER_NAME="openclaw_engine"
TAILSCALE_URL="https://ck-aaron.tailafa5cd.ts.net"
WEBHOOK_ENDPOINT="${TAILSCALE_URL}/line/webhook"

# Verify Tailscale is running
if ! tailscale status >/dev/null 2>&1; then
  echo "[update-line-webhook] Tailscale not running, skipping"
  exit 1
fi

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

# Update to Tailscale Funnel URL
curl -s -X PUT \
  -H "Authorization: Bearer $LINE_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"endpoint\":\"$WEBHOOK_ENDPOINT\"}" \
  https://api.line.me/v2/bot/channel/webhook/endpoint >/dev/null 2>&1

echo "[update-line-webhook] Updated: $CURRENT -> $WEBHOOK_ENDPOINT"
