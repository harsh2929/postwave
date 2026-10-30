/**
 * lib/duplicateScan.ts — parsing one immutable duplicate-candidate manifest.
 *
 * THE SHAPES THIS MIRRORS, read from the Go source rather than from a doc:
 *   - `Scan`      apps/api/internal/subscriber_dedupe/scan.go:48-57
 *   - `ScanPair`  scan.go:62-73
 *   - `Evidence`  scan.go:39-43
 *   - `scanPage`  scan.go:75-81  (`{scan, pairs, count, next_cursor, complete}`)
 *
 * FOUR SERVER FACTS THAT DECIDE WHAT THE SCREEN MAY SAY:
 *
 *  1. `candidate_count` IS THE TOTAL ACROSS EVERY PAGE, not the page length
 *     (scan.go:45-47 says so explicitly, and the UPDATE at :272-276 computes
 *     it with a `count(*)` over the whole manifest). So zero really is a
 *     truthful workspace-wide "no duplicates" — the one number on this surface
 *     that may be stated without a denominator.
 *  2. THE MANIFEST IS DELIBERATELY NOT FUZZY. `materializeScanPairsSQL`
 *     (scan.go:403-556) contains only deterministic equality joins over
 *     normalised keys; the historical edit-distance rule was removed because a
 *     sampled heuristic "can never support a truthful 'no duplicates' state or
 *     a destructive merge decision" (package doc, subscriber_dedupe.go:5-8).
 *     Every pair therefore has a REASON, and the UI shows it.
 *  3. `primary_id` IS A SUGGESTION, NOT A VERDICT. Each key cluster picks its
 *     OLDEST row as the suggested primary (`first_value(...) OVER (... ORDER BY
 *     subscriber_created_at, subscriber_id)`, scan.go:416). The merge endpoint
 *     accepts either direction (merge/apply.go:286-295), so the survivor is the
 *     operator's decision and the screen must not present it as the server's.
 *  4. `stale` IS COMPUTED AT READ TIME, not at scan time (scan.go:338-342): it
 *     turns true when either row was edited, disappeared, or already carries a
 *     `merged_into` marker since the manifest was frozen. A stale pair can only
 *     ever answer 409 from the merge route, so it is not offerable.
 *
 * DELIBERATELY FREE OF REACT-NATIVE IMPORTS so it runs under the node vitest
 * environment. `lib/format` is itself import-free and is the app's only
 * formatting vocabulary, so the verdict below groups its figures the same way
 * the card beside it does — a "4,210" in one line and a "4210" in the next is
 * exactly the texture `format.consistency` exists to prevent.
 */
import { num, plural } from "@/lib/format";

/** One deterministic, server-evaluated reason two rows were surfaced. */
export interface DuplicateEvidence {
  kind: string;
  /** 0..1 as the server sent it, or null when it was absent/unparseable. */
  confidence: number | null;
  reason: string;
}

export interface DuplicateScan {
  id: string;
  status: string;
  /** Absent measurements stay null — never 0. */
  subscriberCount: number | null;
  candidateCount: number | null;
  createdAt: string;
  completedAt: string;
  expiresAt: string;
  complete: boolean;
}

export interface DuplicatePair {
  primaryId: string;
  primaryEmail: string;
  duplicateId: string;
  duplicateEmail: string;
  /** RFC3339 instants the merge route binds its precondition to. */
  primaryUpdatedAt: string;
  duplicateUpdatedAt: string;
  kind: string;
  confidence: number | null;
  evidence: DuplicateEvidence[];
  stale: boolean;
}

export interface DuplicateScanPage {
  scan: DuplicateScan | null;
  pairs: DuplicatePair[];
  /** `scan.candidate_count` echoed at the page level. */
  count: number | null;
  /** "" when the manifest has been walked to the end. */
  nextCursor: string;
  complete: boolean;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** A count the server did not send is UNKNOWN, which is not zero. */
function intOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.trunc(value)
    : null;
}

function unitInterval(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (value < 0 || value > 1) return null;
  return value;
}

/**
 * Short human labels for the seven deterministic rules in
 * `materializeScanPairsSQL` (scan.go:491-519).
 *
 * An UNRECOGNISED kind is kept verbatim rather than mapped to "Other": a new
 * server rule shipping before the app updates must still name itself, and the
 * long `reason` string beside it is authored server-side anyway.
 */
const EVIDENCE_LABELS: Record<string, string> = {
  case_diff: "Same address, different case",
  plus_alias: "Plus-address alias",
  dot_alias: "Gmail dot alias",
  domain_substitution: "Provider-equivalent domain",
  homoglyph: "Look-alike characters",
  phone_collision: "Same phone number",
  external_id_collision: "Same upstream profile id",
};

export function evidenceLabel(kind: string): string {
  const key = str(kind);
  if (!key) return "Unlabelled match";
  return EVIDENCE_LABELS[key] ?? key;
}

export function normalizeDuplicateEvidence(raw: unknown): DuplicateEvidence[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry) => {
      const row = record(entry);
      return {
        kind: str(row.kind),
        confidence: unitInterval(row.confidence),
        reason: str(row.reason),
      };
    })
    .filter((entry) => entry.kind !== "" || entry.reason !== "");
}

export function normalizeDuplicateScan(raw: unknown): DuplicateScan | null {
  const row = record(raw);
  const id = str(row.scan_id) || str(row.id);
  if (!id) return null;
  const status = str(row.status);
  return {
    id,
    status,
    subscriberCount: intOrNull(row.subscriber_count),
    candidateCount: intOrNull(row.candidate_count),
    createdAt: str(row.created_at),
    completedAt: str(row.completed_at),
    expiresAt: str(row.expires_at),
    // The server sends `complete` (scan.go:56) AND derives it from status
    // (scan.go:291). Trust the explicit flag, fall back to the status word.
    complete: row.complete === true || status === "complete",
  };
}

