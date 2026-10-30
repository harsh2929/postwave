/**
 * lib/verificationJobDetail.ts — one verification job, opened.
 *
 * The jobs panel answers "is something spending credits right now, and can I
 * stop it". It cannot answer the two questions that come immediately after:
 * where is the money actually going, and WHICH addresses came back bad. Those
 * are GET /verification/jobs/{id} and /{id}/results — both viewer reads that
 * had no mobile client at all.
 *
 * Two things this file refuses to do:
 *
 *  - INVENT A SPEND. `credits_spent` and `credits_saved` are computed
 *    server-side from the job row; nothing here recomputes them from processed
 *    counts, because a derived-looking number that disagrees with the invoice
 *    is worse than no number.
 *  - CALL AN UNFINISHED JOB CLEAN. A running job's per-status summary counts
 *    only what has been PROCESSED so far, so every sentence built here says so
 *    while the job is live.
 *
 * Import-free of react-native, so it is node-tested.
 */

import { WireShapeError } from "./deliverabilityContracts";

/** The canonical verdict vocabulary (apps/api/internal/verification AllStatuses). */
export const VERIFICATION_STATUSES = [
  "valid",
  "invalid",
  "catch_all",
  "spamtrap",
  "abuse",
  "do_not_mail",
  "unknown",
] as const;

export type VerificationResultStatus = (typeof VERIFICATION_STATUSES)[number];

/**
 * The verdicts Status.Sendable() rejects — the server's own split, not a
 * mobile opinion. catch_all and unknown are deliberately NOT here: excluding
 * every catch-all domain would drop most B2B lists wholesale.
 */
export const VERIFICATION_UNSENDABLE_STATUSES: readonly VerificationResultStatus[] =
  ["invalid", "spamtrap", "abuse", "do_not_mail"];

export interface VerificationJobDetailJob {
  id: string;
  status: string;
  source: string;
  executionMode: string;
  provider: string;
  total: number;
  processed: number;
  cacheHits: number;
  localFiltered: number;
  vendorVerified: number;
  duplicates: number;
  ambiguous: number;
  failureCode: string;
  /** Server-sanitised failure sentence; the raw error never leaves the API. */
  error: string;
  createdAt: string;
  startedAt: string;
  completedAt: string;
}

export interface VerificationJobDetail {
  job: VerificationJobDetailJob;
  /** status -> count, over PROCESSED items only. */
  summary: Record<string, number>;
  creditsSpent: number;
  creditsSaved: number;
  isTerminal: boolean;
}

export interface VerificationJobResultItem {
  email: string;
  processed: boolean;
  status: string;
  subStatus: string;
  score: number | null;
  provider: string;
  billable: boolean;
  cached: boolean;
  didYouMean: string;
  checkedAt: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function count(value: unknown, label: string): number {
  if (value === undefined || value === null) return 0;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new WireShapeError(label);
  }
  return value;
}

export function parseVerificationJobDetail(
  payload: unknown,
): VerificationJobDetail {
  const label = "verification job detail";
  if (!isRecord(payload) || !isRecord(payload.job)) {
    throw new WireShapeError(label);
  }
  const raw = payload.job;
  const id = text(raw.id).trim();
  if (!id) throw new WireShapeError(label);

  const summary: Record<string, number> = {};
  if (payload.summary !== undefined && payload.summary !== null) {
    if (!isRecord(payload.summary)) throw new WireShapeError(label);
    for (const [status, value] of Object.entries(payload.summary)) {
      summary[status] = count(value, label);
    }
  }

  return {
    job: {
      id,
      status: text(raw.status).trim().toLowerCase(),
      source: text(raw.source),
      executionMode: text(raw.execution_mode),
      provider: text(raw.provider),
      total: count(raw.total, label),
      processed: count(raw.processed, label),
      cacheHits: count(raw.cache_hits, label),
      localFiltered: count(raw.local_filtered, label),
      vendorVerified: count(raw.vendor_verified, label),
      duplicates: count(raw.duplicates, label),
      ambiguous: count(raw.ambiguous, label),
      failureCode: text(raw.failure_code),
      error: text(raw.error),
      createdAt: text(raw.created_at),
      startedAt: text(raw.started_at),
      completedAt: text(raw.completed_at),
    },
    summary,
    creditsSpent: count(payload.credits_spent, label),
    creditsSaved: count(payload.credits_saved, label),
    isTerminal: payload.is_terminal === true,
  };
}

