/**
 * lib/apiUsageDashboard.ts — aggregation, copy and paging state for the
 * "API usage & cost" section of Plan & usage, and for its cost-ledger detail.
 *
 * lib/apiUsage.ts owns the WIRE: it turns the five responses into typed rows.
 * This file owns what the phone SAYS about them, kept pure (no react-native,
 * no expo) so the sentences and the ledger's page arithmetic run under node
 * vitest.
 *
 * MONEY RULES, the same ones lib/spendControls.ts follows:
 *   - every dollar figure is the metering ledger's own number, rendered
 *     through fmtCentsAsDollars; nothing here multiplies or extrapolates;
 *   - a window with sends and ZERO metered cost is the unconfigured-metering
 *     case (apps/api/internal/cost/pricing.go: the ledger recorded cents=0
 *     for every entry until pricing landed). "$0.00" alone reads as a bill of
 *     nothing, so the tile says no cost was RECORDED, and the projected-cost
 *     tile — $0.00 extrapolated from nothing — is dropped rather than shown;
 *   - the "projected" tiles are the server's own linear 30-day figures
 *     (api_usage_dashboard.go Summary) and are labelled as estimates;
 *   - the words "billed" and "charged" never appear. The ledger is metered
 *     cost; whether it becomes an invoice is Stripe's to say, not ours.
 *
 * ROLES come from the routeauth manifest: /api-usage/* is admin, /costs and
 * /costs/ledger are viewer. `apiUsageAccess` splits the section in two so a
 * viewer's screen never fires a read whose only possible answer is 403.
 */
import {
  API_USAGE_WINDOWS,
  COST_GROUP_BYS,
  aggregateRowLabel,
  aggregateTotals,
  fmtCentsAsDollars,
  mergeLedgerRows,
  type ApiUsageKeyRow,
  type ApiUsagePoint,
  type ApiUsageSummary,
  type ApiUsageWindow,
  type CostAggregateRow,
  type CostGroupBy,
  type CostLedgerEntry,
  type CostLedgerPage,
} from "./apiUsage";
import { date, dateTime, EMDASH, num } from "./format";
import { canAccessMinimumRole } from "./mobileRouteManifest";

/* ---------- window + access ------------------------------------------- */

export type ApiUsageWindowValue = `${ApiUsageWindow}`;

/** Segmented-control options for the window: 7d / 30d / 90d, like desktop. */
export const API_USAGE_WINDOW_OPTIONS: readonly {
  value: ApiUsageWindowValue;
  label: string;
}[] = API_USAGE_WINDOWS.map((days) => ({
  value: String(days) as ApiUsageWindowValue,
  label: `${days}d`,
}));

/** A control value back to a supported window; anything else is 30. */
export function parseApiUsageWindow(value: string): ApiUsageWindow {
  const n = Number(value);
  return (API_USAGE_WINDOWS as readonly number[]).includes(n)
    ? (n as ApiUsageWindow)
    : 30;
}

export interface ApiUsageAccess {
  /** GET /api-usage/summary|keys|timeseries — manifest floor admin. */
  usage: boolean;
  /** GET /costs and /costs/ledger — manifest floor viewer. */
  costs: boolean;
}

export function apiUsageAccess(
  role: string | undefined | null,
  mode?: "api_key" | "session" | null,
): ApiUsageAccess {
  return {
    usage: canAccessMinimumRole("admin", role, mode),
    costs: canAccessMinimumRole("viewer", role, mode),
  };
}

/** Desktop's section description, verbatim, so the two clients agree. */
export const API_USAGE_DESCRIPTION =
  "API sends, metered cost, and active keys for this workspace. Cost figures come from the metering ledger.";

export const ADMIN_ONLY_USAGE_NOTE =
  "Per-key API usage and send counts are shown to workspace admins.";

export const API_USAGE_OFFLINE_NOTE =
  "API usage and cost need a connection — reconnect to see current numbers.";

export const LEDGER_OFFLINE_NOTE =
  "The cost ledger needs a connection — reconnect to load it.";

/* ---------- summary ----------------------------------------------------- */

// No terminal period: `stat` closes the spoken sentence itself, and a tile
// hint is a fragment like "415/day average" — a period here read as "sends..".
export const METERED_COST_UNRECORDED =
  "No metered cost recorded for these sends";

const PROJECTION_HINT = "at the current rate (estimate)";

/**
 * True when the window holds no usage at all: the summary totals are zero
 * and no point carries a send or a cent. `keys` is deliberately not
 * consulted — /api-usage/keys LEFT JOINs every unrevoked key, so it is never
 * empty even when nothing was used.
 */
