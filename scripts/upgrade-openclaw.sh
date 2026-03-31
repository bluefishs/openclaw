#!/bin/bash
# ═══════════════════════════════════════════════════════════════
# OpenClaw 版本升級腳本
# 用途：從 v2026.3.13 升級到最新版
# 注意：會暫時中斷 Gateway，建議在低峰期執行
# ═══════════════════════════════════════════════════════════════

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"
NEMOCLAW_DIR="$(dirname "$REPO_DIR")/CK_NemoClaw"

echo "══════════════════════════════════"
echo "  OpenClaw Upgrade Script"
echo "══════════════════════════════════"

# 1. 確認當前版本
echo ""
echo "[1/5] Current version:"
docker exec openclaw_engine sh -c 'node dist/index.js --version 2>/dev/null' || echo "unknown"

# 2. Pull latest code
echo ""
echo "[2/5] Pulling latest upstream..."
cd "$REPO_DIR"
git fetch origin main
echo "Latest upstream: $(git log --oneline origin/main | head -1)"

# 3. Merge upstream (non-destructive)
echo ""
echo "[3/5] Merging upstream into current branch..."
echo "  ⚠️  Review conflicts if any, then press Enter to continue or Ctrl+C to abort"
read -r

git merge origin/main --no-edit || {
  echo "CONFLICT detected. Resolve manually, then re-run this script."
  exit 1
}

# 4. Rebuild Docker image
echo ""
echo "[4/5] Rebuilding Docker image..."
cd "$NEMOCLAW_DIR"
docker compose build openclaw
echo "Image rebuilt."

# 5. Redeploy
echo ""
echo "[5/5] Redeploying openclaw_engine..."
docker compose up -d openclaw
sleep 20

# Verify
NEW_VER=$(docker exec openclaw_engine sh -c 'node dist/index.js --version 2>/dev/null' || echo "unknown")
HEALTH=$(docker inspect openclaw_engine --format '{{.State.Health.Status}}' 2>/dev/null || echo "unknown")
echo ""
echo "══════════════════════════════════"
echo "  Upgrade complete!"
echo "  Version: $NEW_VER"
echo "  Health:  $HEALTH"
echo "══════════════════════════════════"
