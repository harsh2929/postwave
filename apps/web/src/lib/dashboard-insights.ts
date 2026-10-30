// SPDX-License-Identifier: AGPL-3.0-only
//
// Pure derivations for the dashboard home's period-aware tiles and the
// "Recommendations" card. Everything here is computed from the existing
// /api/v1/dashboard/stats payload (period-over-period `previous`, `inbox_health`,
// growth counts) — no new backend field is invented, so the surfaces stay
// honest and the logic stays unit-testable.

import type { DashboardStats } from "@/lib/analytics-api";

export type DeltaDirection = "up" | "down" | "flat";

export interface MetricDelta {
  direction: DeltaDirection;
  /** Percent change vs the previous window, or null when there is no baseline. */
  pct: number | null;
  /** Absolute change vs the previous window. */
  absolute: number;
  /** Display label, e.g. "+20%", "-3", or "0". */
  label: string;
}

/**
 * Period-over-period delta. When the previous window is 0 there is no
 * percentage baseline, so we fall back to the signed absolute change.
 */
export function computeDelta(
  current: number,
  previous: number | null | undefined,
): MetricDelta {
  const prev = previous ?? 0;
  const absolute = current - prev;
  const direction: DeltaDirection =
    absolute > 0 ? "up" : absolute < 0 ? "down" : "flat";
  const pct = prev > 0 ? Math.round((absolute / prev) * 100) : null;
  let label: string;
  if (pct != null) {
    label = `${pct > 0 ? "+" : ""}${pct}%`;
  } else if (absolute === 0) {
    label = "0";
  } else {
    label = `${absolute > 0 ? "+" : ""}${absolute.toLocaleString()}`;
  }
  return { direction, pct, absolute, label };
}

export type RecommendationTone = "warn" | "info";

export interface Recommendation {
  id: string;
  title: string;
  detail: string;
  href: string;
  cta: string;
  tone: RecommendationTone;
}

// Inbox-health states the backend may report that indicate a deliverability
// problem worth surfacing as a next-best-action.
const AT_RISK_HEALTH_STATES = new Set([
  "at_risk",
  "at-risk",
  "poor",
  "warning",
  "critical",
  "bad",
  "degraded",
]);

const INBOX_HEALTH_FLOOR = 70;
const CLICK_RATE_DROP_RATIO = 0.8;
const MIN_DELIVERED_FOR_RATE_COMPARISON = 100;
const MIN_CLICK_RATE_DROP = 0.005;

/**
 * Derive up to `max` next-best-actions from the dashboard stats. Order is by
 * urgency: deliverability, then measured click-rate decline, then audience
 * churn. Raw opens are deliberately excluded: privacy prefetches and changes
 * in send volume make their count a poor basis for a recommendation.
 */
export function deriveRecommendations(
  stats: DashboardStats | null | undefined,
  max = 3,
): Recommendation[] {
  if (!stats) return [];
  const recs: Recommendation[] = [];

  const health = stats.inbox_health;
  const unhealthy =
    !!health &&
    ((typeof health.score === "number" && health.score < INBOX_HEALTH_FLOOR) ||
      (!!health.state && AT_RISK_HEALTH_STATES.has(health.state.toLowerCase())));
  if (unhealthy) {
    recs.push({
      id: "deliverability",
      tone: "warn",
      title: "Deliverability needs attention",
      detail:
        typeof health?.score === "number"
          ? `Inbox health is ${health.score}. Shore up authentication and reputation to protect your reach.`
          : "Your inbox-health signal is degraded. Review authentication and sending reputation.",
      href: "/app/inbox-reality",
      cta: "Open Inbox Reality",
    });
  }

  const delivered = stats.unique_delivered_30d ?? 0;
  const priorDelivered = stats.previous?.unique_delivered ?? 0;
  const clicks = stats.unique_clicks_30d ?? 0;
  const priorClicks = stats.previous?.unique_clicks ?? 0;
  const comparableClickEvidence =
    [delivered, priorDelivered, clicks, priorClicks].every(
      (value) => Number.isFinite(value) && value >= 0,
    ) && clicks <= delivered && priorClicks <= priorDelivered;
  const currentClickRate = delivered > 0 ? clicks / delivered : 0;
  const priorClickRate = priorDelivered > 0 ? priorClicks / priorDelivered : 0;
  if (
    comparableClickEvidence &&
    delivered >= MIN_DELIVERED_FOR_RATE_COMPARISON &&
    priorDelivered >= MIN_DELIVERED_FOR_RATE_COMPARISON &&
    priorClickRate > 0 &&
    currentClickRate < priorClickRate * CLICK_RATE_DROP_RATIO &&
    priorClickRate - currentClickRate >= MIN_CLICK_RATE_DROP
  ) {
    recs.push({
      id: "engagement",
      tone: "warn",
      title: "Click rate is lower",
      detail: `Unique clicks per delivered email fell from ${(priorClickRate * 100).toFixed(1)}% (${priorClicks.toLocaleString()}/${priorDelivered.toLocaleString()}) to ${(currentClickRate * 100).toFixed(1)}% (${clicks.toLocaleString()}/${delivered.toLocaleString()}). Review the campaigns and audience mix before changing your strategy.`,
      href: "/app/analytics",
      cta: "Review analytics",
    });
  }

  const added = stats.subscribers_added_30d;
  const lost = stats.subscribers_unsubbed_30d;
  if (lost > 0 && lost >= added) {
    recs.push({
      id: "growth",
      tone: "warn",
      title: "Unsubscribes outpaced sign-ups",
      detail: `${lost.toLocaleString()} left vs ${added.toLocaleString()} joined in the last 30 days. Review list sources and segment health.`,
      href: "/app/subscribers",
      cta: "Review audience",
    });
  }

  if (recs.length === 0 && (stats.campaigns_sent_30d > 0 || added > 0)) {
    recs.push({
      id: "no-urgent-signal",
      tone: "info",
      title: "No urgent signal in the available data",
      detail:
        "This checks inbox health, comparable unique-click rates, and subscriber growth only. It cannot certify overall performance or inbox placement.",
      href: "/app/analytics",
      cta: "Inspect the evidence",
    });
  }

  return recs.slice(0, max);
}
