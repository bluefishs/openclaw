# CK_OpenClaw 專案指引

> 本文件為 Claude Code 在此專案的入口指引。

## 快速參照

- **上游開發規範**: [AGENTS.md](./AGENTS.md)（OpenClaw upstream 原始規範，PR/CI/coding style 參考用）
- **CK 開發規範**: 見下方「CK 專屬開發規範」段落
- **技能整合**: [SKILL_INTEGRATION_PLAN.md](./SKILL_INTEGRATION_PLAN.md)
- **品質驗證**: [SKILL_QA_SOP.md](./SKILL_QA_SOP.md)
- **維運 SOP**: Claude Memory `reference_ops_runbook.md`（LINE 排查、Docker 健檢、開機復原）

## API 金鑰策略（2026-03-16 起生效）

### 強制規則
1. **禁止在第三方工具中使用 OAuth Token 或個人訂閱帳號**
2. **全面使用 Anthropic API Console 申請 Key 並設定預算上限**
3. 不得設定或建議使用 GEMINI_API_KEY、第三方 OAuth refresh_token
4. 所有 LLM 呼叫統一走 Anthropic API 或本地 Ollama

### 允許的 API 來源
| 來源 | 用途 | 管理方式 |
|------|------|----------|
| Anthropic API Console | LLM 推論 | API Key + 預算上限 |
| Ollama (本地) | 輕量推論 | 無需 API Key |
| OpenClaw Gateway Token | 內部認證 | 環境變數，不可明文寫入文件 |

### 禁止的 API 來源
- Google AI Studio (GEMINI_API_KEY)
- Google OAuth2 refresh_token（用於直接存取 Google API 的情境）
- 任何需個人訂閱帳號的第三方服務 API

> **例外**: Claude MCP 整合（如 MCP Google Calendar）不受此限，因其透過 Claude Desktop 授權，不需自行管理 OAuth token。

## 安全規範

- 所有 token、secret 必須透過環境變數注入，禁止明文寫入任何 .md 或設定檔
- LINE channelSecret/channelAccessToken 需定期輪替
- 參照 [SECURITY.md](./SECURITY.md) 和全域 `~/.claude/rules/security.md`

## 部署架構

> **重要**：Gateway container (`openclaw_engine`) 由 `CK_NemoClaw/docker-compose.yml` 管理，
> 不是 `CK_OpenClaw/docker-compose.yml`。修改 Gateway 環境變數或 DNS 設定需編輯 NemoClaw compose。

| 元件 | 來源 | 說明 |
|------|------|------|
| `openclaw_engine` | CK_NemoClaw compose | Gateway 主進程 |
| `openclaw_nginx` | CK_NemoClaw compose | HTTPS 反向代理 (port 18443) |
| `shared_redis` | CK_NemoClaw compose | 共用 Redis（Memory + TaskTracker） |
| `nemoclaw_tower` | CK_NemoClaw compose | 跨域協調控制平面 |
| `openclaw-ollama-1` | CK_OpenClaw compose | 本地 LLM (Ollama) |
| `openclaw-browser` | CK_OpenClaw compose | Headless Chrome CDP (port 9222) |

### 通訊頻道

| 頻道 | 模式 | 外部 URL | 注意事項 |
|------|------|----------|----------|
| Telegram `@Aaron_ckbot` [default] | **Polling** | 不需要 | 主助理：公文、知識、一般對話 |
| Telegram `@jujuia_ckbot` [jujuia] | **Polling** | 不需要 | 技術助理：瀏覽器、資料分析、開發 |
| LINE `小花貓Aroan` | Webhook | ngrok 動態 URL | Tailscale Funnel 缺 HTTP/2 ALPN，LINE 需走 ngrok |

