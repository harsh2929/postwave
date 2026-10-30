/**
 * listGrowthSources — "where did the people on this list come from?"
 *
 * GET /api/v1/lists/{id}/growth-sources
 *   RequireScope(ScopeReadSubscribers) — a READ-ONLY scope, so any
 *   authenticated role may see it.
 *
 * Response: `{ list_id, sources: { form, api, csv, integration, admin,
 * migration, listmonk_event, other }, total?, fallback? }`.
 *
 * TWO THINGS THE UI MUST NOT SMOOTH OVER:
 *
 *  1. `fallback: "live_count"` means the sidecar counter row was missing and
 *     the server computed the mix from a live `count(*)` instead. That is a
 *     DIFFERENT measurement — it reflects current membership, not cumulative
 *     acquisition — and presenting it identically would make a re-imported
 *     list look like it was acquired by whatever source last touched it.
 *  2. An all-zero map is not "no growth". `list_metadata.growth_sources` is
 *     populated best-effort AFTER the membership write, so a list built
 *     before that counter existed reports zeros for real members. The empty
 *     case says "not recorded", never "0 from forms".
 *
 * The bucket vocabulary mirrors `canonicalGrowthSources`
 * (apps/api/internal/lists/growth.go:42) exactly; anything else the server
 * folds into `other`, so inventing a bucket here would render a slice that
 * can never be non-zero.
 *
 * Import-free so all of it is unit-tested.
 */

export const GROWTH_SOURCE_KEYS = [
  "form",
  "api",
  "csv",
  "integration",
  "admin",
  "migration",
  "listmonk_event",
  "other",
] as const;
export type GrowthSourceKey = (typeof GROWTH_SOURCE_KEYS)[number];

const LABELS: Record<GrowthSourceKey, string> = {
  form: "Signup form",
  api: "API",
  csv: "CSV import",
  integration: "Integration",
  admin: "Added by hand",
  migration: "Migration",
  listmonk_event: "Engine event",
  other: "Other",
};

export function growthSourceLabel(key: string): string {
  return (LABELS as Record<string, string>)[key] ?? key;
}

export interface GrowthSourceSlice {
  key: string;
  label: string;
  count: number;
  /** 0..1 of the recorded total. */
  share: number;
}

export interface GrowthSourceMix {
  slices: GrowthSourceSlice[];
  /** Sum of the recorded counters. null when nothing was recorded at all. */
  total: number | null;
  /** True when the server fell back to a live count — a DIFFERENT question. */
  isLiveCount: boolean;
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.round(value)
    : 0;
}

export function parseGrowthSources(raw: unknown): GrowthSourceMix {
  const envelope = raw as
    | { sources?: unknown; fallback?: unknown }
    | undefined;
  const sources =
    envelope?.sources && typeof envelope.sources === "object"
      ? (envelope.sources as Record<string, unknown>)
      : {};

  const counts: { key: string; label: string; count: number }[] = [];
  let sum = 0;
  for (const key of GROWTH_SOURCE_KEYS) {
    const n = count(sources[key]);
    sum += n;
    if (n > 0) counts.push({ key, label: growthSourceLabel(key), count: n });
  }
  // A key the server invented outside the enum would otherwise vanish; fold
  // it in rather than silently dropping members from the denominator.
  for (const [key, value] of Object.entries(sources)) {
    if ((GROWTH_SOURCE_KEYS as readonly string[]).includes(key)) continue;
    const n = count(value);
    if (n === 0) continue;
    sum += n;
    counts.push({ key, label: growthSourceLabel(key), count: n });
  }

  counts.sort((a, b) => b.count - a.count);
  return {
    slices: counts.map((c) => ({ ...c, share: sum > 0 ? c.count / sum : 0 })),
    // null, not 0: nothing recorded is a missing measurement.
    total: sum > 0 ? sum : null,
    isLiveCount: envelope?.fallback === "live_count",
  };
}

/** The caveat line, or "" when there is nothing to disclose. */
export function growthSourceNote(mix: GrowthSourceMix): string {
  if (mix.total === null) {
    return "No acquisition sources have been recorded for this list. Members added before source tracking existed aren't counted here.";
  }
  if (mix.isLiveCount) {
    return "Counted live from current membership rather than from the acquisition log, so it reflects who is on the list now — not how everyone originally arrived.";
  }
  return "";
}
