/**
 * gstack Cognitive Roles — Maps Garry Tan's gstack framework roles
 * into OpenClaw's AgentCapability system.
 *
 * Each role represents a distinct cognitive mode (CEO, Engineer, QA, etc.)
 * that can be dynamically registered into the LeaderAgent's AgentRegistry.
 *
 * These roles use OpenClaw's local delegate endpoint (self-delegation)
 * with specialized system prompts for each cognitive mode.
 *
 * Reference: https://github.com/garrytan/gstack
 */

import type { AgentCapability } from "./leader-agent.js";
import type { AgentRegistry } from "./leader-agent.js";

// ─── gstack Role Definitions ───

const DEFAULT_DELEGATE_URL = "http://localhost:18789/delegate";

/** Validate and resolve the gstack delegate URL with safe fallback */
export function resolveGstackDelegateUrl(): string {
  const raw = process.env.OPENCLAW_DELEGATE_URL || DEFAULT_DELEGATE_URL;
  try {
    const url = new URL(raw);
    if (!["http:", "https:"].includes(url.protocol)) {
      console.error(
        `[gstack-roles] Invalid protocol in OPENCLAW_DELEGATE_URL: ${url.protocol}, using default`,
      );
      return DEFAULT_DELEGATE_URL;
    }
    return url.toString();
  } catch {
    console.error(`[gstack-roles] Invalid OPENCLAW_DELEGATE_URL: ${raw}, using default`);
    return DEFAULT_DELEGATE_URL;
  }
}

/** Lazy-evaluated: resolved at access time to support Docker late binding */
function getGstackDelegateUrl(): string {
  return resolveGstackDelegateUrl();
}

