/**
 * lib/campaignHealth.ts — reading the two per-campaign warning endpoints.
 *
 *   GET /api/v1/campaigns/{id}/health     deliverability_hub/hub.go:188
 *   GET /api/v1/campaigns/{id}/anomalies  analytics/campaign_anomalies.go:32
 *
 * Both are purpose-built, both are computed server-side on every send, and
 * before this NEITHER had a consumer anywhere in the campaigns cluster on ANY
 * client — the desktop lists "anomalies" as a slideover section type and the
 * only anomaly UI in the repo is the dashboard's tenant-wide history card.
 *
 * "This send is bouncing eight times your baseline" is the single most
 * glanceable, most phone-shaped thing the product computes, and it was being
 * thrown away.
 *
 * Import-free apart from lib/format so the interpretation is testable in the
 * node environment. The COPY is the hard part here: an anomaly is a z-score,
 * and a z-score means nothing to an operator. Every reading below converts one
 * into a sentence that names the metric, the direction and the hour.
 */
import { num, plural } from "@/lib/format";

export interface CampaignHealthResponse {
  campaign_id?: string;
  /** "healthy" | "needs_attention" */
  status?: string;
  reasons?: string[];
  score?: number;
  grade?: string;
  sample_qualified?: boolean;
  sample_size?: number;
  minimum_sample_size?: number;
  model_version?: string;
}

export interface CampaignAnomaly {
  hour?: string;
  /** opens | clicks | unsubs */
  metric?: string;
  value?: number;
  mean?: number;
  z_score?: number;
  /** spike | drop */
  direction?: string;
}

export interface CampaignAnomaliesResponse {
  campaign_id?: string;
  anomalies?: CampaignAnomaly[];
  timezone?: string;
  truncated?: boolean;
}

export type HealthTone = "good" | "warning" | "danger" | "unknown";

export interface CampaignHealthReading {
  tone: HealthTone;
  /** Short pill text. Always carries a word, never colour alone. */
  badge: string;
  headline: string;
  /** The server's own reasons, verbatim — it knows why, we don't restate. */
  reasons: string[];
  /** "82 / 100 · B" when both are present. */
  scoreLine: string | null;
}

