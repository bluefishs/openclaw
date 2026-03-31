# OpenClaw 技能整合規劃書

> 建立日期：2026-02-07 | 專案：CK_OpenClaw | 助手：小花貓

## 1. 現況盤點

### 已部署的自訂技能

| 技能                 | 位置                            | 功能                                                      |
| -------------------- | ------------------------------- | --------------------------------------------------------- |
| `claude-multi-agent` | `~/.openclaw/workspace/skills/` | 多 Agent 協作（公文/地籍/數據/系統）                      |
| `document-workflow`  | `~/.openclaw/workspace/skills/` | 公文處理、期限追蹤、品質檢核                              |
| `ck-missive`         | `skills/ck-missive/`            | NemoClaw 公文查詢 agent（v5.0, 23 tools, vLLM, 知識圖譜） |

### 已部署的擴充模組

| 擴充          | 位置                      | 功能                                           |
| ------------- | ------------------------- | ---------------------------------------------- |
| `ck-platform` | `extensions/ck-platform/` | CK\_ 平台跨域查詢工具（NemoClaw gateway 整合） |

### 已配置的系統整合

- LINE Plugin: 已啟用（channelSecret + channelAccessToken 已設定）
- Browser Relay: 已啟用（headless + extension + LAN 三種模式）
- Ollama: 已設定（Qwen 2.5 3B，本地 LLM）
- Tailscale: 已配置（遠端存取）
- Docker: 已配置（安全強化）

### 停用/未啟用的功能

- google-calendar: **永久停用**（API 金鑰策略禁止 Google OAuth2，改用 MCP 整合）
- himalaya (Email): 內建可用但尚未啟用

### 2026-03 新增系統整合

- gstack Workflow: 8 認知角色 + WorkflowChain + LeaderAgent（149 tests）
- Headless Chrome: CDP 容器化瀏覽器自動化（docker-compose `openclaw-browser`）
- SSE Ticket Exchange: 安全事件串流（EventRelay + Redis Pub/Sub）
- 自癒機制: watchdog 自動修復 + Telegram 告警

## 2. 需求缺口分析

| 缺口領域     | 重要性 | 現況                                 | 改善方案                                            |
| ------------ | ------ | ------------------------------------ | --------------------------------------------------- |
| 日曆整合     | ✅     | **MCP 已可用**（8 個 gcal\_\* 工具） | 免 OAuth，透過 Claude MCP 直接操作 Google Calendar  |
| PDF 深度處理 | 高     | nano-pdf 待替代                      | 改用 Anthropic API PDF 解析或 land-survey-assistant |
| 自動化提醒   | ✅     | cron-reminder 已部署                 | 已完成（Phase 2-3）                                 |
| 瀏覽器自動化 | ✅     | Headless Chrome CDP 已部署           | 容器化 + browser-helper skill                       |
| 資料視覺化   | 中     | 無                                   | 評估 ClawHub 技能                                   |
| 地圖/GIS     | 低     | 無                                   | 評估 local-places 或自訂開發                        |
| Email 管理   | 低     | himalaya 可用                        | 按需啟用                                            |

## 3. 安全規範

### ClawHavoc 事件警示

2026年2月發現 341 個惡意 ClawHub 技能，主要手法：

- 憑證竊取（335 個，部署 AMOS 惡意軟體）
- 身份冒充（偽裝知名工具）
- 資料外洩（反向 Shell 後門）

### 安裝前安全檢查清單

```
[ ] 查看技能的 GitHub 來源倉庫
[ ] 確認作者帳號可信度
[ ] 審查 SKILL.md 中的 bash 命令
[ ] 確認技能未被社群舉報（>3 舉報自動隱藏）
[ ] 優先選擇 awesome-openclaw-skills 已收錄的技能
[ ] 絕不執行要求下載外部腳本的技能
[ ] 檢查環境變數和 API 金鑰要求是否合理
```

### 安全優先順序

1. 內建技能（最安全）
2. 自訂開發（完全可控）
3. ClawHub 已審核技能（需人工審查）

## 4. 推薦技能清單

### A. 內建技能 — 直接啟用

| 技能            | 用途              | 優先級                                                           |
| --------------- | ----------------- | ---------------------------------------------------------------- |
| ~~`nano-pdf`~~  | ~~地籍 PDF 解析~~ | ~~P0~~ **永久停用**（需 GEMINI_API_KEY，改用 Anthropic API PDF） |
| `healthcheck`   | 系統安全稽核      | P0                                                               |
| `summarize`     | 文件摘要          | P1                                                               |
| `clawhub`       | 技能市集管理      | P1                                                               |
| `skill-creator` | 自訂技能建立輔助  | P1                                                               |
| `model-usage`   | Token 用量監控    | P2                                                               |
| `canvas`        | 內容編輯創作      | P2                                                               |
| `himalaya`      | Email 管理        | P2                                                               |