export function usageWindowIsEmpty(
  summary: ApiUsageSummary | null | undefined,
  points: readonly ApiUsagePoint[] | null | undefined,
): boolean {
  if (summary && (summary.totalSends > 0 || summary.totalCostCents > 0)) {
    return false;
  }
  for (const p of points ?? []) {
    if (p.sends > 0 || p.costCents > 0) return false;
  }
  return true;
}

export function usageEmptyCopy(days: number): string {
  return `No API usage recorded in the last ${days} days.`;
}

export interface UsageStat {
  key: string;
  label: string;
  value: string;
  hint: string | null;
  /** One sentence for VoiceOver: label, value and hint together. */
  spoken: string;
}

function stat(
  key: string,
  label: string,
  value: string,
  hint: string | null,
): UsageStat {
  return {
    key,
    label,
    value,
    hint,
    spoken: hint ? `${label}: ${value}, ${hint}.` : `${label}: ${value}.`,
  };
}

/**
 * The stat tiles for the summary card. Ported from desktop's summaryStats
 * with two honesty edits: a window with sends and no metered cost says so
 * instead of "$0.00/day average", and the projected-cost tile is omitted
 * when there is no cost to project from.
 */
export function summaryStats(s: ApiUsageSummary): UsageStat[] {
  const days = s.windowDays;
  const unrecorded = s.totalCostCents === 0 && s.totalSends > 0;
  const out: UsageStat[] = [
    stat(
      "sends",
      `Sends (${days}d)`,
      num(s.totalSends),
      `${num(Math.round(s.avgSendsPerDay))}/day average`,
    ),
    stat(
      "cost",
      `Metered cost (${days}d)`,
      fmtCentsAsDollars(s.totalCostCents),
      unrecorded
        ? METERED_COST_UNRECORDED
        : `${fmtCentsAsDollars(Math.round(s.avgCostCentsPerDay))}/day average`,
    ),
    stat("active_keys", "Active keys", num(s.activeKeys), null),
    stat(
      "projected_sends",
      "Projected sends (30d)",
      num(s.projected30dSends),
      PROJECTION_HINT,
    ),
  ];
  if (s.totalCostCents > 0) {
    out.push(
      stat(
        "projected_cost",
        "Projected cost (30d)",
        fmtCentsAsDollars(s.projected30dCostCents),
        PROJECTION_HINT,
      ),
    );
  }
  return out;
}

/* ---------- timeseries -------------------------------------------------- */

export function sendsSeries(
  points: readonly ApiUsagePoint[] | null | undefined,
): number[] {
  return (points ?? []).map((p) => p.sends);
}

/** Cents → dollars to two places, so the chart's axis matches the tiles. */
export function costSeriesDollars(
  points: readonly ApiUsagePoint[] | null | undefined,
): number[] {
  return (points ?? []).map((p) => Math.round(p.costCents) / 100);
}

export function seriesLabels(
  points: readonly ApiUsagePoint[] | null | undefined,
): string[] {
  return (points ?? []).map((p) => date(p.date));
}

/** Whether a cost chart would show anything but a flat zero line. */
export function seriesHasCost(
  points: readonly ApiUsagePoint[] | null | undefined,
): boolean {
  return (points ?? []).some((p) => p.costCents > 0);
}

/* ---------- per-key rows ------------------------------------------------ */

export const TOP_KEYS_SHOWN = 5;

/** The rows to render; the normaliser already sorted them cost-desc. */
export function topKeys(
  rows: readonly ApiUsageKeyRow[] | null | undefined,
  limit: number = TOP_KEYS_SHOWN,
): ApiUsageKeyRow[] {
  return (rows ?? []).slice(0, Math.max(0, limit));
}

export function keyRowTitle(row: ApiUsageKeyRow): string {
  return row.label || "(unlabeled)";
}

export function keyRowMeta(row: ApiUsageKeyRow): string {
  const parts: string[] = [];
  if (row.prefix) parts.push(`${row.prefix}…`);
  if (row.actorType) parts.push(row.actorType);
  return parts.join(" · ");
}

export function keyRowSpoken(row: ApiUsageKeyRow): string {
  const prefix = row.prefix ? ` (${row.prefix}…)` : "";
  const actor = row.actorType || "unknown actor";
  return `${keyRowTitle(row)}${prefix}, ${actor}: ${num(row.sends)} sends, ${fmtCentsAsDollars(row.costCents)} metered cost.`;
}