export function parseVerificationJobResults(
  payload: unknown,
): VerificationJobResultItem[] {
  const label = "verification job results";
  if (!isRecord(payload)) throw new WireShapeError(label);
  const raw = payload.results;
  if (raw !== undefined && raw !== null && !Array.isArray(raw)) {
    throw new WireShapeError(label);
  }
  // Array.isArray, not `?? []` -- a truthy non-array would reach .map.
  const rows = Array.isArray(raw) ? raw : [];
  return rows.map((entry) => {
    if (!isRecord(entry)) throw new WireShapeError(label);
    const score = entry.score;
    if (
      score !== undefined &&
      score !== null &&
      (typeof score !== "number" || !Number.isFinite(score))
    ) {
      throw new WireShapeError(label);
    }
    return {
      email: text(entry.email),
      processed: entry.processed === true,
      status: text(entry.status).trim().toLowerCase(),
      subStatus: text(entry.sub_status),
      score: typeof score === "number" ? score : null,
      provider: text(entry.provider),
      billable: entry.billable === true,
      cached: entry.cached === true,
      didYouMean: text(entry.did_you_mean),
      checkedAt: text(entry.checked_at),
    };
  });
}

function grouped(value: number): string {
  const sign = value < 0 ? "-" : "";
  return (
    sign +
    Math.abs(Math.trunc(value))
      .toString()
      .replace(/\B(?=(\d{3})+(?!\d))/gu, ",")
  );
}

/** How far along, and how much of it was answered without paying. */
export function verificationJobProgressLine(
  detail: VerificationJobDetail,
): string {
  const { job } = detail;
  const head = `${grouped(job.processed)} of ${grouped(job.total)} addresses processed`;
  const tail = `${grouped(job.vendorVerified)} sent to the vendor · ${grouped(job.cacheHits)} already cached · ${grouped(job.localFiltered)} settled by the free local tier`;
  return detail.isTerminal ? `${head}. ${tail}.` : `${head} so far. ${tail}.`;
}

/** The money, taken verbatim from the server's own accounting. */
export function verificationJobSpendLine(
  detail: VerificationJobDetail,
): string {
  const spent = `${grouped(detail.creditsSpent)} credit${detail.creditsSpent === 1 ? "" : "s"} spent`;
  const saved = `${grouped(detail.creditsSaved)} saved by the cache and local tier`;
  return detail.isTerminal
    ? `${spent} · ${saved}.`
    : `${spent} so far · ${saved}. Remaining work can still spend credits.`;
}

/**
 * What state the job is in, said without softening a failure.
 *
 * The server's `error` is already reduced to an operator-safe sentence, so it
 * renders verbatim rather than being replaced with a mobile paraphrase.
 */
export function verificationJobOutcomeLine(
  detail: VerificationJobDetail,
): string {
  const { job } = detail;
  if (job.error) return job.error;
  if (job.status === "failed") {
    return "The verification run failed before it could complete.";
  }
  if (job.status === "canceled" || job.status === "cancelled") {
    return "Stopped before finishing. Credits already spent were not refunded.";
  }
  if (job.status === "completed") {
    return job.ambiguous > 0
      ? `Finished, with ${grouped(job.ambiguous)} address${job.ambiguous === 1 ? "" : "es"} whose provider outcome could not be confirmed.`
      : "Finished.";
  }
  return "Still running — the counts below cover only what has been processed so far.";
}

export interface VerificationStatusCount {
  status: string;
  count: number;
  /** True when this verdict is one Status.Sendable() rejects. */
  unsendable: boolean;
}

/**
 * The per-status summary, worst verdicts first.
 *
 * "Which addresses failed" is the question the drill-in exists for, so the
 * failing verdicts lead rather than being scrolled to.
 */
