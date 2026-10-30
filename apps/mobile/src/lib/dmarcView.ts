/**
 * dmarcView — the pure presentation rules for DMARC.
 *
 * These were four hand-rolled formatters and two tone helpers living inside
 * the screen, where they could not be tested and where `formatAge` read
 * `Date.now()` inside a memo — so the "last received 5m ago" freshness label
 * FROZE at mount, which is the exact opposite of the pipeline-liveness signal
 * it exists to give. Everything here takes `now` as a parameter.
 *
 * Imports nothing from react-native, so it runs under the node vitest project.
 */
import { calendarDate, date, num, plural, relativeTime } from "./format";
import type { SignalTone } from "./deliverabilitySignals";
import { transitionLabel } from "./direction";

export interface DmarcRowLike {
  domain: string;
  orgName: string;
  policyP: string;
  policyPct: string;
  dateBegin: string;
  dateEnd: string;
  passCount: number;
  failCount: number;
  receivedAt: string;
}

/** Freshness of the ingestion pipeline, against a CALLER-supplied clock. */
export function reportAge(
  iso: string | null | undefined,
  now: number,
): string | null {
  if (!iso) return null;
  const ms = new Date(iso).getTime();
  if (!Number.isFinite(ms)) return null;
  return relativeTime(iso, { now });
}

/** "Jun 3 → Jun 4, 2026"; the year collapses when both ends share it. */
export function reportDateRange(
  begin: string | null | undefined,
  end: string | null | undefined,
): string {
  const b = begin ? new Date(begin) : null;
  const e = end ? new Date(end) : null;
  const bOk = b !== null && !Number.isNaN(b.getTime());
  const eOk = e !== null && !Number.isNaN(e.getTime());
  if (!bOk && !eOk) return "—";
  if (!bOk) return date(e);
  if (!eOk) return date(b);
  const sameYear = b!.getFullYear() === e!.getFullYear();
  return transitionLabel(
    calendarDate(b, { withYear: !sameYear }),
    calendarDate(e, { withYear: true }),
  );
}

/**
 * The published `p=` tag. A sampling rate below 100 means the policy applies
 * to only a fraction of mail, which materially changes what "p=reject" means —
 * so it is never dropped from the label.
 */
export function policyLabel(row: Pick<DmarcRowLike, "policyP" | "policyPct">): string | null {
  const p = (row.policyP ?? "").trim().toLowerCase();
  if (!p) return null;
  const word =
    p === "reject" ? "Reject" : p === "quarantine" ? "Quarantine" : "None";
  const pctRaw = (row.policyPct ?? "").trim();
  const pct = pctRaw ? Number(pctRaw) : Number.NaN;
  if (Number.isFinite(pct) && pct >= 0 && pct < 100) return `p=${word} ${pct}%`;
  return `p=${word}`;
}

export function policyTone(row: Pick<DmarcRowLike, "policyP">): SignalTone {
  const p = (row.policyP ?? "").trim().toLowerCase();
  if (p === "reject") return "success";
  if (p === "quarantine") return "warning";
  return "neutral";
}

export interface PassRate {
  total: number;
  /** Whole percent, capped at 99 whenever ANY failure exists. */
  display: number;
  tone: SignalTone;
  label: string;
}

/**
 * A handful of failures in a million messages rounds to 100% — and then the
 * badge reads "100% pass" beside a non-zero "Fail 7". Cap at 99 whenever there
 * is any failure so the badge, the tone and the counts never contradict.
 */
export function passRate(pass: number, fail: number): PassRate {
  const passCount = Number.isFinite(pass) ? Math.max(0, pass) : 0;
  const failCount = Number.isFinite(fail) ? Math.max(0, fail) : 0;
  const total = passCount + failCount;
  if (total === 0) {
    return { total: 0, display: 0, tone: "neutral", label: "No data" };
  }
  const raw = Math.round((passCount / total) * 100);
  const allPass = failCount === 0;
  const display = !allPass && raw >= 100 ? 99 : raw;
  const tone: SignalTone = allPass
    ? "success"
    : display >= 95
      ? "warning"
      : "danger";
  return { total, display, tone, label: `${display}% pass` };
}

export type DispositionFilter = "all" | "passing" | "failing";

/**
 * A zero-data row (0 pass, 0 fail) is neither passing nor failing — it renders
 * the neutral "No data" pill and must not be swept into "Passing".
 */