### B. 自訂技能 — 開發計畫

| 技能                    | 目的                                        | 開發優先級 |
| ----------------------- | ------------------------------------------- | ---------- |
| `land-survey-assistant` | 地籍查估專用（PDF + 座標驗證 + 成果檢核）   | P1         |
| `cron-reminder`         | 整合 document-workflow 期限到 cron 自動提醒 | P1         |
| `line-enhanced`         | LINE 進階互動（推播 + 圖文選單 + 快速回覆） | P2         |

### C. ClawHub 社群技能 — 需審查

| 分類                    | 推薦方向       | 安裝命令                                    |
| ----------------------- | -------------- | ------------------------------------------- |
| Browser Automation (69) | webapp-testing | `npx clawhub@latest install webapp-testing` |
| Data & Analytics (18)   | 報表/圖表生成  | 需進一步評估                                |
| PDF & Documents (35)    | 進階 PDF 處理  | 需進一步評估                                |

## 5. 整合路線圖

### Phase 1：基礎強化（2/7 - 2/9）✅ 已完成

- [x] ~~啟用 google-calendar 插件~~ → 已因 API 策略（2026-03-16）停止，改用 MCP 整合
- [x] ~~測試 nano-pdf 技能~~ → 已因 API 策略停止（需 GEMINI_API_KEY），待 Anthropic 替代方案
- [x] 執行 healthcheck 安全檢查（4 CRITICAL → 0 CRITICAL）
- [x] 測試 summarize 文件摘要（v0.10.0 已安裝測試通過）

### Phase 2：工作流程整合（2/10 - 2/16）✅ 已完成

- [x] 設定 cron 整合 document-workflow 期限提醒（HEARTBEAT.md + setup-cron-jobs.bat）
- [x] 建立 land-survey-assistant 技能（含 quality_check.py 已測試）
- [x] 建立 browser-helper 瀏覽器自動化技能
- [x] 整合 summarize 到公文處理流程（document-workflow 已更新）

### Phase 3：進階功能（2/17 - 2/28）✅ 已完成

- [x] 開發 cron-reminder 自訂技能（含 LINE 訊息模板）
- [x] 評估 ClawHub 數據分析技能（chart-image、table-image 推薦，暫不安裝）
- [x] 設定 token-monitor Token 監控（替代 macOS 專用 model-usage）
- [x] 建立技能測試與品質驗證 SOP（SKILL_QA_SOP.md）

### Phase 4：持續優化（3 月起）🔄 進行中

**已完成（3/16 - 3/27）：**

- [x] API 金鑰策略全面轉向 Anthropic API Console + 預算上限
- [x] 新增 gstack 8 認知角色 + WorkflowChain + LeaderAgent
- [x] 新增 ck-missive skill（v5.0, 23 tools）
- [x] 新增 ck-platform extension（跨域 NemoClaw 查詢）
- [x] Workflow Dashboard UI + SSE streaming + step chain 視覺化
- [x] 234 tests / 14 suites 全通過（含安全修復、test mock 修復）
- [x] 安全強化：safeTokenEqual、rate limiting、memory caps、Redis shutdown
- [x] docker-compose.yml 結構修復 + DNS 優化（Telegram 5.9s → 0.86s）
- [x] GOOGLE_CALENDAR_SETUP.md 已刪除（原已 deprecated，git history 保留）
- [x] Workspace 整理（103 → 44 active + 43 archived）
- [x] 修正 workspace 違規配置（LanceDB → Ollama、notification → Telegram only）
- [x] 自癒機制：watchdog + startup.bat + cron 告警
- [x] 維運 SOP 建立（LINE 排查、Docker 健檢、重開機復原）

**持續進行：**

- [ ] 定期 `clawhub update --all`（每月一次）
- [ ] 定期 healthcheck 安全稽核（每月一次）
- [ ] Token 消耗優化調整
- [ ] 安裝開機自啟排程（`scripts\install-startup-task.bat`）
- [x] LINE webhook delivery suspension 重置（2026-03-27 完成，webhook→Tailscale Funnel）
- [x] 腳本 ngrok→Tailscale 全面遷移（2026-03-31，4 腳本修復）
- [x] openclaw-browser cap_drop: ALL 補齊（2026-03-31）
- [ ] feat/headless-chrome 分支合併策略（建議 squash merge，見記憶 project_merge_plan_headless_chrome.md）
- [ ] upstream 版本同步 v2026.3.13 → v2026.3.30（合併分支時處理）
- [ ] vitest 覆蓋率 75% → 80%