export function verificationJobStatusCounts(
  detail: VerificationJobDetail,
): VerificationStatusCount[] {
  const rows = Object.entries(detail.summary)
    .filter(([, value]) => value > 0)
    .map(([status, value]) => ({
      status,
      count: value,
      unsendable: (
        VERIFICATION_UNSENDABLE_STATUSES as readonly string[]
      ).includes(status),
    }));
  return rows.sort((a, b) => {
    if (a.unsendable !== b.unsendable) return a.unsendable ? -1 : 1;
    if (a.count !== b.count) return b.count - a.count;
    return a.status.localeCompare(b.status);
  });
}

/** One result row, said in the vendor's own vocabulary. */
export function verificationJobResultLine(
  item: VerificationJobResultItem,
): string {
  if (!item.processed) return "not checked yet";
  const parts = [item.status || "unknown"];
  if (item.subStatus) parts.push(item.subStatus.replace(/_/gu, " "));
  if (item.score !== null) parts.push(`score ${item.score}`);
  if (item.cached) parts.push("from cache");
  else if (item.billable) parts.push("vendor credit spent");
  if (item.didYouMean) parts.push(`did you mean ${item.didYouMean}`);
  return parts.join(" · ");
}

/**
 * Paging over the per-address results.
 *
 * The server's own bounds: `JobResults` clamps a limit of <= 0 or > 1000 back
 * to 100, so asking for more than 1000 would SHRINK the page instead of
 * growing it. The rows are `ORDER BY id`, which is stable, so growing one
 * query's limit is a safe way to page on a phone — no cursor to drift, and
 * no partially-appended list if a refetch lands out of order.
 */
export const VERIFICATION_RESULTS_PAGE_SIZE = 50;
export const VERIFICATION_RESULTS_MAX = 1000;

export function nextVerificationResultsLimit(current: number): number {
  const next = current + VERIFICATION_RESULTS_PAGE_SIZE;
  return next > VERIFICATION_RESULTS_MAX ? VERIFICATION_RESULTS_MAX : next;
}

/**
 * How many rows the current scope HAS, from the server's own summary — never
 * from the length of the page in hand.
 *
 * The failures total is the sum of the unsendable verdicts; the unfiltered
 * total is what the job has processed. Both are counts the server computed.
 */
export function verificationJobResultsTotal(
  detail: VerificationJobDetail,
  failuresOnly: boolean,
): number {
  if (!failuresOnly) return detail.job.processed;
  return verificationJobStatusCounts(detail)
    .filter((entry) => entry.unsendable)
    .reduce((sum, entry) => sum + entry.count, 0);
}

/**
 * "You are not seeing all of them", when that is true — and nothing when it
 * is not.
 *
 * A truncated failure list with no sentence under it is the same lie as an
 * empty one on an unfinished run: it reads as the complete answer to "which
 * addresses failed". The count comes from the server's summary, so it stays
 * right even though the page is capped.
 */
export function verificationJobResultsPageLine(input: {
  detail: VerificationJobDetail;
  shown: number;
  failuresOnly: boolean;
}): string {
  const total = verificationJobResultsTotal(input.detail, input.failuresOnly);
  if (input.shown === 0 || total <= input.shown) return "";
  const noun = input.failuresOnly
    ? "unsendable addresses"
    : "processed addresses";
  const head = `Showing ${grouped(input.shown)} of ${grouped(total)} ${noun}`;
  return input.shown >= VERIFICATION_RESULTS_MAX
    ? `${head}. This is as far as a phone pages; the rest are on the desktop app.`
    : `${head}.`;
}

/**
 * The empty-results sentence.
 *
 * A failures-only page with nothing on it must not read as "this list is
 * clean" while the job is still working through it.
 */
export function verificationJobResultsEmptyLine(
  detail: VerificationJobDetail,
  failuresOnly: boolean,
): string {
  if (!failuresOnly) {
    return detail.job.processed === 0
      ? "No addresses have been processed yet."
      : "No results on this page.";
  }
  return detail.isTerminal
    ? "No unsendable addresses were found in this run."
    : "No unsendable addresses among the ones processed so far — this run is not finished.";
}
