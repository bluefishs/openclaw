#!/bin/bash
# ═══════════════════════════════════════════════════════════════════
# CK_OpenClaw Watchdog — 自動健康檢查 + 自癒 + 告警
#
# 設計原則：能自動修的不打擾人，修不了才告警
#
# 執行方式：
#   手動:  bash scripts/watchdog.sh
#   排程:  Windows Task Scheduler 每 5 分鐘執行
#   持續:  bash scripts/watchdog.sh --loop
#
# 告警通道：Telegram Bot（不依賴 LINE，避免循環依賴）
# ═══════════════════════════════════════════════════════════════════

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LOG_DIR="${SCRIPT_DIR}/../logs"
LOG_FILE="${LOG_DIR}/watchdog-$(date +%Y%m%d).log"
STATE_FILE="${LOG_DIR}/.watchdog-state.json"

# ─── Config ───
TAILSCALE_URL="https://ck-aaron.tailafa5cd.ts.net"
NGROK_API="http://127.0.0.1:4040/api/tunnels"
GATEWAY_LOCAL="http://127.0.0.1:18789"
CONTAINER_NAME="openclaw_engine"
CHECK_INTERVAL=300  # 5 minutes (for --loop mode)
MAX_AUTO_RESTARTS=3 # per day

# Telegram alert config (read from env or container)
TG_BOT_TOKEN="${WATCHDOG_TG_TOKEN:-}"
TG_CHAT_ID="${WATCHDOG_TG_CHAT:-7558783721}"

# ─── Helpers ───
mkdir -p "$LOG_DIR"

log() {
  local ts
  ts=$(date '+%Y-%m-%d %H:%M:%S')
  echo "[$ts] $1" | tee -a "$LOG_FILE"
}

get_today_restart_count() {
  if [ -f "$STATE_FILE" ]; then
    local today
    today=$(date +%Y%m%d)
    grep -c "auto_restart:$today" "$STATE_FILE" 2>/dev/null || echo "0"
  else
    echo "0"
  fi
}

record_restart() {
  local today
  today=$(date +%Y%m%d)
  echo "auto_restart:$today:$(date +%H%M%S)" >> "$STATE_FILE"
}

send_telegram_alert() {
  local msg="$1"
  if [ -z "$TG_BOT_TOKEN" ]; then
    # Try to read from container config
    TG_BOT_TOKEN=$(docker exec "$CONTAINER_NAME" sh -c \
      'cat /home/node/.openclaw/openclaw.json' 2>/dev/null | \
      grep -o '"botToken":"[^"]*"' | head -1 | cut -d'"' -f4 || true)
  fi
  if [ -n "$TG_BOT_TOKEN" ] && [ -n "$TG_CHAT_ID" ]; then
    curl -s -X POST \
      "https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage" \
      -d "chat_id=${TG_CHAT_ID}" \
      -d "text=${msg}" \
      -d "parse_mode=Markdown" \
      --max-time 10 >/dev/null 2>&1 || true
  fi
}

# ─── Check Functions ───

check_docker_engine() {
  if ! docker info >/dev/null 2>&1; then
    log "CRITICAL: Docker Desktop not running"
    return 2
  fi
  return 0
}

check_container() {
  local status
  status=$(docker inspect "$CONTAINER_NAME" --format '{{.State.Health.Status}}' 2>/dev/null | head -1 || echo "missing")

  case "$status" in
    healthy)
      return 0
      ;;
    unhealthy|starting)
      log "WARN: $CONTAINER_NAME is $status"
      return 1
      ;;
    *)
      log "CRITICAL: $CONTAINER_NAME is $status"
      return 2
      ;;
  esac
}

check_gateway_http() {
  local code
  code=$(curl -s -o /dev/null -w "%{http_code}" "$GATEWAY_LOCAL/health" --max-time 5 2>/dev/null || echo "000")
  if [ "$code" = "200" ]; then
    return 0
  fi
  log "WARN: Gateway HTTP health returned $code"
  return 1
}

check_tailscale() {
  if tailscale status >/dev/null 2>&1; then
    # Verify Funnel is reachable externally
    local code
    code=$(curl -s -o /dev/null -w "%{http_code}" "${TAILSCALE_URL}/health" --max-time 10 2>/dev/null || echo "000")
    if [ "$code" = "200" ]; then
      return 0
    fi
    log "WARN: Tailscale running but Funnel unreachable (HTTP $code)"
    return 1
  fi
  log "WARN: Tailscale not running"
  return 1
}

check_ngrok() {
  local url
  url=$(curl -s "$NGROK_API" 2>/dev/null | \
    grep -o '"public_url":"https://[^"]*"' | head -1 | cut -d'"' -f4 || true)
  if [ -n "$url" ]; then
    return 0
  fi
  log "WARN: ngrok not running (LINE webhook depends on it)"
  return 1
}

check_line_webhook() {
  # Get ngrok URL for LINE webhook check
  local ngrok_url
  ngrok_url=$(curl -s "$NGROK_API" 2>/dev/null | \
    grep -o '"public_url":"https://[^"]*"' | head -1 | cut -d'"' -f4 || true)
  if [ -z "$ngrok_url" ]; then
    log "WARN: Cannot check LINE webhook — ngrok not running"
    return 1
  fi
  local code
  code=$(curl -s -o /dev/null -w "%{http_code}" -X POST \
    -H "Content-Type: application/json" -d '{}' \
    "${ngrok_url}/line/webhook" --max-time 10 2>/dev/null || echo "000")
  # 400 = Missing signature (correct behavior)
  if [ "$code" = "400" ] || [ "$code" = "401" ]; then
    return 0
  fi
  log "WARN: LINE webhook returned $code (expected 400)"
  return 1
}

