# 技能測試與品質驗證 SOP

> 適用：所有自訂技能和 ClawHub 安裝技能

## 1. 技能結構驗證

### 必要檔案檢查

```
[ ] SKILL.md 存在
[ ] YAML frontmatter 包含 name 和 description
[ ] description 清楚描述觸發條件
[ ] 目錄名稱與 name 一致（kebab-case）
[ ] 無多餘文件（README.md, CHANGELOG.md 等）
```

### 結構規範

```
skill-name/
├── SKILL.md              # 必要
├── scripts/              # 可選：可執行腳本
├── references/           # 可選：參考資料
└── assets/               # 可選：輸出用檔案
```

## 2. 安全審查（ClawHub 技能必要）

### 安裝前檢查

```
[ ] 作者 GitHub 帳號年齡 > 1 週
[ ] VirusTotal 掃描結果為 benign
[ ] SKILL.md 中無可疑 bash 命令
[ ] 不要求下載外部腳本
[ ] 環境變數需求合理
[ ] 在 awesome-openclaw-skills 列表中（加分）
[ ] 無被社群舉報記錄
```

### bash 命令紅旗

以下模式需特別警惕：

- `curl | bash` 或 `wget | sh`
- `eval` 搭配外部輸入
- 存取 `~/.ssh/`, `~/.aws/`, `~/.openclaw/` 中的憑證檔
- `base64 -d` 解碼並執行
- 連線到非知名外部服務

## 3. 功能測試

### 觸發測試

```bash
# 用 OpenClaw agent 測試技能觸發
openclaw agent --message "使用 <skill-name> 做 <specific task>"
```

### 測試案例模板

| 測試項目 | 輸入          | 預期結果     | 實際結果 | 通過 |
| -------- | ------------- | ------------ | -------- | ---- |
| 基本觸發 | 觸發關鍵字    | 技能被載入   |          |      |
| 核心功能 | 標準使用情境  | 正確輸出     |          |      |
| 邊界條件 | 空輸入/大檔案 | 合理錯誤處理 |          |      |
| 腳本執行 | 執行 scripts/ | 無錯誤退出   |          |      |

### 腳本測試

```bash
# Python 腳本
python -X utf8 scripts/<script>.py

# 確認退出碼
echo $?  # 應為 0
```

## 4. 整合測試

### 技能間互動

```
[ ] 與 document-workflow 不衝突
[ ] 與 claude-multi-agent 可配合
[ ] 觸發條件不與其他技能重疊
[ ] 共享 references 一致性
```

### 系統整合

```
[ ] Gateway 運行中可正常載入
[ ] LINE 推送結果格式正確
[ ] cron 排程可正常觸發
[ ] 不影響主 session 穩定性
```

## 5. 品質指標

### 通過標準

- 結構驗證：100% 通過
- 安全審查：0 紅旗（ClawHub 技能）
- 功能測試：核心功能 100% 通過
- 整合測試：無衝突

### 驗證頻率

- 新建技能：上線前完整驗證
- ClawHub 安裝：安裝前安全審查 + 安裝後功能測試
- 技能更新：更新後回歸測試核心功能
- 定期：每月用 `openclaw security audit --deep` 全面檢查

## 6. 目前技能驗證狀態

> 上次全面更新：2026-03-31。下次排定驗證：2026-04-15。

| 技能                  | 結構 | 安全    | 功能                     | 整合             | 上次驗證   | 備註                       |
| --------------------- | ---- | ------- | ------------------------ | ---------------- | ---------- | -------------------------- |
| claude-multi-agent    | ✅   | ✅ 自訂 | ⚠️ 待測                  | ⚠️ 待測          | 2026-02-07 | 需排定功能+整合測試        |
| document-workflow     | ✅   | ✅ 自訂 | ⚠️ 待測                  | ⚠️ 待測          | 2026-02-08 | 需排定功能+整合測試        |
| land-survey-assistant | ✅   | ✅ 自訂 | ✅ quality_check.py 通過 | ⚠️ 待測          | 2026-02-08 | 整合測試待排               |
| browser-helper        | ✅   | ✅ 自訂 | ✅ Gateway 連線正常      | ⚠️ 待測          | 2026-02-09 | Headless Chrome CDP 已上線 |
| cron-reminder         | ✅   | ✅ 自訂 | ✅ 4 排程全部 ok         | ✅ LINE 推送正常 | 2026-02-09 |                            |
| token-monitor         | ✅   | ✅ 自訂 | ✅ status --deep 通過    | ⚠️ 待測          | 2026-02-08 |                            |
| ck-missive            | ✅   | ✅ 自訂 | ✅ v5.0, 23 tools        | ✅ NemoClaw 整合 | 2026-03-24 | gstack 整合後新增          |

### 待辦：技能驗證排程

- [ ] claude-multi-agent：完整功能測試 + 整合測試（優先）
- [ ] document-workflow：完整功能測試 + 整合測試（優先）
- [ ] land-survey-assistant / browser-helper / token-monitor：整合測試
- [ ] 建議每月 15 日執行 `openclaw security audit --deep`
