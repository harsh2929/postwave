/**
 * audienceTelemetryProps — the property builders for the audience events.
 *
 * Split from the emitter (src/lib/audienceTelemetry.ts) because that module
 * imports `track`, which transitively pulls expo-secure-store and therefore
 * cannot run in the node test environment. Everything with a RULE in it
 * lives here so the rules are tested.
 *
 * The rule that matters: the audience cluster is the one place in the
 * product where every value is customer PII — an address, a person's name,
 * a tag someone typed. So the only things that ever leave the device are
 * a query's LENGTH, a count, a contract-defined filter KEY, and an enum.
 * Never the query text, never a tag name, never a subscriber id.
 *
 * Every key emitted here is already in `SAFE_PROPERTY_KEYS`
 * (src/lib/telemetry.ts). That is deliberate: the sanitizer is an
 * allowlist, and adding a new key would be a decision to widen it.
 */

/** Bound so a pathological paste can't turn a length into a fingerprint. */
const MAX_QUERY_LENGTH = 512;

export type SearchTelemetryProps = {
  query_length: number;
  result_count: number;
};

export function audienceSearchProps(
  query: string,
  resultCount: number | undefined,
): SearchTelemetryProps {
  const length = Math.min(query.trim().length, MAX_QUERY_LENGTH);
  return {
    query_length: length,
    // A search whose count has not arrived is reported as -1 rather than 0:
    // "no results yet" and "zero results" are different facts, and rolling
    // them together would overstate the empty-search rate.
    result_count:
      typeof resultCount === "number" && Number.isFinite(resultCount)
        ? Math.max(0, Math.trunc(resultCount))
        : -1,
  };
}

export type AudienceFilterSource = "chip" | "segment" | "deep_link";

export type FilterTelemetryProps = {
  key: string;
  source: AudienceFilterSource;
};

/**
 * `key` is a CONTRACT filter key ("all", "subscribed", …). Anything not on
 * the contract list is reported as "other" rather than passed through — a
 * future free-text filter must not become an exfiltration path.
 */
const KNOWN_FILTER_KEYS = new Set([
  "all",
  "subscribed",
  "unsubscribed",
  "disabled",
  "unconfirmed",
]);

export function audienceFilterProps(
  filterKey: string,
  source: AudienceFilterSource,
): FilterTelemetryProps {
  const key = filterKey.trim().toLowerCase();
  return { key: KNOWN_FILTER_KEYS.has(key) ? key : "other", source };
}

export type TagOutcome = "added" | "removed";
export type TagSource = "sheet" | "profile" | "suggestion";

export type TagTelemetryProps = {
  outcome: TagOutcome;
  source: TagSource;
};

export function audienceTagProps(
  outcome: TagOutcome,
  source: TagSource,
): TagTelemetryProps {
  return { outcome, source };
}

export type StatusTelemetryProps = {
  kind: string;
};

/**
 * The engine status written, which is a fixed four-value vocabulary. An
 * unrecognised value is reported as "other" so a future status can't leak
 * an unreviewed string.
 */
const KNOWN_ENGINE_STATUSES = new Set([
  "enabled",
  "disabled",
  "blocklisted",
  "unconfirmed",
]);

export function audienceStatusProps(status: string): StatusTelemetryProps {
  const kind = status.trim().toLowerCase();
  return { kind: KNOWN_ENGINE_STATUSES.has(kind) ? kind : "other" };
}

export type SuppressSource = "row" | "profile";
export type SuppressOutcome = "suppressed" | "undone" | "removed";

export type SuppressTelemetryProps = {
  source: SuppressSource;
  outcome: SuppressOutcome;
};

export function audienceSuppressProps(
  source: SuppressSource,
  outcome: SuppressOutcome,
): SuppressTelemetryProps {
  return { source, outcome };
}
