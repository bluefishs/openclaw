#!/usr/bin/env bash
# rotate-secrets.sh — Automated secret rotation for CK_OpenClaw
#
# Usage:
#   ./scripts/rotate-secrets.sh [--gateway] [--mcp] [--all] [--dry-run]
#
# Prerequisites:
#   - .env file exists in project root
#   - Docker Compose is running (for restart)
#
# IMPORTANT: ANTHROPIC_API_KEY must be rotated via the Anthropic Console.
#            This script cannot generate a new one automatically.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="$PROJECT_ROOT/.env"
BACKUP_DIR="$PROJECT_ROOT/.env-backups"
DRY_RUN=false
ROTATE_GATEWAY=false
ROTATE_MCP=false

# ─── Argument parsing ───

for arg in "$@"; do
  case "$arg" in
    --gateway)   ROTATE_GATEWAY=true ;;
    --mcp)       ROTATE_MCP=true ;;
    --all)       ROTATE_GATEWAY=true; ROTATE_MCP=true ;;
    --dry-run)   DRY_RUN=true ;;
    -h|--help)
      echo "Usage: $0 [--gateway] [--mcp] [--all] [--dry-run]"
      echo ""
      echo "Options:"
      echo "  --gateway   Rotate OPENCLAW_GATEWAY_TOKEN"
      echo "  --mcp       Rotate MCP_SERVICE_TOKEN"
      echo "  --all       Rotate all auto-rotatable tokens"
      echo "  --dry-run   Show what would change without modifying files"
      echo ""
      echo "NOTE: ANTHROPIC_API_KEY must be rotated manually at:"
      echo "  https://console.anthropic.com/settings/keys"
      exit 0
      ;;
    *)
      echo "Unknown option: $arg" >&2
      exit 1
      ;;
  esac
done

if ! $ROTATE_GATEWAY && ! $ROTATE_MCP; then
  echo "No rotation target specified. Use --gateway, --mcp, or --all."
  echo "Run with --help for usage."
  exit 1
fi

# ─── Helpers ───

generate_token() {
  local length="${1:-44}"
  # Use openssl if available, else /dev/urandom
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -base64 "$length" | tr -d '\n/+=' | head -c "$length"
  else
    head -c 256 /dev/urandom | base64 | tr -d '\n/+=' | head -c "$length"
  fi
}

mask_token() {
  local token="$1"
  if [ "${#token}" -ge 12 ]; then
    echo "...${token: -8}"
  else
    echo "***"
  fi
}

update_env_var() {
  local var_name="$1"
  local new_value="$2"

  if $DRY_RUN; then
    echo "[DRY-RUN] Would update $var_name → $(mask_token "$new_value")"
    return
  fi

  if grep -q "^${var_name}=" "$ENV_FILE" 2>/dev/null; then
    # Use a temp file to avoid in-place sed portability issues
    local tmp
    tmp="$(mktemp)"
    sed "s|^${var_name}=.*|${var_name}=${new_value}|" "$ENV_FILE" > "$tmp"
    mv "$tmp" "$ENV_FILE"
    echo "[OK] Updated $var_name → $(mask_token "$new_value")"
  else
    echo "${var_name}=${new_value}" >> "$ENV_FILE"
    echo "[OK] Added $var_name → $(mask_token "$new_value")"
  fi
}

# ─── Pre-flight checks ───

if [ ! -f "$ENV_FILE" ]; then
  echo "ERROR: $ENV_FILE not found. Cannot rotate secrets." >&2
  exit 1
fi

# ─── Backup ───

if ! $DRY_RUN; then
  mkdir -p "$BACKUP_DIR"
  backup_name=".env.backup.$(date +%Y%m%d_%H%M%S)"
  cp "$ENV_FILE" "$BACKUP_DIR/$backup_name"
  echo "Backup: $BACKUP_DIR/$backup_name"
fi

# ─── Rotate ───

if $ROTATE_GATEWAY; then
  echo ""
  echo "── Rotating OPENCLAW_GATEWAY_TOKEN ──"
  new_gateway=$(generate_token 64)
  update_env_var "OPENCLAW_GATEWAY_TOKEN" "$new_gateway"
fi

if $ROTATE_MCP; then
  echo ""
  echo "── Rotating MCP_SERVICE_TOKEN ──"
  new_mcp=$(generate_token 44)
  update_env_var "MCP_SERVICE_TOKEN" "$new_mcp"
fi

# ─── Post-rotation: reminder ───

echo ""
echo "════════════════════════════════════════════════════"
if $DRY_RUN; then
  echo "DRY-RUN complete. No changes made."
else
  echo "Rotation complete."
  echo ""
  echo "Next steps:"
  echo "  1. Restart Docker services:"
  echo "     docker compose down && docker compose up -d"
  echo ""
  echo "  2. Update NemoClaw if it references these tokens:"
  echo "     Edit CK_NemoClaw/docker-compose.yml or its .env"
  echo ""
  echo "  3. If ANTHROPIC_API_KEY needs rotation:"
  echo "     → https://console.anthropic.com/settings/keys"
  echo "     → Generate new key → Update .env → Restart"
fi
echo "════════════════════════════════════════════════════"