> **Session 模式**: `main`（預設）— LINE 和 Telegram 共享同一對話記憶。
> **語音**: Edge TTS（zh-TW-HsiaoChenNeural）+ 自動語音轉錄。`tts.auto: "inbound"` — 收到語音訊息時回覆語音。
> **群組**: 兩個 Telegram Bot 可同時在群組中，用 @mention 觸發對應 Bot。功能分工可透過 `groups.<id>.skills` 和 `groups.<id>.systemPrompt` 設定。

### 自癒機制

```
開機 → scripts/startup.bat
  → 等待 Docker → Container healthy → 確認 Tailscale → 啟動 ngrok → 更新 LINE webhook → 啟動 watchdog
  → watchdog 每 5 分鐘：偵測 7 項 → 自動修復 → 修不了才 Telegram 告警

偵測項目：Docker Engine → Container Health → Gateway HTTP → Tailscale → ngrok → LINE Webhook → Telegram Polling
```

安裝：以管理員執行 `scripts\install-startup-task.bat`

## 架構概覽（2026-03-31 更新）

```
                    ┌───────────────────────────┐
                    │ LINE / Telegram / Web UI  │  ← 用戶介面（共享 session）
                    └────────────┬──────────────┘
                             │
                    ┌────────▼─────────┐
                    │  OpenClaw Gateway │  ← WebSocket + RPC (port 18789)
                    │  src/gateway/     │
                    ├──────────────────┤
                    │  Auto-Reply      │  ← 訊息處理管線
                    │  Channel Routing │  ← 30+ 頻道插件
                    │  Agent System    │  ← 多 Agent + Skills
                    │  Memory/Vector   │  ← SQLite + embeddings
                    ├──────────────────┤
                    │  Workflow Engine │  ← gstack 認知角色編排
                    │  LeaderAgent     │  ← Fan-out/Fan-in 多代理
                    │  EventRelay      │  ← Redis Pub/Sub → SSE
                    └──┬──────────┬────┘
                       │          │
              ┌────────▼──┐  ┌───▼──────────┐
              │  Ollama   │  │ Browser CDP  │
              │  (LLM)    │  │ (Headless    │
              │  :11434   │  │  Chrome)     │
              └───────────┘  │  :9222       │
                             └──────────────┘
```

### 核心模組
| 模組 | 路徑 | 職責 |
|------|------|------|
| Gateway | `src/gateway/` (260 files) | WebSocket 伺服器、RPC、認證、Workflow、gstack |
| Browser | `src/browser/` (142 files) | CDP 控制、Playwright、Chrome extension relay |
| Channels | `src/channels/` + `extensions/` (59 + 45 dirs) | 30+ 頻道插件架構 |
| Auto-Reply | `src/auto-reply/` (64 files) | 訊息管線：接收→解析→回覆→分發 |
| Agents | `src/agents/` (547 files) | Pi embedded runner、60+ tools、Skills |
| Memory | `src/memory/` (106 files) | 向量搜尋、embeddings、TaskTracker、ConversationMemory |
| Config | `src/config/` (207 files) | Zod schema 驗證、設定 I/O、遷移 |
| Web UI | `ui/` | Vite + Lit Web Components + Workflow Dashboard |
| Plugin SDK | `src/plugin-sdk/` (111 files) | 插件公開 API |
| Extensions | `extensions/ck-platform/` | CK Platform 跨域查詢 NemoClaw gateway |
| Skills | `skills/` (57 skills) | ck-missive NemoClaw agent、claude-multi-agent 等 |

