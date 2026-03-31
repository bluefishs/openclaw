#!/bin/bash
# LINE Bot 健康監控腳本
# 用途：確認 LINE webhook 連通性（ngrok + Gateway），失敗時輸出警告
# LINE 平台需要 HTTP/2 ALPN，Tailscale Funnel 不支援，因此 LINE 走 ngrok
# 可接入 cron 或 OpenClaw cron system-event

set -euo pipefail

NGROK_API="http://127.0.0.1:4040/api/tunnels"

STATUS="OK"
DETAILS=""

# 1. Check Docker container
CONTAINER_STATUS=$(docker inspect openclaw_engine --format '{{.State.Health.Status}}' 2>/dev/null || echo "unknown")
if [ "$CONTAINER_STATUS" != "healthy" ]; then
  STATUS="CRITICAL"
  DETAILS="${DETAILS}\n- openclaw_engine container: $CONTAINER_STATUS"
fi

# 2. Check ngrok running
NGROK_URL=$(curl -s "$NGROK_API" 2>/dev/null | \
  grep -o '"public_url":"https://[^"]*"' | head -1 | cut -d'"' -f4 || true)
if [ -z "$NGROK_URL" ]; then
  STATUS="CRITICAL"
  DETAILS="${DETAILS}\n- ngrok 未運行（LINE webhook 斷線）"
  NGROK_URL="(not running)"
fi

# 3. Check LINE webhook endpoint reachable (via ngrok)
WH_HTTP="n/a"
if [ "$NGROK_URL" != "(not running)" ]; then
  WH_HTTP=$(curl -s -o /dev/null -w "%{http_code}" -X POST -H "Content-Type: application/json" -d '{}' "${NGROK_URL}/line/webhook" --max-time 10 2>/dev/null || echo "000")
  if [ "$WH_HTTP" != "400" ] && [ "$WH_HTTP" != "401" ]; then
    STATUS="CRITICAL"
    DETAILS="${DETAILS}\n- LINE webhook 端點異常 (HTTP $WH_HTTP, expected 400)"
  fi
fi

# 4. Check Tailscale (general, not for LINE)
TS_RUNNING="no"
if tailscale status >/dev/null 2>&1; then
  TS_RUNNING="yes"
fi

# Output
echo "LINE Health: $STATUS"
echo "Timestamp: $(date -Iseconds)"
echo "Container: $CONTAINER_STATUS"
echo "ngrok: $NGROK_URL"
echo "Webhook: HTTP $WH_HTTP"
echo "Tailscale: $TS_RUNNING"
if [ -n "$DETAILS" ]; then
  echo -e "Issues:$DETAILS"
fi

# Exit code for cron integration
[ "$STATUS" = "OK" ] && exit 0
[ "$STATUS" = "WARN" ] && exit 1
exit 2
