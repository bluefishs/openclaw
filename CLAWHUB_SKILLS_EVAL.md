# ClawHub 技能評估記錄

> 評估日期：2026-02-08

## 推薦安裝（已審查、信譽良好）

### chart-image — 圖表產生器

- **作者**: Danny Shmueli (@dannyshmueli)
- **功能**: 9 種圖表（折線、長條、圓餅、熱力圖等），Vega-Lite + Sharp
- **安裝**: `npx clawhub@latest install chart-image`
- **優點**: 無外部 API 依賴，~200ms 渲染，低記憶體
- **適用**: 進度圖表、工作量分布、期限趨勢

### table-image — 表格 PNG 產生器

- **作者**: Danny Shmueli (@dannyshmueli)
- **功能**: JSON 資料轉 PNG 表格，支援暗色模式
- **安裝**: `npx clawhub@latest install table-image`
- **優點**: ~50ms 渲染，自動對齊，LINE/Discord 友好
- **適用**: 案件進度表、承辦人工作量表

### pdf-2 — PDF 處理工具箱

- **作者**: Sean Phan (seanphan)
- **功能**: PDF 文字提取、表格提取、OCR、合併分割、表單填寫
- **安裝**: 需確認 ClawHub slug
- **適用**: 地籍謄本 PDF 深度解析

## 暫不推薦

### ClickUp / GA4

- 需要額外第三方服務帳號，目前業務暫不需要

## 安全注意

- ClawHub 已整合 VirusTotal 掃描
- 安裝前仍需人工審查 SKILL.md 中的 bash 命令
- 優先選擇上述已審查的作者