/** Footer under the per-key list when it was truncated; null when not. */
export function moreKeysCopy(total: number, shown: number): string | null {
  if (total <= shown) return null;
  return `Showing the top ${shown} of ${num(total)} keys by metered cost.`;
}

/* ---------- cost totals ------------------------------------------------- */

export const COST_GROUP_OPTIONS: readonly {
  value: CostGroupBy;
  label: string;
}[] = COST_GROUP_BYS.map((g) => ({ value: g.key, label: g.label }));

export function costRowSpoken(row: CostAggregateRow, by: CostGroupBy): string {
  return `${aggregateRowLabel(row, by)}: ${num(row.count)} entries, quantity ${num(row.quantity)}, ${fmtCentsAsDollars(row.cents)}.`;
}

export function costTotalsSpoken(rows: readonly CostAggregateRow[]): string {
  const t = aggregateTotals(rows);
  return `Total: ${num(t.count)} entries, quantity ${num(t.quantity)}, ${fmtCentsAsDollars(t.cents)}.`;
}

export function costTotalsEmptyCopy(days: number): string {
  return `No metered cost in the last ${days} days.`;
}

/* ---------- ledger ------------------------------------------------------ */

export interface LedgerLine {
  id: number;
  when: string;
  kind: string;
  key: string;
  quantity: string;
  cost: string;
  spoken: string;
}

/** One ledger entry as the row renders it; blanks are em-dashes, not "". */
export function ledgerLine(entry: CostLedgerEntry): LedgerLine {
  const when = entry.at ? dateTime(entry.at) : EMDASH;
  const kind = entry.kind || EMDASH;
  const key = entry.apiKeyId || EMDASH;
  const quantity = num(entry.quantity);
  const cost = fmtCentsAsDollars(entry.cents);
  const keyPart = entry.apiKeyId ? `, key ${entry.apiKeyId}` : "";
  return {
    id: entry.id,
    when,
    kind,
    key,
    quantity,
    cost,
    spoken: `${kind} on ${when}${keyPart}: quantity ${quantity}, ${cost}.`,
  };
}

export function ledgerEmptyCopy(days: number): string {
  return `No ledger entries in the last ${days} days.`;
}

export function ledgerSubtitle(days: number): string {
  return `Itemized metering entries, last ${days} days. Cost figures come from the metering ledger.`;
}

export interface LedgerFailure {
  message: string;
  retryable: boolean;
}

export interface LedgerState {
  rows: CostLedgerEntry[];
  /** The last successful page's nextCursor; null once the list is complete. */
  cursor: string | null;
  hasMore: boolean;
  loading: boolean;
  /** True after any page has landed — the difference between "empty" and "not asked yet". */
  loadedOnce: boolean;
  error: LedgerFailure | null;
}

export const LEDGER_INITIAL: LedgerState = {
  rows: [],
  cursor: null,
  hasMore: false,
  loading: false,
  loadedOnce: false,
  error: null,
};

export type LedgerAction =
  | { type: "reset" }
  | { type: "load" }
  | { type: "loaded"; page: CostLedgerPage; append: boolean }
  | { type: "failed"; error: LedgerFailure };

/**
 * The cursor-paged drilldown's state machine. A failed "load more" keeps the
 * pages already on screen (they were real), and `append` merges through
 * mergeLedgerRows so a re-served boundary row cannot show as double cost.
 */
export function ledgerReducer(
  state: LedgerState,
  action: LedgerAction,
): LedgerState {
  switch (action.type) {
    case "reset":
      return LEDGER_INITIAL;
    case "load":
      return { ...state, loading: true, error: null };
    case "loaded":
      return {
        rows: action.append
          ? mergeLedgerRows(state.rows, action.page.rows)
          : action.page.rows,
        cursor: action.page.nextCursor,
        hasMore: action.page.nextCursor !== null,
        loading: false,
        loadedOnce: true,
        error: null,
      };
    case "failed":
      return { ...state, loading: false, error: action.error };
    default:
      return state;
  }
}

export interface LedgerRetry {
  cursor: string | null;
  append: boolean;
}

/**
 * What a Retry should ask for: the page that failed. With rows on screen the
 * failure was a "load more", so retry from the last good cursor and append;
 * with none, page one failed, so start over.
 */
export function ledgerRetry(state: LedgerState): LedgerRetry {
  return state.rows.length > 0
    ? { cursor: state.cursor, append: true }
    : { cursor: null, append: false };
}
