/**
 * lifecycleDistribution — the tenant-wide lifecycle-stage rollup.
 *
 * The pure half of the analytics Lifecycle section: parsing for
 * `GET /api/v1/lifecycle/distribution` (`{items:[{stage,count}]}`) and
 * `GET /api/v1/lifecycle/stages` (`{stages:[…]}`), plus the merge that
 * desktop's `subscriber-insights.buildLifecycleView` performs — the
 * histogram is joined with the stage CATALOG so empty stages still render
 * (in catalog order), and any distribution stage the catalog does not know
 * is appended rather than dropped: the card must account for every
 * subscriber the server counted.
 *
 * READ-ONLY BY DESIGN, same honest-UI decision as desktop's
 * LifecycleDistributionCard: no list endpoint takes a lifecycle filter, so
 * tapping a stage could not apply a real one. The card says where stages
 * are edited instead (the per-subscriber detail panel).
 *
 * Free of react-native imports so node-run vitest covers every branch.
 */

/** One histogram row, as `lifecycle.DistributionRow` (Go) serialises it. */
export interface LifecycleDistributionRow {
  stage: string;
  count: number;
}

export interface LifecycleStageView {
  stage: string;
  label: string;
  count: number;
  /** Share of the total, 0–100. Zero when the tenant has no subscribers. */
  pct: number;
}

export interface LifecycleDistributionView {
  rows: LifecycleStageView[];
  total: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Parse the distribution body. Rows with a malformed stage or count are
 * dropped rather than rendered as NaN bars; a body with no `items` array
 * (an error page, an older gateway) degrades to an empty histogram.
 */
export function parseLifecycleDistribution(
  raw: unknown,
): LifecycleDistributionRow[] {
  if (!isRecord(raw) || !Array.isArray(raw.items)) return [];
  const out: LifecycleDistributionRow[] = [];
  for (const entry of raw.items) {
    if (!isRecord(entry)) continue;
    const stage = typeof entry.stage === "string" ? entry.stage : "";
    const count =
      typeof entry.count === "number" &&
      Number.isFinite(entry.count) &&
      entry.count >= 0
        ? Math.trunc(entry.count)
        : null;
    if (count === null) continue;
    out.push({ stage, count });
  }
  return out;
}

/** Parse the stage catalog. The catalog is decoration (ordering +
 * zero-fill), so anything malformed degrades to `[]` — distribution-only
 * ordering — rather than failing the card. */
export function parseLifecycleStages(raw: unknown): string[] {
  if (!isRecord(raw) || !Array.isArray(raw.stages)) return [];
  return raw.stages.filter(
    (stage): stage is string => typeof stage === "string" && stage !== "",
  );
}

/**
 * Human label for a stage id. Mirrors desktop's `stageLabel`: a null/empty
 * stage renders "—" rather than crashing on `.length`; `mql`/`sql` read
 * better fully uppercased; everything else is snake_case → Title Case.
 */
export function lifecycleStageLabel(stage: string): string {
  const s = stage ?? "";
  if (s === "") return "—";
  if (s.length <= 3 && s !== "lead") return s.toUpperCase();
  return s
    .split("_")
    .map((p) => (p ? p[0]!.toUpperCase() + p.slice(1) : p))
    .join(" ");
}

/**
 * Merge histogram + catalog. Port of desktop's `buildLifecycleView`
 * (apps/desktop/src/components/subscribers/subscriber-insights.ts:180),
 * with the label resolved here so the component renders verbatim.
 */
export function buildLifecycleView(
  items: LifecycleDistributionRow[],
  stages: string[],
): LifecycleDistributionView {
  const counts = new Map<string, number>();
  for (const row of items) {
    counts.set(row.stage, (counts.get(row.stage) ?? 0) + row.count);
  }
  const ordered: string[] = [...stages];
  for (const row of items) {
    if (!ordered.includes(row.stage)) ordered.push(row.stage);
  }
  const total = items.reduce((sum, r) => sum + r.count, 0);
  const rows = ordered.map((stage) => {
    const count = counts.get(stage) ?? 0;
    return {
      stage,
      label: lifecycleStageLabel(stage),
      count,
      pct: total > 0 ? (count / total) * 100 : 0,
    };
  });
  return { rows, total };
}

/** The card's closing honesty note — where the write actually lives. */
export const LIFECYCLE_EDIT_NOTE =
  "A read-only rollup over every active subscriber. Stages are edited on each subscriber's profile, not here.";

/** What the card says for a workspace with nobody in any stage. */
export const LIFECYCLE_EMPTY_COPY =
  "No active subscribers to place in lifecycle stages yet.";

/** What a screen reader hears for one stage bar. */
export function lifecycleRowSpokenLabel(row: LifecycleStageView): string {
  const pct = row.pct > 0 ? `, ${Math.round(row.pct)} percent` : "";
  return `${row.label}: ${row.count} subscriber${row.count === 1 ? "" : "s"}${pct}`;
}