### Workflow 編排子系統（2026-03 新增）
| 模組 | 檔案 | 職責 |
|------|------|------|
| WorkflowChain | `src/gateway/workflow-chain.ts` | 事件驅動步驟連鎖（Plan→Implement→QA→Ship） |
| LeaderAgent | `src/gateway/leader-agent.ts` | 查詢分解 + Fan-out/Fan-in 多代理協調 |
| EventRelay | `src/gateway/event-relay.ts` | Redis Pub/Sub → SSE ticket exchange |
| TaskTracker | `src/memory/task-tracker.ts` | Redis-backed 任務狀態追蹤 + approve/reject |
| gstack-roles | `src/gateway/gstack-roles.ts` | 8 認知角色定義與管理 |
| gstack-bootstrap | `src/gateway/gstack-bootstrap.ts` | 角色系統啟動 + reconcile timer |
| delegate-http | `src/gateway/delegate-http.ts` | HTTP 委派 API（/delegate, /tasks/*, /events） |
| correlation | `src/gateway/correlation.ts` | 分散式呼叫追蹤 correlation ID |

### 關鍵技術決策
- **Plugin-First**: 頻道、hooks、skills 全部插件化
- **Multi-Agent**: 每 agent 獨立 session（`agent:agentId:sessionKey`）
- **gstack Workflow**: 認知角色自動編排，closed-loop QA 重試
- **Security-First Docker**: non-root、cap_drop ALL、no-new-privileges
- **Hot-Reload**: 設定 + skills 支援不重啟更新
- **SSE Ticket Exchange**: 避免長效 token 暴露於 URL/logs

## Skills/Commands 工作流程

### 完整開發流程（認知模式切換）
```
/brainstorming → /plan → /tdd → /code-review → /qa → /ship
     釐清需求    分解任務  RED-GREEN   品質審查   影響測試  發布
```

### Commands 一覽
| Command | 認知模式 | 用途 |
|---------|----------|------|
| `/brainstorming` | 產品思維 | 釐清需求、探索方案 |
| `/plan` | 架構師 | 分解為可執行任務，等待確認 |
| `/tdd` | 開發者 | RED-GREEN-REFACTOR 循環 |
| `/build-fix` | 建置工程師 | 逐一修復建置錯誤 |
| `/code-review` | Staff Engineer | 生產級 bug 獵殺 + 安全審查 |
| `/qa` | QA Lead | Diff-aware 影響範圍測試 |
| `/verify` | 驗證工程師 | 證據式完成確認 |
| `/ship` | Release Engineer | 自動化 sync→test→push→PR |
| `/learn` | 知識管理 | 記錄陷阱與解決方案 |
| `/reflect` | 回顧分析 | 記憶模式分析與清理 |
| `/retro` | 工程主管 | Commit 歷史回顧與趨勢分析 |
| `/python-review` | Python 審查 | PEP 8、型別、安全 |

### Bug 修復流程
```
/systematic-debugging → /tdd → /verify → /ship
    根因分析          寫失敗測試   驗證修復   發布
```

## CK 專屬開發規範

> 以下規範適用於 CK_OpenClaw fork 的自訂開發，與上游 AGENTS.md 互補。

### 語言與溝通
- 所有文件、commit message 說明、PR 描述使用**繁體中文**
- commit type prefix 保持英文（feat, fix, refactor, docs, test, chore, perf, ci）
- 技術術語保留英文原文

### 分支策略
- `main`: 穩定版本，與上游同步
- `feat/*`: 功能開發分支（如 `feat/headless-chrome`）
- 合併前必須通過 `/code-review` → `/qa` → `/verify`

### 自訂模組開發原則
- CK 自訂程式碼集中在：`extensions/ck-platform/`、`skills/ck-missive/`、`scripts/`
- 不修改 upstream `src/` 核心模組，除非是 bug fix 需回報上游
- 新增 skill 遵循 [SKILL_QA_SOP.md](./SKILL_QA_SOP.md)

### 環境與部署
- 開發機：Windows 11 + Docker Desktop + WSL2
- LLM：Anthropic API（主）+ Ollama 本地（輔）
- 通訊：LINE（Tailscale Funnel webhook）+ Telegram（polling）
- Gateway 由 `CK_NemoClaw/docker-compose.yml` 管理，本 repo 的 compose 管理 Ollama + Browser

### 安全底線
- 禁止明文 secret（參照 `~/.claude/rules/security.md`）
- 禁止第三方 OAuth / 個人訂閱 API（參照上方 API 金鑰策略）
- Docker 容器必須：`no-new-privileges` + `cap_drop: ALL` + resource limits
