/**
 * subscriberEngagement — the workspace engagement-score explorer + the
 * scoring rules that produce the numbers (SUB engagement surface, R2/R9).
 *
 * Desktop's EngagementScoreSection + ScoringRulesCard translated:
 *  - decile distribution (GET /engagement-scores/distribution {buckets});
 *  - score-banded browse (GET /engagement-scores/subscribers?min=&max=);
 *  - the rule set (GET /scoring/rules {rules, defaults, event_catalog,
 *    version, window_days}) — a tenant with no rows runs the DEFAULTS, so
 *    "effective rules" falls back to them, labeled as defaults;
 *  - PUT /scoring/rules replaces the WHOLE set and must echo the version
 *    the operator loaded (`expected_version`) — a 409 means someone else
 *    saved first, surfaced as a refresh prompt, never retried blind.
 *
 * RECOMPUTE IS DELIBERATELY NOT HERE: POST /scoring/recompute answers a
 * server-side 409 hold ("scoring_recompute_unavailable") until it exists as
 * a durable job with a receipt. Scores refresh automatically; the sheet
 * says so instead of offering a verb that always fails.
 *
 * Import-free so every rule runs in the node vitest suite.
 */

export interface ScoreBucketRow {
  range: string;
  min: number;
  max: number;
  count: number;
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** The {buckets} distribution body, defensively. */
export function parseScoreDistribution(payload: unknown): ScoreBucketRow[] {
  const rec =
    payload && typeof payload === "object"
      ? (payload as Record<string, unknown>)
      : {};
  if (!Array.isArray(rec.buckets)) return [];
  return rec.buckets.flatMap((row): ScoreBucketRow[] => {
    if (!row || typeof row !== "object") return [];
    const r = row as Record<string, unknown>;
    return [
      {
        range: str(r.range) || `${num(r.min)}..${num(r.max)}`,
        min: num(r.min),
        max: num(r.max),
        count: num(r.count),
      },
    ];
  });
}

/**
 * Low → high tone class per slice position — desktop's sliceTone thirds,
 * expressed as a token name the card maps onto theme colors.
 */
export function bucketTone(
  index: number,
  total: number,
): "low" | "mid" | "high" {
  if (total <= 0) return "mid";
  const fraction = index / total;
  if (fraction < 1 / 3) return "low";
  if (fraction < 2 / 3) return "mid";
  return "high";
}

export interface ScoredSubscriberRow {
  id: string;
  email: string;
  score: number;
}

export interface ScoredPage {
  items: ScoredSubscriberRow[];
  page: number;
  total: number;
}

/** The score-banded {items, page, total} body, defensively. */
export function parseScoredPage(payload: unknown): ScoredPage {
  const rec =
    payload && typeof payload === "object"
      ? (payload as Record<string, unknown>)
      : {};
  const items: ScoredSubscriberRow[] = Array.isArray(rec.items)
    ? rec.items.flatMap((row): ScoredSubscriberRow[] => {
        if (!row || typeof row !== "object") return [];
        const r = row as Record<string, unknown>;
        const id = str(r.id);
        const email = str(r.email);
        if (!id || !email) return [];
        return [{ id, email, score: num(r.score) }];
      })
    : [];
  return { items, page: Math.max(1, num(rec.page)), total: num(rec.total) };
}

export interface ScoringRuleRow {
  eventType: string;
  /** The catalog's human label, or the raw event type. */
  label: string;
  weight: number;
  note: string;
}

export interface ScoringRulesView {
  /** The EFFECTIVE set: tenant rules, or the defaults when none exist. */
  rules: ScoringRuleRow[];
  usingDefaults: boolean;
  /** Echoed as expected_version on PUT. */
  version: string;
  windowDays: number;
}

/** The GET /scoring/rules body, resolving effective rules + catalog labels. */
export function parseScoringRules(payload: unknown): ScoringRulesView {
  const rec =
    payload && typeof payload === "object"
      ? (payload as Record<string, unknown>)
      : {};
  const labels = new Map<string, string>();
  if (Array.isArray(rec.event_catalog)) {
    for (const entry of rec.event_catalog) {
      if (!entry || typeof entry !== "object") continue;
      const e = entry as Record<string, unknown>;
      const type = str(e.event_type);
      if (type) labels.set(type, str(e.label) || type);
    }
  }
  const toRows = (value: unknown): ScoringRuleRow[] =>
    Array.isArray(value)
      ? value.flatMap((row): ScoringRuleRow[] => {
          if (!row || typeof row !== "object") return [];
          const r = row as Record<string, unknown>;
          const eventType = str(r.event_type);
          if (!eventType) return [];
          return [
            {
              eventType,
              label: labels.get(eventType) ?? eventType,
              weight: num(r.weight),
              note: str(r.note),
            },
          ];
        })
      : [];
  const tenantRules = toRows(rec.rules);
  const defaults = toRows(rec.defaults);
  const usingDefaults = tenantRules.length === 0;
  return {
    rules: usingDefaults ? defaults : tenantRules,
    usingDefaults,
    version: str(rec.version),
    windowDays: num(rec.window_days),
  };
}

/** Why the edited set cannot be saved, or null. Weights are bounded ints. */
export function scoringRulesProblem(
  rules: readonly { eventType: string; weight: number }[],
): string | null {
  if (rules.length === 0) return "Keep at least one rule in the set.";
  for (const rule of rules) {
    if (!Number.isInteger(rule.weight)) {
      return `The weight for ${rule.eventType} must be a whole number.`;
    }
    if (Math.abs(rule.weight) > 1000) {
      return `The weight for ${rule.eventType} is out of range.`;
    }
  }
  return null;
}

/** PUT body — the WHOLE set plus the loaded version (PutInput). */
export function buildScoringRulesPut(
  rules: readonly ScoringRuleRow[],
  expectedVersion: string,
): Record<string, unknown> {
  return {
    rules: rules.map((rule) => ({
      event_type: rule.eventType,
      weight: rule.weight,
      ...(rule.note ? { note: rule.note } : {}),
    })),
    expected_version: expectedVersion,
  };
}

/** The stated reason there is no manual recompute verb. */
export const SCORE_RECOMPUTE_NOTE =
  "Scores refresh automatically about every 15 minutes. Manual recompute is held server-side until it exists as a durable, cancellable job.";
