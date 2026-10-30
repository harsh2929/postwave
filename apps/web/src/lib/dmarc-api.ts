/**
 * lib/dmarc-api.ts — DMARC aggregate-report evidence.
 *
 * Four `/api/v1/deliverability/dmarc-*` paths were reached by desktop and by
 * no web file.
 *
 * ZERO REPORTS DOES NOT MEAN ZERO MAIL, AND THE SERVER SAYS SO. The
 * suggestions carry an `action` and a written `reason`, and the reason for the
 * empty case is:
 *
 *   "No aggregate reports were ingested in this window. Report cadence is
 *    controlled by participating receivers, so this state does not prove that
 *    the domain is configured or that no mail was sent."
 *
 * That sentence is the whole value of the endpoint. A UI that renders
 * "0 reports · 0 messages" and stops invites the two conclusions the server
 * just ruled out. Suggestions are carried through and rendered verbatim.
 *
 * `sourceListTruncated` is the other flag that matters: a truncated source
 * list looks exactly like a complete one unless the client says otherwise.
 *
 * COVERAGE: this module wires 3 of them:
 *   /api/v1/deliverability/dmarc-insights   (?domain&days)
 *   /api/v1/deliverability/dmarc-reports    (?domain&from&to&limit)
 *   /api/v1/deliverability/dmarc-sources    (?ip&domain&days)
 * The remaining one (dmarc-suggestions/ack) is not called from the DMARC
 * page; `acknowledgeDmarcSuggestion` below is kept for its caller.
 *
 * QUERY PARAMETERS ARE AN ALLOW-LIST ON THE SERVER. `validateQueryParameters`
 * in apps/api/internal/dmarc rejects any name outside the list above with
 * `invalid_query`, and rejects a repeated name. Both builders therefore add a
 * key only when it carries a value — an empty `domain=` would be rejected as
 * `invalid_domain`, not ignored.
 */
import { api } from "@/lib/api";

export interface DmarcSuggestion {
  code: string;
  severity: string;
  action: string;
  /** The server's reasoning. Render verbatim. */
  reason: string;
}

export interface DmarcAlignment {
  bothPass: number;
  dkimOnlyPass: number;
  spfOnlyPass: number;
  neitherPass: number;
  alignedPct: number;
}

/** "none" | "quarantine" | "reject" | "unknown" — the receivers' applied action. */
export type DmarcDisposition = "none" | "quarantine" | "reject" | "unknown";

/**
 * Mirrors `dmarc.SourceRow`: one sending IP's slice of the window's totals.
 * DMARC evidence does not identify who operates the IP or why it sent.
 */
export interface DmarcSource {
  sourceIp: string;
  messages: number;
  dkimPass: number;
  spfPass: number;
  bothPass: number;
  /** 0–1, aligned (DKIM or SPF) share of `messages`. */
  alignedPct: number;
  primaryDisposition: DmarcDisposition;
  quarantined: number;
  rejected: number;
  /** Canonical hostname only; mailbox local-parts never cross the API. */
  envelopeFromDomain?: string;
}

export interface DmarcInsights {
  domain: string;
  periodDays: number;
  reportCount: number;
  totalMessages: number;
  sourceCount: number;
  /** True when topSources is a partial list. */
  sourceListTruncated: boolean;
  /** Days in the window that actually carried a report. */
  reportingDays: number;
  alignment: DmarcAlignment;
  suggestions: DmarcSuggestion[];
  /** Server-ranked by message volume. Rows without a source IP are dropped. */
  topSources: DmarcSource[];
  /** Server-ranked by unaligned volume. Empty when nothing failed alignment. */
  topFailingSources: DmarcSource[];
  generatedAt?: string;
}

/* ----- Evidence window (mirrors desktop components/dmarc/dmarc-contract.ts) ----- */

export type DmarcRange = "7d" | "30d" | "90d" | "365d";

export const DMARC_RANGES: ReadonlyArray<{
  value: DmarcRange;
  days: number;
  label: string;
}> = [
  { value: "7d", days: 7, label: "7 days" },
  { value: "30d", days: 30, label: "30 days" },
  { value: "90d", days: 90, label: "90 days" },
  { value: "365d", days: 365, label: "Maximum · 1 year" },
];

