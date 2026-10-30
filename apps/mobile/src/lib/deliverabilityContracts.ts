/**
 * deliverabilityContracts — the runtime boundary for every deliverability
 * wire payload.
 *
 * The hooks in this area used to `as`-cast the response (`(await
 * client.dmarc.list()) as {items?: DmarcRow[]} | DmarcRow[]`), so a shape
 * drift — the dominant failure class for this client — produced a silently
 * empty screen, or worse: `passCount + failCount` concatenating two numeric
 * STRINGS into "31020" and reporting it as a total.
 *
 * Every parser here follows the same three rules, modelled on the one existing
 * precedent (`normalizeSuppressionPage`):
 *   1. Coerce numerics behind a finite check; never trust the declared type.
 *   2. Drop malformed rows instead of rendering a half-row.
 *   3. Throw a typed error when the ENVELOPE itself is unrecognisable, so the
 *      screen shows an honest error rather than "nothing here".
 */

import { WireShapeError } from "./wireShapeError";

export { WireShapeError } from "./wireShapeError";
export { parseSendingStatus, type SendingStatus } from "./sendingStatusSchema";

/* ------------------------------------------------------------- coercion --- */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Numbers arrive as numbers OR numeric strings depending on the surface. */
export function numberOr(value: unknown, fallback: number): number {
  if (typeof value === "number")
    return Number.isFinite(value) ? value : fallback;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

/** `null` is a meaningful "unset" for caps and scores — keep it distinct from 0. */
export function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = numberOr(value, Number.NaN);
  return Number.isFinite(parsed) ? parsed : null;
}