function readScore(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * A grade below this reads as an active problem rather than a caution. The
 * gateway grades A–F; D and below is where an operator should stop and look.
 */
const POOR_GRADES = new Set(["D", "E", "F"]);

export function readCampaignHealth(
  response: CampaignHealthResponse | null | undefined,
): CampaignHealthReading {
  const status = (response?.status ?? "").trim().toLowerCase();
  const reasons = (Array.isArray(response?.reasons) ? response?.reasons : []).filter(
    (r): r is string => typeof r === "string" && r.trim().length > 0,
  );
  const score = readScore(response?.score);
  const grade = (response?.grade ?? "").trim().toUpperCase();
  const scoreLine =
    score !== null && response?.sample_qualified !== false
      ? `${num(score)} / 100${grade ? ` · ${grade}` : ""}`
      : null;

  if (!response || !status) {
    return {
      tone: "unknown",
      badge: "Not measured",
      headline: "Deliverability health hasn't been computed for this send yet.",
      reasons: [],
      scoreLine,
    };
  }
  if (status === "insufficient_data" || response.sample_qualified === false) {
    const sampleSize = readScore(response.sample_size);
    const minimum = readScore(response.minimum_sample_size);
    return {
      tone: "unknown",
      badge: "Sample building",
      headline:
        sampleSize !== null && minimum !== null
          ? `${num(sampleSize)} of ${num(minimum)} successful campaign sends are available for rate scoring.`
          : "This send does not have enough delivery evidence for a health verdict yet.",
      reasons,
      scoreLine: null,
    };
  }
  if (status === "healthy") {
    return {
      tone: "good",
      badge: "✓ Healthy",
      headline: "No deliverability problems detected on this send.",
      reasons,
      scoreLine,
    };
  }
  // needs_attention, or any future status the gateway invents: treat an
  // unrecognised non-healthy status as a warning rather than swallowing it.
  const severe = POOR_GRADES.has(grade);
  return {
    tone: severe ? "danger" : "warning",
    badge: severe ? "⚠ Poor" : "⚠ Needs attention",
    headline:
      reasons.length > 0
        ? "This send has deliverability problems:"
        : "This send needs attention, but the gateway didn't say why.",
    reasons,
    scoreLine,
  };
}

const METRIC_NOUNS: Record<string, string> = {
  opens: "Opens",
  clicks: "Clicks",
  unsubs: "Unsubscribes",
};

export interface CampaignAnomalyRow {
  id: string;
  /** The whole finding as one sentence. */
  message: string;
  /** Unsubscribe spikes are bad news; open drops are bad news; not the same. */
  tone: HealthTone;
  /** The multiple of baseline, e.g. "8.2x", or null when unknowable. */
  multiple: string | null;
}

/**
 * One row per flagged hour, most extreme first.
 *
 * The direction/metric combination decides the TONE, and it is not uniform: a
 * spike in unsubscribes is bad, a spike in clicks is good news that is still
 * worth flagging, and a drop in opens is worth looking at. Painting all six
 * combinations the same colour would be the same mistake as painting none.
 */
export function campaignAnomalyRows(
  response: CampaignAnomaliesResponse | null | undefined,
  maxRows = 6,
): CampaignAnomalyRow[] {
  const rows: (CampaignAnomalyRow & { severity: number })[] = [];
  // Array.isArray, not `?? []`: `.entries()` on a truthy non-array throws.
  const anomalies = Array.isArray(response?.anomalies)
    ? response.anomalies
    : [];
  for (const [index, anomaly] of anomalies.entries()) {
    const metric = (anomaly?.metric ?? "").trim().toLowerCase();
    const noun = METRIC_NOUNS[metric];
    const direction = (anomaly?.direction ?? "").trim().toLowerCase();
    if (!noun || (direction !== "spike" && direction !== "drop")) continue;

    const value = readScore(anomaly.value);
    const mean = readScore(anomaly.mean);
    const z = readScore(anomaly.z_score);
    const multiple =
      value !== null && mean !== null && mean > 0
        ? `${(value / mean).toFixed(1)}x`
        : null;

    const bad =
      (metric === "unsubs" && direction === "spike") ||
      (metric !== "unsubs" && direction === "drop");
    const hour = typeof anomaly.hour === "string" ? anomaly.hour : "";
    const verb = direction === "spike" ? "spiked to" : "fell to";
    const baseline =
      mean !== null ? ` against a baseline of ${num(Math.round(mean))}` : "";
    const at = hour ? ` at ${hour}` : "";

    rows.push({
      id: `${metric}-${direction}-${hour || index}`,
      tone: bad ? "danger" : "warning",
      multiple,
      message: `${noun} ${verb} ${num(value ?? 0)} in one hour${baseline}${at}.`,
      severity: Math.abs(z ?? 0),
    });
  }
  rows.sort((a, b) => b.severity - a.severity);
  return rows
    .slice(0, Math.max(0, maxRows))
    .map(({ severity: _s, ...row }) => row);
}

/** The caption above the anomaly list. */
export function campaignAnomalySummary(
  rows: readonly CampaignAnomalyRow[],
  truncated: boolean,
): string {
  // The truncation caveat matters MOST on the empty result: "nothing looked
  // unusual" from a partial scan is a different claim from the same sentence
  // after a complete one, and only one of them is reassuring.
  const cut = truncated ? " Only part of the send window was analysed." : "";
  if (rows.length === 0) {
    return `No hour of this send behaved unusually against its own baseline.${cut}`;
  }
  const alarming = rows.filter((r) => r.tone === "danger").length;
  const lead = `${plural(rows.length, "unusual hour")} detected`;
  const detail = alarming > 0 ? `, ${alarming} worth acting on` : "";
  return `${lead}${detail}.${cut}`;
}