/**
 * The server caps `limit` at 500. The reports list is one bounded page with
 * no continuation cursor, so this is also the ceiling of what an export can
 * contain; `hasMore` on the response is the only signal that rows were cut.
 */
export const DMARC_REPORT_LIMIT = 500;

export function rangeDays(range: DmarcRange): number {
  return (
    DMARC_RANGES.find((candidate) => candidate.value === range)?.days ?? 30
  );
}

/** RFC 3339 start of the window, `rangeDays` before `now`. */
export function rangeStart(range: DmarcRange, now = new Date()): string {
  const start = new Date(
    now.getTime() - rangeDays(range) * 24 * 60 * 60 * 1_000,
  );
  return start.toISOString();
}

/* ----- Reports (mirrors dmarc.Report / listMeta in apps/api/internal/dmarc) ----- */

/** Tenant-minimized projection of one ingested aggregate report. */
export interface DmarcReportRow {
  /** Moosewave receipt UUID for the stored report. */
  id: string;
  orgName: string;
  /** The report ID carried inside the reporter's payload. */
  reportId: string;
  domain: string;
  /** "" | "none" | "quarantine" | "reject" | "unknown" — kept as string. */
  policyP: string;
  policyPct: number | null;
  dateBegin: string;
  dateEnd: string;
  passCount: number;
  failCount: number;
  receivedAt: string;
}

/** The scope the server actually applied — echoed back, not the request. */
export interface DmarcReportsScope {
  domain?: string;
  from?: string;
  to?: string;
}

export interface DmarcReportsPage {
  items: DmarcReportRow[];
  /** Database-clock receipt for the snapshot the rows were read from. */
  generatedAt: string;
  limit: number;
  returned: number;
  totalReports: number;
  /** True when `totalReports` exceeds `returned`; there is no cursor. */
  hasMore: boolean;
  /** Domains represented by stored aggregate reports — not a DNS inventory. */
  availableDomains: string[];
  domainInventoryTruncated: boolean;
  scope: DmarcReportsScope;
}

function asArray<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}
function num(v: unknown): number {
  return Number.isFinite(v) ? Number(v) : 0;
}
function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}
function optionalStr(v: unknown): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined;
}

const DISPOSITIONS = new Set<string>(["none", "quarantine", "reject"]);

function disposition(v: unknown): DmarcDisposition {
  return typeof v === "string" && DISPOSITIONS.has(v)
    ? (v as DmarcDisposition)
    : "unknown";
}

/** 0–1 ratio; anything outside the range is not a share and reads as 0. */
function ratio(v: unknown): number {
  const n = num(v);
  return n >= 0 && n <= 1 ? n : 0;
}

/**
 * One source row, or null when it carries no source IP — a row that cannot
 * be named cannot be opened, and inventing an identifier for it would put a
 * drill-down on screen that requests nothing real.
 */
function parseDmarcSource(v: unknown): DmarcSource | null {
  if (typeof v !== "object" || v === null) return null;
  const row = v as Record<string, unknown>;
  const sourceIp = str(row.sourceIp).trim();
  if (!sourceIp) return null;
  const envelopeFromDomain = optionalStr(row.envelopeFromDomain);
  return {
    sourceIp,
    messages: num(row.messages),
    dkimPass: num(row.dkimPass),
    spfPass: num(row.spfPass),
    bothPass: num(row.bothPass),
    alignedPct: ratio(row.alignedPct),
    primaryDisposition: disposition(row.primaryDisposition),
    quarantined: num(row.quarantined),
    rejected: num(row.rejected),
    ...(envelopeFromDomain ? { envelopeFromDomain } : {}),
  };
}

function parseDmarcSources(v: unknown): DmarcSource[] {
  return asArray<unknown>(v)
    .map(parseDmarcSource)
    .filter((row): row is DmarcSource => row !== null);
}

export interface DmarcInsightsOptions {
  /** Canonical sending domain. Omit for the tenant-wide rollup. */
  domain?: string;
  /** Window length; the server validates 1–365 and defaults to 30. */
  days?: number;
}

