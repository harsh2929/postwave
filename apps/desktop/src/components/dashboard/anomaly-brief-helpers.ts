/**
 * anomaly-brief-helpers — pure logic for the "Explain this spike"
 * surface (AnomalyBriefModal + its launchers).
 *
 * The anomaly-brief endpoint (analyticsNlqApi.anomalyBrief) accepts a
 * strict metric whitelist — opens | clicks | bounces | complaints |
 * unsubscribes | revenue (422 invalid_metric otherwise). Dashboard
 * anomaly rows and stat-grid tiles use their own metric vocabulary, so
 * {@link asBriefMetric} maps between them and returns null for metrics
 * the endpoint can't explain (e.g. "subs") — callers hide the
 * affordance instead of offering a button that 422s.
 *
 * Tested in src/__tests__/components/anomaly-brief-helpers.test.ts.
 */

import {
  ANOMALY_BRIEF_METRICS,
  type AnomalyBriefMetric,
} from "../../lib/api-client";

/** Task default: briefs explain the last 7 days unless told otherwise. */
export const DEFAULT_BRIEF_WINDOW_DAYS = 7;

const ALIASES: Record<string, AnomalyBriefMetric> = {
  open: "opens",
  click: "clicks",
  bounce: "bounces",
  complaint: "complaints",
  unsub: "unsubscribes",
  unsubs: "unsubscribes",
  unsubscribe: "unsubscribes",
};

/**
 * Map a free-form metric name (anomaly row, stat tile) onto the brief
 * whitelist. Returns null when the metric can't be explained.
 */
export function asBriefMetric(
  metric: string | null | undefined,
): AnomalyBriefMetric | null {
  if (!metric) return null;
  const m = metric.trim().toLowerCase();
  if ((ANOMALY_BRIEF_METRICS as readonly string[]).includes(m)) {
    return m as AnomalyBriefMetric;
  }
  return ALIASES[m] ?? null;
}

export interface BriefErrorCopy {
  title: string;
  detail: string;
  /** Retrying is pointless for budget/config failures. */
  retryable: boolean;
}

/**
 * Disclosure-safe error copy for the brief request. Error payloads are
 * untrusted: backend messages can contain reflected URLs, provider details,
 * correlation tokens, or secrets, so only bounded categories are rendered.
 */
export function briefErrorCopy(err: {
  message?: string;
  status?: number;
  code?: string;
  kind?: string;
  retryAfterSeconds?: number;
}): BriefErrorCopy {
  if (err.code === "cost_cap_exceeded" || err.status === 429) {
    const retry =
      typeof err.retryAfterSeconds === "number" &&
      Number.isSafeInteger(err.retryAfterSeconds) &&
      err.retryAfterSeconds > 0 &&
      err.retryAfterSeconds <= 86_400
        ? ` Try again in ~${Math.ceil(err.retryAfterSeconds / 60)} min.`
        : " The budget resets at UTC midnight.";
    return {
      title: "Daily AI budget exhausted",
      detail: `This workspace has used its AI token budget for today.${retry}`,
      retryable: false,
    };
  }
  if (err.code === "nlq_unavailable" || err.status === 503) {
    return {
      title: "AI explanations aren't available",
      detail: "The explanation service is not configured for this environment.",
      retryable: false,
    };
  }
  if (err.kind === "timeout") {
    return {
      title: "The explanation timed out",
      detail:
        "The explanation service didn't answer within 60 seconds. This is usually transient — try again.",
      retryable: true,
    };
  }
  return {
    title: "Couldn't generate the explanation",
    detail:
      "The explanation service could not complete the request. Try again before acting on this anomaly.",
    retryable: true,
  };
}

/**
 * "+42% vs previous 7 days" comparison text for the aggregates block.
 * previous == 0 → no honest percentage exists; say so instead.
 */
