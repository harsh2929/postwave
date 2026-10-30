/**
 * lib/campaignSort.ts — ordering the campaign list.
 *
 * The mobile list rendered in server order with no affordance at all, so
 * "which campaign performed best?" was unanswerable on a phone: you scrolled
 * two hundred rows comparing percentages by eye. Desktop has had sortable
 * name / status / sent / open / click columns since the list existed.
 *
 * CLIENT-SIDE, AND HONEST ABOUT IT. The gateway's list endpoint has no sort
 * parameter, so this orders the pages already loaded — which is why the screen
 * says so beside the control when more pages remain. Sorting a partial set and
 * presenting it as "the best campaign" would be worse than not sorting at all.
 *
 * Import-free so the comparators are testable in the node environment.
 */

export type CampaignSort = "recent" | "open_rate" | "click_rate" | "name";

export const CAMPAIGN_SORTS: readonly {
  value: CampaignSort;
  label: string;
  /** Spoken form; the chip label is abbreviated. */
  accessibilityLabel: string;
}[] = [
  {
    value: "recent",
    label: "Recent",
    accessibilityLabel: "Sort by most recent",
  },
  {
    value: "open_rate",
    label: "Open rate",
    accessibilityLabel: "Sort by highest open rate",
  },
  {
    value: "click_rate",
    label: "Click rate",
    accessibilityLabel: "Sort by highest click rate",
  },
  { value: "name", label: "Name", accessibilityLabel: "Sort by name, A to Z" },
];

export const DEFAULT_CAMPAIGN_SORT: CampaignSort = "recent";

export function isCampaignSort(value: unknown): value is CampaignSort {
  return CAMPAIGN_SORTS.some((s) => s.value === value);
}

export interface CampaignSortRow {
  id: string;
  name?: string | undefined;
  subject?: string | undefined;
  status?: string | undefined;
  scheduled_at?: string | null | undefined;
  sent_at?: string | null | undefined;
  created_at?: string | undefined;
  open_rate?: number | undefined;
  click_rate?: number | undefined;
}

function time(value: string | null | undefined): number {
  if (!value) return Number.NEGATIVE_INFINITY;
  const at = Date.parse(value);
  return Number.isFinite(at) ? at : Number.NEGATIVE_INFINITY;
}

/**
 * The moment a row is "about". Mirrors campaignRowDate's precedence so the
 * order matches the date each row actually displays — sorting by created_at
 * while the row shows "Sends in 3 days" is the kind of small dishonesty that
 * makes a list feel wrong without anyone being able to say why.
 */
export function campaignSortTime(row: CampaignSortRow): number {
  const status = (row.status ?? "").trim().toLowerCase();
  if (status === "scheduled" && row.scheduled_at) return time(row.scheduled_at);
  if (row.sent_at) return time(row.sent_at);
  return time(row.created_at);
}

function rate(value: number | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function label(row: CampaignSortRow): string {
  return (row.name ?? row.subject ?? "").trim().toLowerCase();
}

/**
 * Sort a loaded page window. Always returns a NEW array; the input is never
 * mutated, because it is TanStack's cached page data.
 *
 * Rows with no measurement for the chosen rate sink to the bottom rather than
 * being treated as 0%: a draft has no open rate, and ranking it level with a
 * campaign that genuinely achieved 0% is a different claim.
 */
export function sortCampaignRows<T extends CampaignSortRow>(
  rows: readonly T[],
  sort: CampaignSort,
): T[] {
  const out = [...rows];
  if (sort === "name") {
    out.sort((a, b) => label(a).localeCompare(label(b)) || tieBreak(a, b));
    return out;
  }
  if (sort === "open_rate" || sort === "click_rate") {
    const read = (row: T) =>
      sort === "open_rate" ? rate(row.open_rate) : rate(row.click_rate);
    out.sort((a, b) => {
      const left = read(a);
      const right = read(b);
      if (left === null && right === null) return tieBreak(a, b);
      if (left === null) return 1;
      if (right === null) return -1;
      return right - left || tieBreak(a, b);
    });
    return out;
  }
  out.sort(
    (a, b) => campaignSortTime(b) - campaignSortTime(a) || tieBreak(a, b),
  );
  return out;
}

/**
 * A total order. Without it, equal keys leave rows in whatever order the
 * engine's sort happens to produce, so re-rendering can reshuffle visually
 * identical rows under the user's thumb.
 */
function tieBreak(a: CampaignSortRow, b: CampaignSortRow): number {
  return String(a.id).localeCompare(String(b.id));
}

/**
 * The caption beside the control. Only says something when the sort is
 * PARTIAL — ordering everything you have is not worth a disclaimer, ordering
 * 100 of 900 rows is.
 */
export function campaignSortCaveat(
  sort: CampaignSort,
  hasMorePages: boolean,
  loadedCount: number,
): string | null {
  if (!hasMorePages || sort === "recent") return null;
  return `Sorted across the ${loadedCount} campaigns loaded so far — scroll to load more.`;
}