export async function getDmarcInsights(
  opts: DmarcInsightsOptions = {},
): Promise<DmarcInsights> {
  const query: Record<string, string | number> = {};
  if (opts.domain) query.domain = opts.domain;
  if (opts.days) query.days = opts.days;
  const res = await api.get<DmarcInsights>(
    "/api/v1/deliverability/dmarc-insights",
    { query },
  );
  const a = res?.alignment;
  return {
    ...res,
    domain: str(res?.domain),
    periodDays: num(res?.periodDays),
    reportCount: num(res?.reportCount),
    totalMessages: num(res?.totalMessages),
    sourceCount: num(res?.sourceCount),
    sourceListTruncated: res?.sourceListTruncated === true,
    reportingDays: num(res?.reportingDays),
    alignment: {
      bothPass: num(a?.bothPass),
      dkimOnlyPass: num(a?.dkimOnlyPass),
      spfOnlyPass: num(a?.spfOnlyPass),
      neitherPass: num(a?.neitherPass),
      alignedPct: num(a?.alignedPct),
    },
    suggestions: asArray<DmarcSuggestion>(res?.suggestions),
    topSources: parseDmarcSources(res?.topSources),
    topFailingSources: parseDmarcSources(res?.topFailingSources),
  };
}

/* ----- Source drill-down (mirrors dmarc.SourceDetailResponse) ----- */

/** The server caps the per-report breakdown at this many rows. */
export const DMARC_SOURCE_REPORT_LIMIT = 200;

/** One aggregate report's contribution to a single source IP. */
export interface DmarcSourcePerReport {
  /** Moosewave receipt UUID of the stored report. */
  reportId: string;
  orgName: string;
  dateBegin: string;
  dateEnd: string;
  messages: number;
  dkimPass: number;
  spfPass: number;
  bothPass: number;
  alignedPct: number;
  primaryDisposition: DmarcDisposition;
}

export interface DmarcSourceDetail {
  sourceIp: string;
  periodDays: number;
  /** Absent for the tenant-wide scope. */
  domain?: string;
  generatedAt: string;
  windowStart: string;
  windowEnd: string;
  /**
   * True when the per-report list stopped at the server limit. The summary
   * still covers the complete scope; there is no continuation cursor.
   */
  hasMore: boolean;
  summary: DmarcSource;
  /** Newest first. */
  perReport: DmarcSourcePerReport[];
}

export interface DmarcSourceDetailOptions {
  /** The source IP exactly as the insights ranking named it. Required. */
  ip: string;
  /** Canonical sending domain. Omit for every domain with stored reports. */
  domain?: string;
  /** Window length; the server validates 1–365 and defaults to 30. */
  days?: number;
}

/**
 * Raised when the server answered for a different scope than was asked —
 * rendering it would attribute one source's evidence to another.
 */
export class DmarcSourceScopeMismatchError extends Error {
  constructor() {
    super(
      "The source-detail response did not match the requested source and window, so it is not shown.",
    );
    this.name = "DmarcSourceScopeMismatchError";
  }
}

/**
 * GET /api/v1/deliverability/dmarc-sources — every stored report that
 * carried records for one source IP within the window, with that source's
 * totals. The query is allow-listed on the server (ip, domain, days); a key
 * is sent only when it carries a value.
 */
export async function getDmarcSourceDetail(
  opts: DmarcSourceDetailOptions,
): Promise<DmarcSourceDetail> {
  const query: Record<string, string | number> = { ip: opts.ip };
  if (opts.domain) query.domain = opts.domain;
  if (opts.days) query.days = opts.days;
  const res = await api.get<Record<string, unknown>>(
    "/api/v1/deliverability/dmarc-sources",
    { query },
  );
  const summary = parseDmarcSource(res?.summary);
  const sourceIp = str(res?.sourceIp);
  const periodDays = num(res?.periodDays);
  const domain = optionalStr(res?.domain);
  // Both sides are canonical renderings (Postgres HOST() for the ranking, Go
  // net.IP.String() for the echo); only hex case can legitimately differ.
  const asked = opts.ip.toLowerCase();
  if (
    !summary ||
    sourceIp.toLowerCase() !== asked ||
    summary.sourceIp.toLowerCase() !== asked ||
    (opts.days !== undefined && periodDays !== opts.days) ||
    (domain ?? "") !== (opts.domain ?? "")
  ) {
    throw new DmarcSourceScopeMismatchError();
  }
  const perReport = asArray<Record<string, unknown>>(res?.perReport)
    .filter((row) => typeof row === "object" && row !== null)
    .map((row) => ({
      reportId: str(row.reportId),
      orgName: str(row.orgName),
      dateBegin: str(row.dateBegin),
      dateEnd: str(row.dateEnd),
      messages: num(row.messages),
      dkimPass: num(row.dkimPass),
      spfPass: num(row.spfPass),
      bothPass: num(row.bothPass),
      alignedPct: ratio(row.alignedPct),
      primaryDisposition: disposition(row.primaryDisposition),
    }));
  return {
    sourceIp,
    periodDays,
    ...(domain ? { domain } : {}),
    generatedAt: str(res?.generatedAt),
    windowStart: str(res?.windowStart),
    windowEnd: str(res?.windowEnd),
    hasMore: res?.hasMore === true,
    summary,
    perReport,
  };
}

