/**
 * placement-report-helpers — pure logic behind the
 * PlacementReportCard (#42, proxied GET
 * /api/v1/inbox-reality/campaigns/{id}).
 *
 * The service classifies each seed mailbox into one of the placements
 * defined in services/deliverability/internal/domain/types.go:
 * primary | promotions | updates | social | spam | blocked | missing.
 * `overall_pct` is a placement→fraction map; per-provider counts come
 * in `providers[].placements`.
 */

import type { CampaignPlacementReport } from "../../lib/api-client";

/** Canonical placement order — best outcome first. */
export const PLACEMENT_ORDER = [
  "primary",
  "promotions",
  "updates",
  "social",
  "spam",
  "blocked",
  "missing",
] as const;

export const PLACEMENT_LABELS: Readonly<Record<string, string>> = {
  primary: "Primary",
  promotions: "Promotions",
  updates: "Updates",
  social: "Social",
  spam: "Spam",
  blocked: "Blocked",
  missing: "Missing",
};

/** Stable colour per placement so the bars read at a glance. */
export const PLACEMENT_COLORS: Readonly<Record<string, string>> = {
  primary: "var(--pw-success)",
  promotions: "#0ea5e9",
  updates: "#14b8a6",
  social: "#a855f7",
  spam: "var(--pw-danger)",
  blocked: "#f97316",
  missing: "var(--pw-fg-muted)",
};

export function placementColor(code: string): string {
  return PLACEMENT_COLORS[code] ?? "var(--pw-fg-muted)";
}

export function placementLabel(code: string): string {
  return PLACEMENT_LABELS[code] ?? code;
}

export interface PlacementRow {
  code: string;
  label: string;
  /** 0..100, clamped. */
  pct: number;
}

/** Fraction (0..1) → clamped percent with one decimal. */
export function placementPct(fraction: number | null | undefined): number {
  if (fraction == null || Number.isNaN(fraction)) return 0;
  const pct = fraction * 100;
  return Math.max(0, Math.min(100, Math.round(pct * 10) / 10));
}

/**
 * Orders `overall_pct` into renderable rows: known placements in
 * canonical order first (only when present on the wire — we don't
 * fabricate zero rows), then any unrecognized keys alphabetically so
 * new server-side placements are never silently dropped.
 */
export function placementRows(
  overall: Record<string, number> | null | undefined,
): PlacementRow[] {
  if (!overall) return [];
  const rows: PlacementRow[] = [];
  const seen = new Set<string>();
  for (const code of PLACEMENT_ORDER) {
    if (code in overall) {
      rows.push({
        code,
        label: placementLabel(code),
        pct: placementPct(overall[code]),
      });
      seen.add(code);
    }
  }
  const extras = Object.keys(overall)
    .filter((k) => !seen.has(k))
    .sort();
  for (const code of extras) {
    rows.push({
      code,
      label: placementLabel(code),
      pct: placementPct(overall[code]),
    });
  }
  return rows;
}

/**
 * Per-provider placement counts, ordered like the overall rows.
 * Returns `{provider, total, cells: [{code, count}]}` where cells
 * cover the union of placements across all providers, so the table
 * columns line up.
 */
export interface ProviderPlacementRow {
  provider: string;
  total: number;
  cells: Array<{ code: string; count: number }>;
}

export function providerPlacementTable(
  report: Pick<CampaignPlacementReport, "providers">,
): { columns: string[]; rows: ProviderPlacementRow[] } {
  const providers = report.providers ?? [];
  const union = new Set<string>();
  for (const p of providers) {
    for (const code of Object.keys(p.placements ?? {})) union.add(code);
  }
  const columns: string[] = [];
  for (const code of PLACEMENT_ORDER) {
    if (union.has(code)) {
      columns.push(code);
      union.delete(code);
    }
  }
  columns.push(...[...union].sort());
  const rows = providers.map((p) => ({
    provider: p.provider,
    total: p.total,
    cells: columns.map((code) => ({
      code,
      count: p.placements?.[code] ?? 0,
    })),
  }));
  return { columns, rows };
}