export function matchesDisposition(
  row: Pick<DmarcRowLike, "passCount" | "failCount">,
  filter: DispositionFilter,
): boolean {
  if (filter === "all") return true;
  if (filter === "failing") return row.failCount > 0;
  return row.failCount === 0 && row.passCount > 0;
}

export interface DmarcSummary {
  count: number;
  passing: number;
  failing: number;
  lastReceived: string | null;
  /** Sentence describing the EXPLICIT window, never an arbitrary row count. */
  caption: string;
}

/**
 * The old header summed pass/fail across "the newest 50 rows, whatever window
 * that happened to be" and printed the total with no denominator — so the same
 * number meant something different per tenant and per day. The window is now
 * stated.
 */
export function summarise(
  rows: readonly DmarcRowLike[],
  { windowLabel, now }: { windowLabel: string; now: number },
): DmarcSummary {
  let passing = 0;
  let failing = 0;
  let latestMs = 0;
  let latest: string | null = null;
  for (const row of rows) {
    passing += row.passCount;
    failing += row.failCount;
    const ms = row.receivedAt ? new Date(row.receivedAt).getTime() : Number.NaN;
    if (Number.isFinite(ms) && ms > latestMs) {
      latestMs = ms;
      latest = row.receivedAt;
    }
  }
  const lastReceived = reportAge(latest, now);
  return {
    count: rows.length,
    passing,
    failing,
    lastReceived,
    caption: `${plural(rows.length, "report")} in the last ${windowLabel} · ${num(passing)} passing · ${num(failing)} failing${
      lastReceived ? ` · newest ${lastReceived}` : ""
    }`,
  };
}

/* ------------------------------------------------------- policy advisor --- */

export interface DmarcPolicyAdvice {
  /** "p=none · monitoring" — the headline. */
  label: string;
  /** What this policy means and what to check next. */
  context: string;
  /** The observation-only boundary — always rendered with the advice. */
  boundary: string;
}

/**
 * Desktop's DmarcPolicyAdvisor wording, ported verbatim so the two clients
 * never disagree about what an observed `p=` value means. The boundary
 * sentence is load-bearing: the value comes from the latest aggregate REPORT,
 * not a live DNS lookup, and treating it as DNS truth is exactly the mistake
 * this card exists to prevent.
 */
export function dmarcPolicyAdvice(
  latestPolicy: string,
  domain: string,
): DmarcPolicyAdvice {
  const policy = latestPolicy.trim().toLowerCase();
  const boundary =
    "Observation only: this value came from the latest aggregate report in scope. It is not a live DNS lookup and must never replace a complete DMARC TXT record. Verify every existing tag, reporting address, and external authorization before changing DNS.";
  if (policy === "none") {
    return {
      label: "p=none · monitoring",
      context:
        "Aggregate-report payloads declared a monitoring policy. Review legitimate unaligned sources before considering enforcement.",
      boundary,
    };
  }
  if (policy === "quarantine") {
    return {
      label: "p=quarantine",
      context:
        "Aggregate-report payloads declared quarantine enforcement. Investigate unaligned legitimate senders before any further policy change.",
      boundary,
    };
  }
  if (policy === "reject") {
    return {
      label: "p=reject",
      context:
        "Aggregate-report payloads declared reject enforcement. Continue monitoring unexpected unaligned volume and reporting gaps.",
      boundary,
    };
  }
  if (policy === "unknown" && domain) {
    return {
      label: "Policy value not recognized",
      context: `The latest ingested report for ${domain} did not contain a recognized p=none, p=quarantine, or p=reject value. Inspect the report receipt and live DNS independently.`,
      boundary,
    };
  }
  if (domain) {
    return {
      label: "No policy observed in window",
      context: `No report in this window supplied policy evidence for ${domain}. This is an evidence gap, not a DNS-policy conclusion.`,
      boundary,
    };
  }
  return {
    label: "Multiple-domain scope",
    context:
      "Tenant-wide views can combine several domains and policies. Select one domain to inspect its latest reported policy evidence.",
    boundary,
  };
}

/** Sorted, de-duplicated sending domains present in a report set. */
export function domainsOf(rows: readonly DmarcRowLike[]): string[] {
  const set = new Set<string>();
  for (const row of rows) {
    const domain = row.domain.trim();
    if (domain) set.add(domain);
  }
  return Array.from(set).sort();
}