/** Aligned share for display, or null when there is no denominator. */
export function dmarcSourceAlignedShare(
  alignedPct: number,
  messages: number,
): string | null {
  if (messages === 0) return null;
  return `${(alignedPct * 100).toFixed(alignedPct >= 0.995 ? 2 : 1)}%`;
}

/** The receivers' applied action, in the words desktop uses. */
export function dmarcDispositionLabel(value: DmarcDisposition): string {
  if (value === "none") return "Reported none";
  if (value === "quarantine") return "Quarantine";
  if (value === "reject") return "Reject";
  return "Unknown action";
}

export interface DmarcReportsOptions {
  /** Canonical sending domain. Omit for every domain with stored reports. */
  domain?: string;
  /** RFC 3339 window start (inclusive of reports ending on or after it). */
  from?: string;
  /** RFC 3339 window end (inclusive of reports beginning on or before it). */
  to?: string;
  /** 1–500; the server defaults to 50. */
  limit?: number;
}

/**
 * GET /api/v1/deliverability/dmarc-reports — one bounded page of stored
 * aggregate reports with the scope and completeness receipt the server
 * applied. Rows are what the export and the detail view are rendered from.
 */
export async function listDmarcReports(
  opts: DmarcReportsOptions = {},
): Promise<DmarcReportsPage> {
  const query: Record<string, string | number> = {};
  if (opts.domain) query.domain = opts.domain;
  if (opts.from) query.from = opts.from;
  if (opts.to) query.to = opts.to;
  if (opts.limit) query.limit = opts.limit;
  const res = await api.get<{ items?: unknown; meta?: unknown }>(
    "/api/v1/deliverability/dmarc-reports",
    { query },
  );
  const meta = (res?.meta ?? {}) as Record<string, unknown>;
  const scope = (meta.scope ?? {}) as Record<string, unknown>;
  const items = asArray<Record<string, unknown>>(res?.items).map((row) => ({
    id: str(row.id),
    orgName: str(row.orgName),
    reportId: str(row.reportId),
    domain: str(row.domain),
    policyP: str(row.policyP),
    policyPct: Number.isFinite(row.policyPct) ? Number(row.policyPct) : null,
    dateBegin: str(row.dateBegin),
    dateEnd: str(row.dateEnd),
    passCount: num(row.passCount),
    failCount: num(row.failCount),
    receivedAt: str(row.receivedAt),
  }));
  return {
    items,
    generatedAt: str(meta.generatedAt),
    limit: num(meta.limit),
    returned: num(meta.returned),
    totalReports: num(meta.totalReports),
    hasMore: meta.hasMore === true,
    availableDomains: asArray<unknown>(meta.availableDomains).filter(
      (d): d is string => typeof d === "string" && d !== "",
    ),
    domainInventoryTruncated: meta.domainInventoryTruncated === true,
    scope: {
      domain: optionalStr(scope.domain),
      from: optionalStr(scope.from),
      to: optionalStr(scope.to),
    },
  };
}

/* ----- Client-side filter + CSV export over loaded rows ----- */

export type DmarcReportFilter = "all" | "aligned" | "failed";

/**
 * Filters loaded rows. "aligned" requires at least one message AND no
 * unaligned messages — a zero-message report has no alignment to be fully
 * aligned about, so it is excluded rather than counted as a pass.
 */