/** Build gstack roles with lazily-resolved delegate URL. */
export function getGstackRoles(): AgentCapability[] {
  return [
    {
      agentId: "gstack-ceo",
      name: "CEO 產品審查",
      triggers: [
        "需求",
        "優先級",
        "產品方向",
        "使用者價值",
        "商業價值",
        "策略",
        "roadmap",
        "prioritize",
        "product",
        "requirement",
      ],
      targetUrl: getGstackDelegateUrl(),
      category: "gstack",
      systemPrompt: [
        "你是一位創辦人級產品審查者。",
        "以使用者價值和商業影響為核心評估需求。",
        "產出：1) 需求可行性評估 2) 優先級建議 3) 潛在風險 4) 建議的 MVP 範圍。",
        "用繁體中文回覆。",
      ].join("\n"),
    },
    {
      agentId: "gstack-eng",
      name: "工程主管審查",
      triggers: [
        "架構",
        "數據流",
        "測試策略",
        "技術債",
        "效能",
        "architecture",
        "data flow",
        "tech debt",
        "performance",
        "scalability",
      ],
      targetUrl: getGstackDelegateUrl(),
      category: "gstack",
      systemPrompt: [
        "你是一位工程主管，負責架構審查與技術決策。",
        "評估重點：1) 資料流與依賴關係 2) 可擴展性瓶頸 3) 測試策略 4) 技術債影響。",
        "產出具體的技術方案與風險評估。用繁體中文回覆。",
      ].join("\n"),
    },
    {
      agentId: "gstack-review",
      name: "Staff Engineer 審查",
      triggers: [
        "code review",
        "bug",
        "安全",
        "程式碼審查",
        "漏洞",
        "review",
        "security",
        "vulnerability",
        "code quality",
      ],
      targetUrl: getGstackDelegateUrl(),
      category: "gstack",
      systemPrompt: [
        "你是一位 Staff Engineer，專責生產級程式碼審查。",
        "獵殺重點：1) 邏輯錯誤 2) 安全漏洞 (OWASP Top 10) 3) 效能問題 4) 可維護性。",
        "以嚴格標準評估，僅報告真正的問題，不做無謂的風格建議。用繁體中文回覆。",
      ].join("\n"),
    },
    {
      agentId: "gstack-qa",
      name: "QA 自動測試",
      triggers: [
        "測試",
        "QA",
        "迴歸",
        "品質",
        "覆蓋率",
        "test",
        "regression",
        "quality",
        "coverage",
        "e2e",
      ],
      targetUrl: getGstackDelegateUrl(),
      category: "gstack",
      systemPrompt: [
        "你是一位 QA Lead，執行 Diff-aware 品質驗證。",
        "流程：1) 分析 git diff 識別受影響模組 2) 生成針對性測試案例 3) 執行迴歸測試 4) 報告覆蓋率缺口。",
        "重點關注邊界條件與使用者流程。用繁體中文回覆。",
      ].join("\n"),
    },
    {
      agentId: "gstack-ship",
      name: "Release Engineer",
      triggers: ["發布", "deploy", "release", "上線", "版本", "ship", "publish", "merge", "tag"],
      targetUrl: getGstackDelegateUrl(),
      category: "gstack",
      systemPrompt: [
        "你是一位 Release Engineer，負責自動化發布流程。",
        "流程：1) 同步最新主分支 2) 執行完整測試套件 3) 建構 changelog 4) 推送並建立 PR。",
        "確保所有檢查通過才進行發布。用繁體中文回覆。",
      ].join("\n"),
    },
    {
      agentId: "gstack-browse",
      name: "QA 瀏覽器測試",
      triggers: [
        "瀏覽器",
        "UI",
        "截圖",
        "視覺",
        "元件",
        "browser",
        "screenshot",
        "visual",
        "playwright",
        "ui test",
      ],
      targetUrl: getGstackDelegateUrl(),
      category: "gstack",
      systemPrompt: [
        "你是一位 QA 瀏覽器測試專家，使用持久化 Playwright 執行視覺與互動測試。",
        "重點：1) 頁面渲染正確性 2) 互動流程驗證 3) 截圖比對 4) 跨裝置兼容性。",
        "用繁體中文回覆。",
      ].join("\n"),
    },
    {
      agentId: "gstack-retro",
      name: "回顧分析",
      triggers: [
        "回顧",
        "retrospective",
        "反思",
        "趨勢",
        "歷史",
        "retro",
        "review history",
        "commit history",
        "團隊回饋",
      ],
      targetUrl: getGstackDelegateUrl(),
      category: "gstack",
      systemPrompt: [
        "你是一位工程主管，負責回顧分析。",
        "分析：1) 近期 commit 模式與趨勢 2) 反覆出現的問題 3) 技術債累積方向 4) 改善建議。",
        "用繁體中文回覆。",
      ].join("\n"),
    },
    {
      agentId: "gstack-browser-setup",
      name: "瀏覽器 Session 管理",
      triggers: [
        "cookie",
        "session",
        "登入",
        "認證狀態",
        "browser session",
        "login state",
        "auth cookie",
      ],
      targetUrl: getGstackDelegateUrl(),
      category: "gstack",
      systemPrompt: [
        "你是一位瀏覽器 session 管理專家。",
        "負責：1) Cookie 注入與管理 2) 登入狀態維護 3) 認證 token 刷新 4) Session 隔離。",
        "用繁體中文回覆。",
      ].join("\n"),
    },
  ];
}

// ─── Registration Helper ───

/**
 * Register all gstack cognitive roles into an AgentRegistry.
 * Returns the count of successfully registered roles.
 */
export function registerGstackRoles(registry: AgentRegistry): number {
  let count = 0;
  for (const role of getGstackRoles()) {
    if (registry.register(role)) {
      count++;
    }
  }
  return count;
}

/**
 * Unregister all gstack roles from a registry.
 * Returns the count of successfully removed roles.
 */
export function unregisterGstackRoles(registry: AgentRegistry): number {
  let count = 0;
  for (const role of getGstackRoles()) {
    if (registry.unregister(role.agentId)) {
      count++;
    }
  }
  return count;
}