export function str(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

export function bool(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}

/** Accept `[]`, `{items:[]}`, `{results:[]}` or `{data:[]}` — all three ship. */
export function itemsOf(value: unknown, resource: string): unknown[] {
  if (Array.isArray(value)) return value;
  if (isRecord(value)) {
    for (const key of [
      "items",
      "results",
      "data",
      "domains",
      "points",
      "rows",
    ]) {
      const candidate = value[key];
      if (Array.isArray(candidate)) return candidate;
    }
    // An object envelope with no recognised array is an empty page, not a
    // broken one — several handlers omit the key entirely when empty.
    return [];
  }
  throw new WireShapeError(resource);
}

function mapRows<T>(
  value: unknown,
  resource: string,
  parse: (row: Record<string, unknown>) => T | null,
): T[] {
  const out: T[] = [];
  for (const row of itemsOf(value, resource)) {
    if (!isRecord(row)) continue;
    const parsed = parse(row);
    if (parsed !== null) out.push(parsed);
  }
  return out;
}

/* --------------------------------------------------------------- archive ---
 * The archive parsers live in `archiveContracts.ts`. They are NOT re-exported
 * from here: that module imports the coercion primitives above, so a re-export
 * would make the pair mutually importing and put a class binding
 * (WireShapeError) inside an import cycle. Import them from
 * `@/lib/archiveContracts` directly.
 * -------------------------------------------------------------------------- */

/* ---------------------------------------------------------------- dmarc --- */

export interface DmarcReport {
  id: string;
  orgName: string;
  domain: string;
  policyP: string;
  policyPct: string;
  dateBegin: string;
  dateEnd: string;
  passCount: number;
  failCount: number;
  receivedAt: string;
}

export function parseDmarcReports(value: unknown): DmarcReport[] {
  const rows = mapRows(value, "DMARC report", (row) => ({
    id: String(row.id ?? row.reportId ?? ""),
    orgName: str(row.orgName),
    domain: str(row.domain),
    policyP: str(row.policyP),
    policyPct: str(row.policyPct),
    dateBegin: str(row.dateBegin),
    dateEnd: str(row.dateEnd),
    // The arithmetic on these two drives the whole header summary — coerce.
    passCount: Math.max(0, numberOr(row.passCount, 0)),
    failCount: Math.max(0, numberOr(row.failCount, 0)),
    receivedAt: str(row.receivedAt),
  }));
  return rows.sort((a, b) => {
    const at = Date.parse(a.receivedAt || a.dateEnd) || 0;
    const bt = Date.parse(b.receivedAt || b.dateEnd) || 0;
    return bt - at;
  });
}

export interface DmarcSuggestion {
  code: string;
  severity: string;
  action: string;
  reason: string;
  policyRecord: string;
}

export interface DmarcSource {
  sourceIp: string;
  messages: number;
  alignedPct: number;
  primaryDisposition: string;
}

export interface DmarcInsights {
  domain: string;
  periodDays: number;
  reportCount: number;
  totalMessages: number;
  alignedPct: number;
  disposition: { none: number; quarantine: number; reject: number };
  series: { date: string; alignedPct: number; messages: number }[];
  topFailingSources: DmarcSource[];
  suggestions: DmarcSuggestion[];
  latestPolicy: string;
}

function parseSources(value: unknown): DmarcSource[] {
  return mapRows(value, "DMARC source", (row) => {
    const ip = str(row.sourceIp).trim();
    if (!ip) return null;
    return {
      sourceIp: ip,
      messages: Math.max(0, numberOr(row.messages, 0)),
      alignedPct: numberOr(row.alignedPct, 0),
      primaryDisposition: str(row.primaryDisposition, "none"),
    };
  });
}

export function parseDmarcInsights(value: unknown): DmarcInsights {
  if (!isRecord(value)) throw new WireShapeError("DMARC insights");
  const alignment = isRecord(value.alignment) ? value.alignment : {};
  const disposition = isRecord(value.disposition) ? value.disposition : {};
  return {
    domain: str(value.domain),
    periodDays: Math.max(0, numberOr(value.periodDays, 0)),
    reportCount: Math.max(0, numberOr(value.reportCount, 0)),
    totalMessages: Math.max(0, numberOr(value.totalMessages, 0)),
    // Server sends 0-1; every consumer wants it that way, so do not rescale.
    alignedPct: numberOr(alignment.alignedPct, 0),
    disposition: {
      none: Math.max(0, numberOr(disposition.none, 0)),
      quarantine: Math.max(0, numberOr(disposition.quarantine, 0)),
      reject: Math.max(0, numberOr(disposition.reject, 0)),
    },
    series: mapRows(value.series ?? [], "DMARC series", (row) => ({
      date: str(row.date),
      alignedPct: numberOr(row.alignedPct, 0),
      messages: Math.max(0, numberOr(row.messages, 0)),
    })),
    topFailingSources: parseSources(value.topFailingSources ?? []),
    suggestions: mapRows(value.suggestions ?? [], "DMARC suggestion", (row) => {
      const action = str(row.action).trim();
      if (!action) return null;
      return {
        code: str(row.code),
        severity: str(row.severity, "info"),
        action,
        reason: str(row.reason),
        policyRecord: str(row.policyRecord),
      };
    }),
    latestPolicy: str(value.latestPolicy),
  };
}

/* -------------------------------------------------------------- domains --- */

export interface CustomDomain {
  id: string;
  domain: string;
  purpose: string;
  verified: boolean;
  dnsRecords: { type: string; name: string; value: string }[];
  createdAt: string;
  verifiedAt: string | null;
}

export function parseCustomDomains(value: unknown): CustomDomain[] {
  return mapRows(value, "custom domain", (row) => {
    const domain = str(row.domain).trim();
    if (!domain) return null;
    const records = Array.isArray(row.dns_records) ? row.dns_records : [];
    return {
      id: str(row.id) || domain,
      domain,
      purpose: str(row.purpose),
      verified: bool(row.verified),
      dnsRecords: records.flatMap((rec) =>
        isRecord(rec)
          ? [
              {
                type: str(rec.type, "TXT"),
                name: str(rec.name),
                value: str(rec.value),
              },
            ]
          : [],
      ),
      createdAt: str(row.createdAt),
      verifiedAt: str(row.verifiedAt) || null,
    };
  });
}

/* ------------------------------------------------------------------ hub --- */

export interface HubBreach {
  code: string;
  severity: string;
  title: string;
  detail: string;
  fixLabel: string;
  /** http(s)-validated external remediation link; empty when none. */
  fixHref: string;
  /** Desktop section slug ("suppressions", "domains", …); empty when none. */
  fixSection: string;
}

export interface HubBlocklistHit {
  subject: string;
  zone: string;
  tier1: boolean;
  checkedAt: string;
}

export interface DeliverabilityHub {
  score: number;
  grade: string;
  status: string;
  trend: string;
  trendDelta: number;
  history: number[];
  bounceRate: number;
  complaintRate: number;
  engagementRate: number;
  windowDays: number;
  sends7d: number;
  /** Server's verdict: is there enough sending for the score to mean anything? */
  sampleQualified: boolean;
  sends30d: number;
  minimumSampleSends: number;
  /** Server-authored explanation of the shortfall; may be empty. */
  sampleReason: string;
  autoThrottled: boolean;
  autoThrottleReason: string;
  breaches: HubBreach[];
  blocklistHits: HubBlocklistHit[];
  computedAt: string;
}

/**
 * The DEDICATED blocklist endpoint, which carries two fields the hub payload
 * does not: `delist_url` (the self-service removal form) and
 * `delisting_status`. Without them the screen can name a listing but offers no
 * way to act on it, which is the whole point of surfacing it on a phone.
 */
export interface BlocklistHitDetail {
  id: string;
  listName: string;
  identifier: string;
  tier1: boolean;
  firstSeenAt: string;
  delistUrl: string;
  delistingStatus: string;
}

export function parseBlocklistHits(value: unknown): BlocklistHitDetail[] {
  return mapRows(value, "blocklist hits", (row) => {
    const identifier = str(row.identifier).trim();
    const listName = str(row.list_name).trim();
    if (!identifier || !listName) return null;
    const url = str(row.delist_url).trim();
    return {
      id: str(row.id) || `${identifier}|${listName}`,
      listName,
      identifier,
      tier1: bool(row.tier1),
      firstSeenAt: str(row.first_seen_at),
      // Only http(s) is openable; anything else would hand Linking a scheme
      // the OS may route somewhere unexpected.
      delistUrl: /^https?:\/\//i.test(url) ? url : "",
      delistingStatus: str(row.delisting_status),
    };
  });
}

export function parseDeliverabilityHub(value: unknown): DeliverabilityHub {
  if (!isRecord(value)) throw new WireShapeError("deliverability hub");
  const totals = isRecord(value.totals) ? value.totals : {};
  return {
    score: Math.max(0, Math.min(100, numberOr(value.score, 0))),
    grade: str(value.grade),
    status: str(value.status),
    trend: str(value.trend, "flat"),
    trendDelta: numberOr(value.trend_delta, 0),
    history: (Array.isArray(value.history) ? value.history : [])
      .map((point) => numberOr(point, Number.NaN))
      .filter((point) => Number.isFinite(point)),
    bounceRate: numberOr(value.bounce_rate, 0),
    complaintRate: numberOr(value.complaint_rate, 0),
    engagementRate: numberOr(value.engagement_rate, 0),
    windowDays: Math.max(0, numberOr(value.window_days, 0)),
    sends7d: Math.max(0, numberOr(totals.sends_7d, 0)),
    // The server's own verdict on whether the score means anything, plus the
    // numbers behind it. All three were dropped on the floor, so the app
    // rendered an unqualified score as an authoritative grade.
    sampleQualified: value.sample_qualified === true,
    sends30d: Math.max(0, numberOr(totals.sends_30d, 0)),
    minimumSampleSends: Math.max(0, numberOr(value.minimum_sample_sends, 0)),
    // The server's OWN sentence for why the sample falls short ("fewer than
    // 1,000 successful campaign sends in the 30-day model window"). Rendered
    // verbatim rather than rebuilt from the counts: it names which sends count
    // and which window they are counted in, and a client-side reconstruction
    // gets that subtly wrong.
    sampleReason: str(value.sample_reason),
    autoThrottled: bool(value.auto_throttled),
    autoThrottleReason: str(value.auto_throttle_reason),
    breaches: mapRows(value.breaches ?? [], "breach", (row) => {
      const title = str(row.title).trim();
      if (!title) return null;
      const cta = isRecord(row.fix_cta) ? row.fix_cta : {};
      const href = str(cta.href).trim();
      return {
        code: str(row.code),
        severity: str(row.severity, "info"),
        title,
        detail: str(row.detail) || str(row.suggestion),
        fixLabel: str(cta.label),
        // Only http(s) is openable — same rule as delist_url above.
        fixHref: /^https?:\/\//i.test(href) ? href : "",
        fixSection: str(cta.section),
      };
    }),
    blocklistHits: mapRows(
      value.blocklist_hits ?? [],
      "blocklist hit",
      (row) => {
        const subject = str(row.subject).trim();
        if (!subject) return null;
        return {
          subject,
          zone: str(row.zone),
          tier1: bool(row.tier1),
          checkedAt: str(row.checked_at),
        };
      },
    ),
    computedAt: str(value.computed_at),
  };
}