export function filterDmarcReports(
  rows: readonly DmarcReportRow[],
  filter: DmarcReportFilter,
  query: string,
): DmarcReportRow[] {
  const needle = query.trim().toLocaleLowerCase().slice(0, 256);
  return rows.filter((report) => {
    if (
      filter === "aligned" &&
      (report.passCount + report.failCount === 0 || report.failCount > 0)
    ) {
      return false;
    }
    if (filter === "failed" && report.failCount === 0) return false;
    return (
      !needle ||
      report.domain.toLocaleLowerCase().includes(needle) ||
      report.orgName.toLocaleLowerCase().includes(needle) ||
      report.reportId.toLocaleLowerCase().includes(needle) ||
      report.id.toLocaleLowerCase().includes(needle)
    );
  });
}

/** Neutralize spreadsheet formulas before RFC-4180 quoting. */
export function safeDmarcCsvCell(value: string | number | boolean): string {
  let serialized = String(value);
  if (/^[=+\-@]/u.test(serialized)) serialized = `'${serialized}`;
  if (/[",\n\r]/u.test(serialized)) {
    return `"${serialized.replace(/"/gu, '""')}"`;
  }
  return serialized;
}

/**
 * The evidence receipt that rides on every exported row. A CSV that carries
 * only report rows cannot say what scope produced it, whether the page was
 * cut at the limit, or whether a local filter narrowed it — so the receipt
 * columns lead every line and are identical to desktop's, byte for byte.
 */
export interface DmarcCsvReceipt {
  exportedAt: string;
  snapshotGeneratedAt: string;
  scopeDomain: string;
  scopeFrom: string;
  scopeTo: string;
  scopeWindowDays: number;
  localFilter: DmarcReportFilter;
  localQuery: string;
  totalReports: number;
  partial: boolean;
  stale: boolean;
}

export const DMARC_CSV_HEADER = [
  "export_created_at",
  "snapshot_generated_at",
  "scope_domain",
  "scope_from",
  "scope_to",
  "scope_window_days",
  "local_filter",
  "local_query",
  "scope_total_reports",
  "partial_export",
  "stale_snapshot",
  "postwave_receipt_id",
  "report_id",
  "sending_domain",
  "reporting_organization",
  "observed_policy",
  "observed_policy_pct",
  "period_begin_utc",
  "period_end_utc",
  "aligned_messages",
  "unaligned_messages",
  "ingested_at",
] as const;

export function buildDmarcCsv(
  rows: readonly DmarcReportRow[],
  receipt: DmarcCsvReceipt,
): string {
  const receiptCells: Array<string | number | boolean> = [
    receipt.exportedAt,
    receipt.snapshotGeneratedAt,
    receipt.scopeDomain,
    receipt.scopeFrom,
    receipt.scopeTo,
    receipt.scopeWindowDays,
    receipt.localFilter,
    receipt.localQuery,
    receipt.totalReports,
    receipt.partial,
    receipt.stale,
  ];
  const reportCells = (report: DmarcReportRow): Array<string | number> => [
    report.id,
    report.reportId,
    report.domain,
    report.orgName,
    report.policyP || "unknown",
    report.policyPct ?? "",
    report.dateBegin,
    report.dateEnd,
    report.passCount,
    report.failCount,
    report.receivedAt,
  ];
  const header = DMARC_CSV_HEADER.map(safeDmarcCsvCell).join(",");
  const lines = rows.map((report) =>
    [...receiptCells, ...reportCells(report)].map(safeDmarcCsvCell).join(","),
  );
  return `${header}\n${lines.join("\n")}`;
}

/** Same name desktop suggests, so exports from either client sort together. */
export function dmarcExportFilename(range: DmarcRange, domain: string): string {
  return `dmarc-reports-${range}-${domain || "all-domains"}.csv`;
}

/**
 * Acknowledges a DMARC suggestion.
 *
 * This build answers `suggestion_acknowledgements_disabled`. That is a
 * capability statement, not a fault: acknowledgements are simply not
 * available here, and a caller should say so rather than retrying or
 * reporting an error the operator could act on.
 */
export async function acknowledgeDmarcSuggestion(
  code: string,
): Promise<{ acknowledged: true } | { unavailable: true }> {
  try {
    await api.post("/api/v1/deliverability/dmarc-suggestions/ack", { code });
    return { acknowledged: true };
  } catch (err) {
    if (
      (err as { code?: string })?.code === "suggestion_acknowledgements_disabled"
    ) {
      return { unavailable: true };
    }
    throw err;
  }
}