export function formatBriefDelta(
  current: number,
  previous: number,
  windowDays: number,
): string {
  if (
    !Number.isSafeInteger(current) ||
    current < 0 ||
    !Number.isSafeInteger(previous) ||
    previous < 0 ||
    !Number.isSafeInteger(windowDays) ||
    windowDays <= 0
  ) {
    return "";
  }
  const win = `previous ${windowDays} days`;
  if (previous === 0) {
    return current === 0
      ? `no activity in either window`
      : `no activity in the ${win} to compare against`;
  }
  // Divide before multiplying so even adversarially large JSON numerics cannot
  // overflow the percentage calculation. The aggregate normalizer only admits
  // non-negative safe integers, but the helper remains defensive on its own.
  const pct = (current / previous - 1) * 100;
  if (!Number.isFinite(pct)) return "";
  if (pct > 9_999) return `more than 9,999% above ${win}`;
  const sign = pct >= 0 ? "+" : "";
  return `${sign}${pct.toFixed(0)}% vs ${win}`;
}

/**
 * True when the runtime can format an upper-case, recognized ISO 4217 code.
 * Electron's supportedValuesOf list is authoritative here; fail closed on
 * older runtimes instead of accepting an invented three-letter code that Intl
 * would otherwise render as if it were a real currency.
 */
export function isSupportedBriefCurrency(value: unknown): value is string {
  if (typeof value !== "string" || !/^[A-Z]{3}$/u.test(value)) return false;
  const intl = Intl as typeof Intl & {
    supportedValuesOf?: (key: "currency") => string[];
  };
  if (typeof intl.supportedValuesOf !== "function") return false;
  try {
    return intl.supportedValuesOf("currency").includes(value);
  } catch {
    return false;
  }
}

/**
 * Format deterministic anomaly evidence using the endpoint's wire semantics.
 * Revenue aggregates are integer minor units scoped to the explicitly returned
 * currency; every other whitelisted metric is an event count. Invalid wire
 * values are never coerced into a plausible zero or a default currency.
 */
export function formatBriefMetricValue(
  metric: AnomalyBriefMetric | string | null,
  value: number | null,
  currency: string | null = null,
): string {
  if (metric === "revenue") {
    // Historical anomaly means can contain a fractional cent even though the
    // endpoint's totals are int64 cents. Keep that bounded and round only at
    // currency presentation time.
    if (
      value === null ||
      !Number.isFinite(value) ||
      value < 0 ||
      value > Number.MAX_SAFE_INTEGER
    ) {
      return "unavailable";
    }
    if (currency === null) {
      return value === 0
        ? "0 minor units (no currency selected)"
        : "unavailable";
    }
    if (!isSupportedBriefCurrency(currency)) return "unavailable";
    try {
      return new Intl.NumberFormat(undefined, {
        style: "currency",
        currency,
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }).format(value / 100);
    } catch {
      return "unavailable";
    }
  }
  if (value === null || !Number.isSafeInteger(value) || value < 0) {
    return "unavailable";
  }
  return value.toLocaleString();
}

/**
 * Revenue anomaly history currently has no currency provenance. Preserve the
 * stored minor-unit magnitude without attaching a false symbol or converting
 * it to a major-unit amount. The Explain action can fetch fully scoped evidence
 * from the anomaly-brief endpoint.
 */
export function formatUnscopedRevenueMinorUnits(value: number | null): string {
  if (
    value === null ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > Number.MAX_SAFE_INTEGER
  ) {
    return "unavailable";
  }
  return `${value.toLocaleString(undefined, {
    minimumFractionDigits: Number.isInteger(value) ? 0 : 1,
    maximumFractionDigits: 2,
  })} minor units (currency unavailable)`;
}

/** Progress copy while the (≤60s) LLM request runs. Honest about the
 *  wait so the operator doesn't assume the modal hung. */
export function briefProgressCopy(elapsedSeconds: number): string {
  if (elapsedSeconds < 10) return "Asking Claude to analyse the spike…";
  if (elapsedSeconds < 30)
    return "Still working — comparing the window against the previous period…";
  return "Almost there — long analyses can take up to 60 seconds.";
}
