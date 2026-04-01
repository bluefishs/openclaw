#!/usr/bin/env bash
# check-metrics.sh — 一鍵查詢 /metrics 端點，用於觀察期監控
#
# Usage:
#   ./scripts/check-metrics.sh                    # 使用 .env 中的 token
#   ./scripts/check-metrics.sh --json             # 輸出原始 JSON
#   ./scripts/check-metrics.sh --watch            # 每 30s 自動刷新
#   GATEWAY_URL=http://host:18789 ./scripts/check-metrics.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="$PROJECT_ROOT/.env"

# Load token from .env if not set
if [ -z "${MCP_SERVICE_TOKEN:-}" ] && [ -f "$ENV_FILE" ]; then
  MCP_SERVICE_TOKEN=$(grep '^MCP_SERVICE_TOKEN=' "$ENV_FILE" 2>/dev/null | cut -d= -f2- || true)
fi

GATEWAY_URL="${GATEWAY_URL:-http://127.0.0.1:18789}"
TOKEN="${MCP_SERVICE_TOKEN:-}"
OUTPUT_JSON=false
WATCH_MODE=false

for arg in "$@"; do
  case "$arg" in
    --json)  OUTPUT_JSON=true ;;
    --watch) WATCH_MODE=true ;;
    -h|--help)
      echo "Usage: $0 [--json] [--watch]"
      echo "  --json   Output raw JSON"
      echo "  --watch  Auto-refresh every 30s"
      echo ""
      echo "Env vars: GATEWAY_URL (default: http://127.0.0.1:18789)"
      echo "          MCP_SERVICE_TOKEN (auto-loaded from .env)"
      exit 0
      ;;
  esac
done

if [ -z "$TOKEN" ]; then
  echo "ERROR: MCP_SERVICE_TOKEN not set (check .env or env var)" >&2
  exit 1
fi

fetch_metrics() {
  curl -sS --max-time 10 \
    -H "X-Service-Token: $TOKEN" \
    "$GATEWAY_URL/metrics" 2>/dev/null
}

format_metrics() {
  local json="$1"

  # Parse with node (available in this project)
  node -e "
    const m = JSON.parse(process.argv[1]);
    const ts = m.timestamp || 'N/A';
    console.log('╔══════════════════════════════════════════════╗');
    console.log('║  CK_OpenClaw Metrics  ' + ts.slice(11,19) + '          ║');
    console.log('╠══════════════════════════════════════════════╣');

    if (m.memory) {
      const err = m.memory.saveTurnTotal > 0
        ? (m.memory.saveTurnErrors / m.memory.saveTurnTotal * 100).toFixed(1)
        : '0.0';
      console.log('║ Memory: ' + (m.memory.memoryUsed || 'N/A').padEnd(8)
        + ' │ ' + (m.memory.dbSize ?? 0) + ' keys │ ' + err + '% err' + ' '.repeat(3) + '║');
    }

    if (m.tasks) {
      console.log('║ Tasks:  ' + m.tasks.runningJobs + '/' + m.tasks.maxConcurrent
        + ' running' + ' '.repeat(22) + '║');
    }

    if (m.microcompact && m.microcompact.totalRuns > 0) {
      const saved = m.microcompact.totalCharsSaved;
      const fmt = saved >= 1e6 ? (saved/1e6).toFixed(1)+'M'
                : saved >= 1e3 ? (saved/1e3).toFixed(1)+'K'
                : String(saved);
      console.log('║ Compact: ' + fmt + ' chars saved │ '
        + m.microcompact.totalRuns + ' runs'
        + ' '.repeat(14) + '║');
    }

    const cbs = Object.entries(m.circuitBreakers || {});
    if (cbs.length > 0) {
      const open = cbs.filter(([,v]) => v.state === 'open').length;
      const status = open > 0 ? open + ' OPEN' : 'all healthy';
      console.log('║ Agents: ' + cbs.length + ' tracked │ ' + status
        + ' '.repeat(Math.max(0, 19 - status.length)) + '║');
    }

    if (m.alerts && m.alerts.length > 0) {
      console.log('╠══════════════════════════════════════════════╣');
      console.log('║ ⚠ ALERTS:' + ' '.repeat(36) + '║');
      for (const a of m.alerts) {
        const line = '║  • ' + a.slice(0, 40);
        console.log(line + ' '.repeat(Math.max(0, 47 - line.length)) + '║');
      }
    }

    console.log('╚══════════════════════════════════════════════╝');
  " "$json"
}

run_once() {
  local json
  json=$(fetch_metrics)
  if [ -z "$json" ]; then
    echo "ERROR: No response from $GATEWAY_URL/metrics" >&2
    return 1
  fi

  if $OUTPUT_JSON; then
    echo "$json" | node -e "process.stdin.on('data',d=>console.log(JSON.stringify(JSON.parse(d),null,2)))"
  else
    format_metrics "$json"
  fi
}

if $WATCH_MODE; then
  while true; do
    clear 2>/dev/null || true
    run_once || true
    echo ""
    echo "(refreshing every 30s, Ctrl+C to stop)"
    sleep 30
  done
else
  run_once
fi
