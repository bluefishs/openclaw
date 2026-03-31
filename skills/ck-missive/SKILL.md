---
name: ck-missive
description: "CK_Missive NemoClaw 代理人 (v5.0) — 公文查詢、知識圖譜、派工管理。23 真工具 + 自省閉環 + vLLM 本地推理 + 主動推薦。"
metadata:
  {
    "openclaw":
      {
        "emoji": "📋",
        "requires": { "env": ["CK_MISSIVE_API_URL"] },
        "primaryEnv": "CK_MISSIVE_API_URL",
      },
  }
---

# CK_Missive 公文管理 AI 引擎

透過 HTTP API 呼叫 CK_Missive 的乾坤智能體，查詢公文、知識圖譜、派工單、專案等領域資料。

## Setup

1. 確認 CK_Missive 後端運行中 (預設 `http://localhost:8001`)
2. 設定環境變數：

```bash
export CK_MISSIVE_API_URL="http://localhost:8001"
export CK_MISSIVE_SERVICE_TOKEN="your-service-token"  # 可選，開發模式免設定
```

## 查詢公文

使用 `curl` 呼叫 CK_Missive 的同步 Agent API：

```bash
curl -s -X POST "${CK_MISSIVE_API_URL}/api/ai/agent/query" \
  -H "Content-Type: application/json" \
  -H "X-Service-Token: ${CK_MISSIVE_SERVICE_TOKEN}" \
  -d '{"question": "工務局最近的公文有哪些", "session_id": "openclaw_session"}' \
  | jq '.answer'
```

## 可用查詢類型

### 公文查詢

```bash
# 搜尋公文
curl -s -X POST "${CK_MISSIVE_API_URL}/api/ai/agent/query" \
  -H "Content-Type: application/json" \
  -d '{"question": "搜尋關於道路工程的公文"}' | jq '.answer'

# 公文統計
curl -s -X POST "${CK_MISSIVE_API_URL}/api/ai/agent/query" \
  -H "Content-Type: application/json" \
  -d '{"question": "本月收文統計"}' | jq '.answer'
```

### 知識圖譜

```bash
# 查詢實體關係
curl -s -X POST "${CK_MISSIVE_API_URL}/api/ai/agent/query" \
  -H "Content-Type: application/json" \
  -d '{"question": "工務局和交通局的關係"}' | jq '.answer'

# 實體詳情
curl -s -X POST "${CK_MISSIVE_API_URL}/api/ai/agent/query" \
  -H "Content-Type: application/json" \
  -d '{"question": "桃園市政府的實體詳情"}' | jq '.answer'
```

### 派工管理

```bash
# 查詢派工單
curl -s -X POST "${CK_MISSIVE_API_URL}/api/ai/agent/query" \
  -H "Content-Type: application/json" \
  -d '{"question": "最近的派工單"}' | jq '.answer'

# 對應公文
curl -s -X POST "${CK_MISSIVE_API_URL}/api/ai/agent/query" \
  -H "Content-Type: application/json" \
  -d '{"question": "這張派工單對應哪些公文"}' | jq '.answer'
```

### 專案與廠商

```bash
# 查詢專案
curl -s -X POST "${CK_MISSIVE_API_URL}/api/ai/agent/query" \
  -H "Content-Type: application/json" \
  -d '{"question": "正在執行的專案有哪些"}' | jq '.answer'

# 廠商查詢
curl -s -X POST "${CK_MISSIVE_API_URL}/api/ai/agent/query" \
  -H "Content-Type: application/json" \
  -d '{"question": "測量公司的聯絡資訊"}' | jq '.answer'
```

### 系統健康

```bash
# 系統狀態
curl -s -X POST "${CK_MISSIVE_API_URL}/api/ai/agent/query" \
  -H "Content-Type: application/json" \
  -d '{"question": "系統健康狀態"}' | jq '.answer'

# ER 圖
curl -s -X POST "${CK_MISSIVE_API_URL}/api/ai/agent/query" \
  -H "Content-Type: application/json" \
  -d '{"question": "畫出資料庫 ER 圖"}' | jq '.answer'
```

## API 回應格式

```json
{
  "success": true,
  "answer": "工務局本月共收到 15 份公文...",
  "sources": [{ "doc_number": "府工用字第1140001234號", "subject": "..." }],
  "tools_used": ["search_documents", "get_statistics"],
  "latency_ms": 1250
}
```

## 乾坤智能體能力

| 能力       | 說明                                        |
| ---------- | ------------------------------------------- |
| 18 工具    | 公文/派工/專案/廠商/圖譜/統計/ER圖          |
| 模式學習   | MD5 精確匹配 (0ms) + Embedding 語意 (100ms) |
| 自我進化   | 每 50 次查詢自動升級種子/降級失敗模式       |
| 跨會話記憶 | Redis + PostgreSQL 雙層持久化               |
| 對話壓縮   | 3-Tier 自適應壓縮 (6+ 輪自動觸發)           |
| 引用驗證   | 精確+模糊匹配確保引用準確性                 |

## 注意事項

- API 回應逾時: 90 秒 (可在 CK_Missive 配置調整)
- 速率限制: 10 次/分鐘
- 最大回答長度: 5000 字元
- Session ID: 傳入相同 session_id 可保持對話上下文
- 開發模式: localhost 呼叫免 Token，生產需設定 `CK_MISSIVE_SERVICE_TOKEN`