check_telegram_polling() {
  local recent_log
  recent_log=$(docker logs "$CONTAINER_NAME" --since 5m 2>&1 | grep -c "\[telegram\]" 2>/dev/null || true)
  recent_log="${recent_log:-0}"
  # Telegram should have at least some polling activity in 5 min
  if [ "$recent_log" -gt 0 ] 2>/dev/null; then
    # Check for stall
    local stall
    stall=$(docker logs "$CONTAINER_NAME" --since 5m 2>&1 | grep -c "Polling stall" 2>/dev/null || true)
    stall="${stall:-0}"
    if [ "$stall" -gt 0 ] 2>/dev/null; then
      log "WARN: Telegram polling stall detected"
      return 1
    fi
    return 0
  fi
  log "WARN: No Telegram activity in 5 minutes"
  return 1
}

# ─── Self-Heal Functions ───

heal_tailscale() {
  log "HEAL: Attempting to restart Tailscale..."
  if command -v tailscale >/dev/null 2>&1; then
    tailscale up --reset 2>/dev/null || true
    sleep 5
    if tailscale status >/dev/null 2>&1; then
      log "HEAL: Tailscale restarted successfully"
      return 0
    fi
  fi
  log "HEAL FAILED: Tailscale could not be restarted"
  return 1
}

heal_ngrok() {
  log "HEAL: Starting ngrok for LINE webhook..."
  nohup ngrok http 18789 --log=stdout > "$LOG_DIR/ngrok.log" 2>&1 &
  sleep 8

  local url
  url=$(curl -s "$NGROK_API" 2>/dev/null | \
    grep -o '"public_url":"https://[^"]*"' | head -1 | cut -d'"' -f4 || true)

  if [ -n "$url" ]; then
    log "HEAL: ngrok started at $url"
    # Update LINE webhook to ngrok URL
    bash "$(dirname "$0")/update-line-webhook.sh" 2>/dev/null || true
    return 0
  fi
  log "HEAL FAILED: ngrok did not start"
  return 1
}

heal_container() {
  local count
  count=$(get_today_restart_count)
  if [ "$count" -ge "$MAX_AUTO_RESTARTS" ]; then
    log "SKIP: Already $count auto-restarts today (max $MAX_AUTO_RESTARTS)"
    return 1
  fi

  log "HEAL: Restarting $CONTAINER_NAME..."
  docker restart "$CONTAINER_NAME" >/dev/null 2>&1
  record_restart
  sleep 20

  if check_container; then
    log "HEAL: $CONTAINER_NAME restarted successfully"
    return 0
  fi
  log "HEAL FAILED: $CONTAINER_NAME still unhealthy after restart"
  return 1
}

# ─── Main Check Loop ───

run_checks() {
  local issues=0
  local healed=0
  local alerts=""

  log "─── Watchdog check started ───"

  # 1. Docker Engine
  if ! check_docker_engine; then
    alerts="${alerts}\n🔴 Docker Desktop 未啟動"
    ((issues++))
    # Can't heal this — need human
    log "CHECK DONE: issues=$issues healed=$healed (Docker not running, aborting)"
    if [ -n "$alerts" ]; then
      send_telegram_alert "⚠️ *CK Watchdog Alert*$(echo -e "$alerts")"
    fi
    return 2
  fi

  # 2. Container health
  if ! check_container; then
    if heal_container; then
      ((healed++))
    else
      alerts="${alerts}\n🔴 openclaw\_engine 異常，自動重啟失敗"
      ((issues++))
    fi
  fi

  # 3. Gateway HTTP
  if ! check_gateway_http; then
    # Container might just need more time after restart
    sleep 10
    if ! check_gateway_http; then
      alerts="${alerts}\n🟡 Gateway HTTP 無回應"
      ((issues++))
    fi
  fi

  # 4. Tailscale (for general connectivity, not LINE)
  if ! check_tailscale; then
    if heal_tailscale; then
      ((healed++))
    else
      alerts="${alerts}\n🟡 Tailscale 無法連線"
      ((issues++))
    fi
  fi

  # 5. ngrok (required for LINE webhook — Tailscale Funnel lacks HTTP/2 ALPN)
  if ! check_ngrok; then
    if heal_ngrok; then
      ((healed++))
    else
      alerts="${alerts}\n🟡 ngrok 無法啟動（LINE webhook 斷線）"
      ((issues++))
    fi
  fi

  # 6. LINE webhook (only if ngrok is up)
  if check_ngrok; then
    if ! check_line_webhook; then
      alerts="${alerts}\n🟡 LINE webhook 端點異常"
      ((issues++))
    fi
  fi

  # 7. Telegram polling
  if ! check_telegram_polling; then
    alerts="${alerts}\n🟡 Telegram polling 不穩定"
    ((issues++))
  fi

  # Summary
  log "CHECK DONE: issues=$issues healed=$healed"

  if [ "$issues" -gt 0 ] && [ -n "$alerts" ]; then
    send_telegram_alert "⚠️ *CK Watchdog Alert*
$(date '+%Y-%m-%d %H:%M')
$(echo -e "$alerts")
已自癒: $healed 項"
  fi

  if [ "$healed" -gt 0 ] && [ "$issues" -eq 0 ]; then
    log "ALL HEALED: $healed issue(s) auto-fixed"
  fi

  return $issues
}

# ─── Entry Point ───

if [ "${1:-}" = "--loop" ]; then
  log "Watchdog starting in loop mode (interval: ${CHECK_INTERVAL}s)"
  while true; do
    run_checks || true
    sleep "$CHECK_INTERVAL"
  done
else
  run_checks
  exit $?
fi
