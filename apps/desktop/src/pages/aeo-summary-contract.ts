import type {
  AEOCompetitor,
  AEODailyRollup,
  AEOProbe,
  AEOPrompt,
  AEOSensorSummary,
} from "../lib/api-client";

const AEO_ENGINES = new Set([
  "chatgpt",
  "gemini",
  "perplexity",
  "grok",
  "copilot",
  "_all",
]);
const PROMPT_CATEGORIES = new Set([
  "discovery",
  "comparison",
  "buyer",
  "support",
  "other",
]);
const PROBE_STATUSES = new Set(["ok", "error", "rate_limited", "skipped"]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

function isRollup(value: unknown): value is AEODailyRollup {
  if (!isRecord(value)) return false;
  const row = value;
  return (
    typeof row.engine === "string" &&
    AEO_ENGINES.has(row.engine) &&
    typeof row.day === "string" &&
    finite(row.mention_rate) &&
    finite(row.citation_rate) &&
    finite(row.volatility_score) &&
    finite(row.ai_referral_pct) &&
    finite(row.sample_size) &&
    typeof row.computed_at === "string"
  );
}

function isCompetitorScore(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    typeof value.key === "string" &&
    typeof value.display_name === "string" &&
    finite(value.mention_rate) &&
    (value.domain === undefined || typeof value.domain === "string")
  );
}

function isPrompt(value: unknown): value is AEOPrompt {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    typeof value.category === "string" &&
    PROMPT_CATEGORIES.has(value.category) &&
    typeof value.prompt_text === "string" &&
    typeof value.enabled === "boolean" &&
    (value.source === "starter" || value.source === "custom") &&
    typeof value.created_at === "string" &&
    typeof value.updated_at === "string"
  );
}

function isProbe(value: unknown): value is AEOProbe {
  if (!isRecord(value) || !isRecord(value.competitor_hits)) return false;
  return (
    finite(value.id) &&
    typeof value.prompt_id === "string" &&
    typeof value.engine === "string" &&
    AEO_ENGINES.has(value.engine) &&
    typeof value.response_text === "string" &&
    typeof value.mentioned === "boolean" &&
    typeof value.cited === "boolean" &&
    Object.values(value.competitor_hits).every(finite) &&
    finite(value.latency_ms) &&
    finite(value.token_count) &&
    typeof value.status === "string" &&
    PROBE_STATUSES.has(value.status) &&
    typeof value.probed_at === "string"
  );
}

function isCompetitor(value: unknown): value is AEOCompetitor {
  if (!isRecord(value)) return false;
  return (
    typeof value.competitor_key === "string" &&
    typeof value.display_name === "string" &&
    Array.isArray(value.terms) &&
    value.terms.every((term) => typeof term === "string") &&
    typeof value.domain === "string" &&
    (value.id === undefined || typeof value.id === "string") &&
    (value.created_at === undefined || typeof value.created_at === "string") &&
    (value.updated_at === undefined || typeof value.updated_at === "string")
  );
}

function parseItems<T>(
  value: unknown,
  predicate: (item: unknown) => item is T,
): T[] | null {
  if (!isRecord(value) || !Array.isArray(value.items)) return null;
  return value.items.every(predicate) ? value.items : null;
}

export function parseAeoPrompts(value: unknown): AEOPrompt[] | null {
  return parseItems(value, isPrompt);
}

export function parseAeoProbes(value: unknown): AEOProbe[] | null {
  return parseItems(value, isProbe);
}

export function parseAeoCompetitors(value: unknown): AEOCompetitor[] | null {
  return parseItems(value, isCompetitor);
}

export function parseAeoSummary(value: unknown): AEOSensorSummary | null {
  if (!isRecord(value)) return null;
  const summary = value;
  const settings = summary.settings;
  if (!settings || typeof settings !== "object") return null;
  const config = settings as Record<string, unknown>;
  if (
    typeof config.enabled !== "boolean" ||
    typeof config.brand_domain !== "string" ||
    !Array.isArray(config.brand_terms) ||
    !config.brand_terms.every((term) => typeof term === "string") ||
    !["missing", "partial", "ready"].includes(
      String(config.credentials_status),
    ) ||
    !Array.isArray(summary.latest_rollups) ||
    !summary.latest_rollups.every(isRollup) ||
    !Array.isArray(summary.competitor_board) ||
    !summary.competitor_board.every(isCompetitorScore) ||
    !finite(summary.overall_mention_rate) ||
    !finite(summary.overall_citation_rate) ||
    !finite(summary.volatility_score) ||
    !finite(summary.ai_referral_pct) ||
    (summary.warning_banner !== undefined &&
      typeof summary.warning_banner !== "string")
  ) {
    return null;
  }
  return summary as unknown as AEOSensorSummary;
}