## 6. 技能開發範本

### 建立新技能

```bash
# 目錄結構
~/.openclaw/workspace/skills/<skill-name>/
├── SKILL.md           # 技能定義（必要）
├── scripts/           # 輔助腳本
├── references/        # 參考資料
└── assets/            # 靜態資源
```

### SKILL.md 範本

```yaml
---
name: skill-name
description: 技能簡述，說明何時觸發使用
---
# 技能名稱

## 功能說明
...
## 使用方式
...
```

### 測試技能

```bash
openclaw agent --message "use my new skill"
```

## 7. 配置變更記錄

| 日期       | 變更項目             | 說明                                                                            |
| ---------- | -------------------- | ------------------------------------------------------------------------------- |
| 2026-02-03 | 初始部署             | OpenClaw + LINE + Docker                                                        |
| 2026-02-04 | Browser Relay        | 啟用瀏覽器自動化                                                                |
| 2026-02-07 | 技能整合規劃         | 本文件建立                                                                      |
| 2026-02-08 | Phase 1-3 完成       | 安全修復、6 技能部署、4 排程、QA SOP                                            |
| 2026-02-08 | Control UI 設定      | 助手身份「小花貓」、LAN 存取、繁體中文                                          |
| 2026-03-16 | API 金鑰策略         | 全面 Anthropic API；禁止 Google OAuth/GEMINI                                    |
| 2026-03-24 | gstack 整合          | 8 認知角色 + WorkflowChain + LeaderAgent (149 tests)                            |
| 2026-03-24 | ck-missive v5.0      | NemoClaw 公文查詢 agent（23 tools, 知識圖譜）                                   |
| 2026-03-25 | Docker 穩定性        | .wslconfig 16GB + DNS 優化 + healthcheck 調整                                   |
| 2026-03-26 | 安全強化             | safeTokenEqual, rate limiting, memory caps                                      |
| 2026-03-26 | 自癒機制             | watchdog + startup.bat + Telegram 告警                                          |
| 2026-03-27 | Headless Chrome      | CDP 容器化瀏覽器（Dockerfile.sandbox-browser）                                  |
| 2026-03-27 | 文件一致性修正       | ngrok→Tailscale Funnel、刪除 deprecated 文件                                    |
| 2026-03-27 | docker-compose 優化  | 移除 session keys、參數化 LAN IP                                                |
| 2026-03-31 | 腳本 ngrok→Tailscale | startup.bat、watchdog.sh、update-line-webhook.sh、check-line-health.sh 全面遷移 |
| 2026-03-31 | Docker 安全補齊      | openclaw-browser 補上 cap_drop: ALL                                             |
| 2026-03-31 | 系統檢視             | 文件對齊、版本確認（upstream v2026.3.30 vs local v2026.3.13）                   |

## 8. 存取資訊

> **安全提醒**: Gateway token、LINE Bot ID 等敏感資訊不應明文寫入文件。
> 請透過環境變數或 `openclaw config` 管理。

### Control UI

- LAN: `http://<LAN_IP>:18789/#token=<GATEWAY_TOKEN>`
- 本機: `http://localhost:18789/#token=<GATEWAY_TOKEN>`
- 注意：URL 使用 `#token=`（hash fragment），非 `?token=`

### LINE Bot

- 透過 `openclaw config` 查看 LINE 設定
- DM Policy: allowlist

### 已知限制

- Docker CLI 在 Windows CMD/PowerShell 會卡住，需透過 Docker Desktop GUI 管理容器
- Gateway auth token 變更需重啟容器才生效
- Control UI LAN 存取需 `allowInsecureAuth: true`（security audit 會報 CRITICAL）
- Ollama 未啟動時會出現 "Failed to discover Ollama models" 警告（不影響功能）

## 9. API 金鑰策略（2026-03-16 更新）

### 變更事項

- **停止使用** 第三方 OAuth Token 和個人訂閱帳號
- **全面轉向** Anthropic API Console 申請 Key + 預算上限
- **禁止設定** GEMINI_API_KEY、Google OAuth2 refresh_token
- **保留** 本地 Ollama 作為輕量推論替代方案

### 影響範圍

| 原規劃                              | 新方案                                               |
| ----------------------------------- | ---------------------------------------------------- |
| nano-pdf (需 GEMINI_API_KEY)        | **永久停用** — 改用 Anthropic API PDF 解析           |
| google-calendar (需 OAuth2)         | **已替代** — MCP Google Calendar（8 工具，免 OAuth） |
| summarize (需 GEMINI/ANTHROPIC KEY) | 僅使用 Anthropic API Key                             |

---

_本規劃書由 Claude Code 協助建立_
