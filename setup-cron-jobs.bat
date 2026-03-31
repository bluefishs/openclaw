@echo off
REM ========================================
REM OpenClaw Cron Jobs 設定腳本
REM 需要 Gateway 運行中才能執行
REM
REM 注意：使用 --system-event（非 --message）
REM       不支援 --announce 和 --session 參數
REM ========================================

echo [1/4] 設定每日早晨期限檢查 (08:00 週一至週五)...
npx openclaw cron add ^
  --name "deadline-morning-check" ^
  --cron "0 8 * * 1-5" ^
  --tz "Asia/Taipei" ^
  --system-event "讀取 PROJECT_TASKS.md 檢查所有案件期限。依據提醒規則產生報告：(1)已逾期案件 (2)今日到期 (3)3天內到期 (4)7天內到期。用繁體中文回覆，並透過 LINE 推送給使用者。"

echo [2/4] 設定每日下午進度追蹤 (17:00 週一至週五)...
npx openclaw cron add ^
  --name "daily-progress" ^
  --cron "0 17 * * 1-5" ^
  --tz "Asia/Taipei" ^
  --system-event "讀取 PROJECT_TASKS.md 和 TASK_DASHBOARD.md 產生今日工作進度摘要。列出各案件目前進度百分比和待辦事項。用繁體中文回覆，並透過 LINE 推送給使用者。"

echo [3/4] 設定每週五週報生成 (16:00)...
npx openclaw cron add ^
  --name "weekly-report" ^
  --cron "0 16 * * 5" ^
  --tz "Asia/Taipei" ^
  --system-event "產生本週工作週報。包含：(1)本週完成案件 (2)進行中案件進度 (3)下週到期案件預警 (4)工作效率分析。用繁體中文回覆，並透過 LINE 推送給使用者。"

echo [4/4] 設定系統健康監控 (每 30 分鐘)...
npx openclaw cron add ^
  --name "system-health-check" ^
  --cron "*/30 * * * *" ^
  --tz "Asia/Taipei" ^
  --system-event "執行系統健康檢查：(1)確認 LINE webhook 可達（curl POST /line/webhook 應回 400）(2)確認 Telegram polling 活躍（查最近 log）(3)檢查 Docker container 狀態。如果發現異常，用繁體中文簡要說明問題和建議修復方式，透過 Telegram 告警。如果全部正常則不需回覆。"

echo.
echo Cron jobs 設定完成！
echo 驗證: npx openclaw cron list
npx openclaw cron list
pause
