/**
 * Overview Metrics Panel — renders /metrics data as stat cards in the dashboard.
 * Designed to slot below the existing overview cards section.
 */

import { html, nothing, type TemplateResult } from "lit";
import type { MetricsResult } from "../controllers/metrics.ts";

export type OverviewMetricsProps = {
  metrics: MetricsResult | null;
  loading: boolean;
  error: string | null;
};

function metricCard(
  label: string,
  value: string | TemplateResult,
  hint: string | TemplateResult,
  status: "ok" | "warn" | "error" = "ok",
) {
  return html`
    <div class="ov-card" data-kind="metric" data-status=${status} style="cursor:default">
      <span class="ov-card__label">${label}</span>
      <span class="ov-card__value">${value}</span>
      <span class="ov-card__hint">${hint}</span>
    </div>
  `;
}

function formatCharsSaved(chars: number): string {
  if (chars >= 1_000_000) {
    return `${(chars / 1_000_000).toFixed(1)}M`;
  }
  if (chars >= 1_000) {
    return `${(chars / 1_000).toFixed(1)}K`;
  }
  return String(chars);
}

export function renderOverviewMetrics(
  props: OverviewMetricsProps,
): TemplateResult | typeof nothing {
  if (props.loading && !props.metrics) {
    return html`
      <section class="ov-metrics">
        <h3 class="ov-recent__title">System Metrics</h3>
        <div class="ov-cards">
          ${[0, 1, 2, 3].map(
            (i) => html`
              <div class="ov-card" style="cursor:default;animation-delay:${i * 50}ms">
                <span class="skeleton skeleton-line" style="width:60px;height:10px"></span>
                <span class="skeleton skeleton-stat"></span>
                <span class="skeleton skeleton-line skeleton-line--medium" style="height:12px"></span>
              </div>
            `,
          )}
        </div>
      </section>
    `;
  }

  if (!props.metrics) {
    if (props.error) {
      return html`
        <section class="ov-metrics">
          <h3 class="ov-recent__title">System Metrics</h3>
          <p class="ov-metrics__error">Unable to load: ${props.error}</p>
        </section>
      `;
    }
    return nothing;
  }

  const m = props.metrics;
  const cards: TemplateResult[] = [];

  // Memory card
  if (m.memory) {
    const errorRate =
      m.memory.saveTurnTotal > 0
        ? ((m.memory.saveTurnErrors / m.memory.saveTurnTotal) * 100).toFixed(1)
        : "0";
    const memStatus = !m.memory.healthy ? "error" : parseFloat(errorRate) > 5 ? "warn" : "ok";
    cards.push(
      metricCard(
        "Memory",
        m.memory.memoryUsed ?? "N/A",
        html`${m.memory.dbSize ?? 0} keys · ${errorRate}% errors`,
        memStatus,
      ),
    );
  }

  // Tasks card
  if (m.tasks) {
    const taskStatus = m.tasks.runningJobs >= m.tasks.maxConcurrent * 0.8 ? "warn" : "ok";
    cards.push(
      metricCard(
        "Tasks",
        `${m.tasks.runningJobs}/${m.tasks.maxConcurrent}`,
        "running / capacity",
        taskStatus,
      ),
    );
  }

  // Microcompact card
  if (m.microcompact && m.microcompact.totalRuns > 0) {
    const saved = formatCharsSaved(m.microcompact.totalCharsSaved);
    const ratio =
      m.microcompact.totalMessagesIn > 0
        ? (
            ((m.microcompact.totalMessagesIn - m.microcompact.totalMessagesOut) /
              m.microcompact.totalMessagesIn) *
            100
          ).toFixed(0)
        : "0";
    cards.push(
      metricCard(
        "Microcompact",
        `${saved} saved`,
        html`${m.microcompact.totalRuns} runs · ${ratio}% reduced`,
      ),
    );
  }

  // Circuit Breakers card
  const cbEntries = Object.entries(m.circuitBreakers ?? {});
  if (cbEntries.length > 0) {
    const openCount = cbEntries.filter(([, cb]) => cb.state === "open").length;
    const halfOpen = cbEntries.filter(([, cb]) => cb.state === "half_open").length;
    const cbStatus = openCount > 0 ? "error" : halfOpen > 0 ? "warn" : "ok";
    cards.push(
      metricCard(
        "Circuit Breakers",
        `${cbEntries.length} agents`,
        openCount > 0
          ? html`<span class="danger">${openCount} OPEN</span>`
          : halfOpen > 0
            ? html`<span class="warning">${halfOpen} half-open</span>`
            : "all healthy",
        cbStatus,
      ),
    );
  }

  // Alerts section
  const alertsHtml =
    m.alerts.length > 0
      ? html`
          <div class="ov-metrics__alerts">
            ${m.alerts.map((a) => html`<div class="ov-metrics__alert">${a}</div>`)}
          </div>
        `
      : nothing;

  return html`
    <section class="ov-metrics">
      <h3 class="ov-recent__title">System Metrics</h3>
      ${alertsHtml}
      <div class="ov-cards">${cards}</div>
    </section>
  `;
}
