/**
 * privacyPosture — the tenant-wide DSAR clock, aggregated server-side.
 *
 * Mobile already shows an overdue count, derived by `summarizeQueue` from the
 * FIRST PAGE of GET /api/v1/privacy/requests (limit=100). For almost every
 * workspace that is the whole queue and the number is right. On a workspace
 * with more than a hundred requests it silently undercounts — and the number
 * it undercounts is a statutory deadline, which is the one figure on this
 * screen that must not be approximate.
 *
 * GET /api/v1/privacy/portal answers the same question with a SQL aggregate
 * over the whole table (`loadDSARSummary`: open = not completed, overdue =
 * `completed_at IS NULL AND due_at < now()`), so it is the authoritative
 * source. It is ScopeAdmin (apps/api/internal/privacy_portal/handlers.go:67
 * — `admin := apikeys.RequireScope(apikeys.ScopeAdmin)`), so a non-admin, or
 * a deployment that has not mounted it, gets nothing — and the caller falls
 * back to the page-derived count rather than showing an error on a screen
 * whose job is filing a request.
 *
 * Free of react-native/expo (its only import, `lib/format`, is itself
 * import-free) so the parse and the precedence rule are unit-tested.
 */
import { plural } from "@/lib/format";


export interface PrivacyPosture {
  /** Open requests across the whole tenant. */
  open: number;
  /** Open AND past their statutory due date. */
  overdue: number;
  /** Global Privacy Control signals recorded. */
  gpcSignaled: number | null;
  doNotSell: number | null;
  doubleOptInPending: number | null;
  /** When the server computed it. Absent = don't claim a freshness. */
  generatedAt: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : null;
}

/**
 * Parse GET /api/v1/privacy/portal.
 *
 * `dsar_requests` is a per-request-type breakdown, not a total, so open and
 * overdue are summed across the types. Returns null when the payload carries
 * no DSAR block at all: a posture with no numbers in it is not a posture, and
 * rendering it as "0 overdue" would be a claim we did not receive.
 */
export function parsePrivacyPosture(raw: unknown): PrivacyPosture | null {
  if (!isRecord(raw)) return null;
  const rows = raw.dsar_requests;
  if (!Array.isArray(rows)) return null;
  let open = 0;
  let overdue = 0;
  let sawRow = false;
  for (const entry of rows) {
    if (!isRecord(entry)) continue;
    const rowOpen = count(entry.open);
    const rowOverdue = count(entry.overdue);
    if (rowOpen == null && rowOverdue == null) continue;
    sawRow = true;
    open += rowOpen ?? 0;
    overdue += rowOverdue ?? 0;
  }
  // An EMPTY array is a legitimate answer — the tenant has no requests at all
  // — and is different from a payload with no dsar_requests key.
  if (!sawRow && rows.length > 0) return null;
  return {
    open,
    overdue,
    gpcSignaled: count(raw.gpc_signaled_count),
    doNotSell: count(raw.do_not_sell_count),
    doubleOptInPending: count(raw.double_optin_pending),
    generatedAt:
      typeof raw.generated_at === "string" && raw.generated_at
        ? raw.generated_at
        : null,
  };
}

/**
 * Which overdue/open figures to show.
 *
 * The server aggregate WINS when it is available, because the page-derived
 * one is a floor rather than a total. When it is not available (non-admin, or
 * an older deployment) the page-derived count is used and `scope` says so —
 * so the UI can avoid implying tenant-wide coverage it does not have.
 */
export function resolvedPrivacyCounts(input: {
  posture: PrivacyPosture | null;
  /** From summarizeQueue over the loaded page. */
  pageOpen: number;
  pageOverdue: number;
  /** True when the loaded page was truncated (a cursor came back). */
  pageTruncated: boolean;
}): { open: number; overdue: number; scope: "tenant" | "loaded" } {
  if (input.posture) {
    return {
      open: input.posture.open,
      overdue: input.posture.overdue,
      scope: "tenant",
    };
  }
  return {
    open: input.pageOpen,
    overdue: input.pageOverdue,
    scope: input.pageTruncated ? "loaded" : "tenant",
  };
}

/**
 * The line under the queue button. It names the SCOPE of the number when the
 * number cannot speak for the whole tenant — "3 overdue" that silently means
 * "3 overdue in the first hundred" is the failure this exists to prevent.
 */
export function privacyPostureLine(input: {
  open: number;
  overdue: number;
  scope: "tenant" | "loaded";
}): string {
  const noun = (n: number, one: string, many: string) => plural(n, one, many);
  const base =
    input.overdue > 0
      ? `${noun(input.overdue, "request is", "requests are")} past the statutory deadline · ${noun(input.open, "open", "open")}`
      : input.open > 0
        ? `${noun(input.open, "open request", "open requests")}, none overdue`
        : "No open privacy requests.";
  return input.scope === "loaded"
    ? `${base}. Counted over the requests loaded here, not the whole queue.`
    : base;
}
