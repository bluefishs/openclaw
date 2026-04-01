/**
 * Metrics Alert Handler — subscribes to EventRelay and forwards alerts to Telegram.
 *
 * Usage: call `startMetricsAlertHandler()` during gateway bootstrap.
 * Requires TELEGRAM_ALERT_BOT_TOKEN and TELEGRAM_ALERT_CHAT_ID env vars.
 *
 * Design: Fire-and-forget, rate-limited (max 1 alert per 5 min to avoid spam).
 */

const ALERT_COOLDOWN_MS = 5 * 60_000; // 5 minutes between alerts
let lastAlertAt = 0;

export type MetricsAlertConfig = {
  botToken: string;
  chatId: string;
  cooldownMs?: number;
};

function resolveConfig(): MetricsAlertConfig | null {
  const botToken = process.env.TELEGRAM_ALERT_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_ALERT_CHAT_ID;
  if (!botToken || !chatId) {
    return null;
  }
  return {
    botToken,
    chatId,
    cooldownMs: parseInt(process.env.TELEGRAM_ALERT_COOLDOWN_MS || "", 10) || ALERT_COOLDOWN_MS,
  };
}

async function sendTelegramAlert(config: MetricsAlertConfig, text: string): Promise<void> {
  const now = Date.now();
  const cooldown = config.cooldownMs ?? ALERT_COOLDOWN_MS;
  if (now - lastAlertAt < cooldown) {
    return; // Rate limited
  }
  lastAlertAt = now;

  try {
    const url = `https://api.telegram.org/bot${config.botToken}/sendMessage`;
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: config.chatId,
        text,
        parse_mode: "Markdown",
      }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    console.warn(`[metrics-alert] Telegram send failed: ${String(err)}`);
  }
}

/**
 * Process a metrics_alert event payload and send to Telegram if configured.
 */
export async function handleMetricsAlert(payload: { alerts?: string[] }): Promise<void> {
  const config = resolveConfig();
  if (!config) {
    return;
  }

  const alerts = payload.alerts;
  if (!alerts || alerts.length === 0) {
    return;
  }

  const header = "⚠️ *CK\\_OpenClaw Metrics Alert*";
  const body = alerts.map((a) => `• ${a.replace(/[_*[\]()~`>#+=|{}.!-]/g, "\\$&")}`).join("\n");
  const text = `${header}\n\n${body}\n\n_${new Date().toISOString()}_`;

  await sendTelegramAlert(config, text);
}

/** Reset rate limiter (for testing). */
export function resetAlertCooldown(): void {
  lastAlertAt = 0;
}