export function normalizeDuplicatePairs(raw: unknown): DuplicatePair[] {
  if (!Array.isArray(raw)) return [];
  const out: DuplicatePair[] = [];
  for (const entry of raw) {
    const row = record(entry);
    const primaryId = str(row.primary_id);
    const duplicateId = str(row.duplicate_id);
    // A pair without both ids cannot be reviewed OR merged; dropping it is
    // honest, rendering half a row is not.
    if (!primaryId || !duplicateId || primaryId === duplicateId) continue;
    const evidence = normalizeDuplicateEvidence(row.evidence);
    out.push({
      primaryId,
      primaryEmail: str(row.primary_email),
      duplicateId,
      duplicateEmail: str(row.duplicate_email),
      primaryUpdatedAt: str(row.primary_updated_at),
      duplicateUpdatedAt: str(row.duplicate_updated_at),
      // `Kind` is the server's own "first evidence wins" pick (scan.go:376);
      // re-derive it when the field is missing rather than showing nothing.
      kind: str(row.kind) || (evidence[0]?.kind ?? ""),
      confidence: unitInterval(row.confidence),
      evidence,
      stale: row.stale === true,
    });
  }
  return out;
}

export function normalizeDuplicateScanPage(raw: unknown): DuplicateScanPage {
  const row = record(raw);
  const scan = normalizeDuplicateScan(row.scan);
  return {
    scan,
    pairs: normalizeDuplicatePairs(row.pairs),
    count: intOrNull(row.count) ?? scan?.candidateCount ?? null,
    nextCursor: str(row.next_cursor),
    complete: row.complete === true || scan?.complete === true,
  };
}

/** Stable identity for a pair — the same key the merge route locks on. */
export function pairKey(pair: {
  primaryId: string;
  duplicateId: string;
}): string {
  return `${pair.primaryId}:${pair.duplicateId}`;
}

/**
 * Append a page while keeping first-seen order and dropping repeats.
 *
 * The cursor is an ordinal (`pairs.ordinal > $3`, scan.go:349) so the server
 * cannot legitimately repeat a row — but a retried page or a re-mounted list
 * can, and a duplicate key in a `<FlatList>`/`map` is a silent render bug that
 * only shows up as a missing row.
 */
export function mergePairPages(
  pages: readonly (readonly DuplicatePair[])[],
): DuplicatePair[] {
  const seen = new Set<string>();
  const out: DuplicatePair[] = [];
  for (const page of pages) {
    for (const pair of page) {
      const key = pairKey(pair);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(pair);
    }
  }
  return out;
}

/**
 * Why a pair cannot be merged right now, or "" when it can.
 *
 * Only two answers are possible before a request is made, and both are facts
 * the server already told us — never a guess.
 */
export function pairBlockedReason(pair: DuplicatePair): string {
  if (pair.stale) {
    return "One of these records changed after the scan ran, so the server will refuse this merge. Re-run the scan to review it against current data.";
  }
  if (!pair.primaryUpdatedAt || !pair.duplicateUpdatedAt) {
    return "The scan did not record a version for both records, so this pair cannot be merged safely. Re-run the scan.";
  }
  return "";
}

/**
 * Why this pair cannot be merged right now, INCLUDING the scan-level reason.
 *
 * An expired manifest fails `scan.expires_at > now()` inside the apply
 * transaction (apply.go:276) and comes back 409 `candidate_stale` — so every
 * pair under it is unmergeable even though none of them is individually stale.
 * Pre-empting that is the same rule as the per-pair case: do not offer a
 * control whose only possible answer is a refusal.
 */
export function reviewBlockedReason(
  pair: DuplicatePair,
  scanExpired: boolean,
): string {
  if (scanExpired) {
    return "This scan has expired, so the server will refuse every merge against it. Pull to refresh to scan again.";
  }
  return pairBlockedReason(pair);
}

/**
 * The one-line verdict above the queue.
 *
 * `candidateCount` is workspace-wide, so this is the rare place the app may
 * state a total instead of a sample. An unknown count says so.
 */
export function duplicateScanVerdict(scan: DuplicateScan | null): string {
  if (!scan) return "No scan has run yet.";
  if (!scan.complete) {
    return "This scan is still being materialized. Pull to refresh once it finishes.";
  }
  const candidates = scan.candidateCount;
  const people = scan.subscriberCount;
  const over =
    people === null ? "" : ` across ${plural(people, "person", "people")}`;
  if (candidates === null) {
    return `This scan finished but did not report a candidate total${over}.`;
  }
  if (candidates === 0) {
    return `No duplicate candidates${over}. This is the whole workspace, not a sample.`;
  }
  return `${num(candidates)} candidate ${candidates === 1 ? "pair" : "pairs"}${over}. Every pair is listed — this is not a sample.`;
}

/**
 * Whether the frozen manifest has aged out. `loadScan` refuses an expired scan
 * with 410 (scan.go:311-313) and `merge/apply` requires `expires_at > now()`
 * (apply.go:276), so an expired scan on screen is a dead queue.
 */
export function scanIsExpired(
  scan: DuplicateScan | null,
  nowMs: number,
): boolean {
  if (!scan || !scan.expiresAt) return false;
  const expiry = Date.parse(scan.expiresAt);
  return Number.isFinite(expiry) && expiry <= nowMs;
}

/**
 * How many of the loaded pairs are already unmergeable.
 *
 * Reported with its denominator by the caller — this counts the rows the
 * device has, which is not necessarily every row in the manifest.
 */
export function staleLoadedCount(pairs: readonly DuplicatePair[]): number {
  return pairs.filter((pair) => pair.stale).length;
}
