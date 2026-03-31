#!/bin/bash
# LINE Bot 健康監控腳本
# 用途：確認 LINE webhook 連通性（Tailscale Funnel），失敗時輸出警告
# 可接入 cron 或 OpenClaw cron system-event

set -euo pipefail

WEBHOOK_URL="https://ck-aaron.tailafa5cd.ts.net/line/webhook"
HEALTH_URL="https://ck-aaron.tailafa5cd.ts.net/health"

STATUS="OK"
DETAILS=""

# 1. Check Tailscale status
TS_RUNNING="yes"
if ! tailscale status >/dev/null 2>&1; then
  STATUS="CRITICAL"
  DETAILS="${DETAILS}\n- Tailscale 未運行"
  TS_RUNNING="no"
fi

# 2. Check Tailscale Funnel reachability
TS_HTTP="000"
if [ "$TS_RUNNING" = "yes" ]; then
  TS_HTTP=$(curl -s -o /dev/null -w "%{http_code}" "$HEALTH_URL" --max-time 10 2>/dev/null || echo "000")
  if [ "$TS_HTTP" != "200" ]; then
    STATUS="WARN"
    DETAILS="${DETAILS}\n- Tailscale Funnel 無法連線 (HTTP $TS_HTTP)"
  fi
fi

# 3. Check Docker container
CONTAINER_STATUS=$(docker inspect openclaw_engine --format '{{.State.Health.Status}}' 2>/dev/null || echo "unknown")
if [ "$CONTAINER_STATUS" != "healthy" ]; then
  STATUS="CRITICAL"
  DETAILS="${DETAILS}\n- openclaw_engine container: $CONTAINER_STATUS"
fi

# 4. Check LINE webhook endpoint reachable
WH_HTTP=$(curl -s -o /dev/null -w "%{http_code}" -X POST -H "Content-Type: application/json" -d '{}' "$WEBHOOK_URL" --max-time 10 2>/dev/null || echo "000")
if [ "$WH_HTTP" != "400" ] && [ "$WH_HTTP" != "401" ]; then
  # 400 = Missing signature (correct rejection), anything else = problem
  STATUS="CRITICAL"
  DETAILS="${DETAILS}\n- LINE webhook 端點異常 (HTTP $WH_HTTP, expected 400)"
fi

# Output
echo "LINE Health: $STATUS"
echo "Timestamp: $(date -Iseconds)"
echo "Container: $CONTAINER_STATUS"
echo "Tailscale: $TS_RUNNING (Funnel HTTP $TS_HTTP)"
echo "Webhook: HTTP $WH_HTTP"
if [ -n "$DETAILS" ]; then
  echo -e "Issues:$DETAILS"
fi

# Exit code for cron integration
[ "$STATUS" = "OK" ] && exit 0
[ "$STATUS" = "WARN" ] && exit 1
exit 2
