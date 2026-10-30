/**
 * approvalArrivals — the queue's "N new" affordance (GOVERNANCE#29).
 *
 * ── THE HAZARD ─────────────────────────────────────────────────────────────
 * The list screen polls at `APPROVALS_LIST_POLL_MS` (60s) and the list is
 * newest-first, so a request submitted while you are reading is PREPENDED: the
 * row under your thumb slides down one position and the thing you were about to
 * approve is replaced by something you have never read. Approvals is the one
 * screen in the app where a mis-tap is unrecoverable — the decision is
 * irreversible, audit-logged, and swipe-approve deliberately skips the confirm
 * because the gesture is meant to be the deliberate act.
 *
 * ── THE ANSWER, AND WHY IT MATCHES lib/auditTail ───────────────────────────
 * The audit log already solved the identical problem the identical way: COUNT,
 * do not insert. Nothing enters the rendered list without a deliberate tap.
 * This module is the approvals shape of `lib/auditTail`, and deliberately reads
 * like it — same verb ("tap to load"), same "the reader decides when the list
 * moves" contract — because a phone that behaves one way on Audit and another
 * on Approvals has taught the operator nothing.
 *
 * The difference is the mechanism: audit needs a separate bounded probe because
 * its list is an infinite query. Approvals already refetches the WHOLE capped
 * page, so there is nothing extra to fetch. The arithmetic is a set difference
 * against what is already on screen — zero additional requests.
 *
 * ── WHAT IS HELD AND WHAT IS NOT ───────────────────────────────────────────
 * Only ARRIVALS are held.
 *
 *  - UPDATES to a row already on screen pass straight through. Holding them
 *    would freeze a status the server has already changed, and a stale
 *    "pending" badge is exactly what walks an approver into a 409.
 *  - REMOVALS pass through too. A request decided by a teammate must LEAVE the
 *    queue: keeping a phantom row so the list does not shift would offer a
 *    decision the server can only refuse, which is a worse outcome than the
 *    shift. (It also shifts rows UP, away from the thumb, rather than sliding
 *    unread content under it.)
 *
 * Import-free of react-native/expo, so every rule above is unit-tested under
 * node.
 */

export interface ApprovalArrivals<T> {
  /** The rows to render, in the incoming order, minus anything withheld. */
  rows: T[];
  /** How many arrivals are being held back behind the pill. */
  newCount: number;
  /**
   * The hold was overridden because applying it would have emptied the list.
   * The caller must re-seed its hold set from these rows — see the rule in
   * `withheldApprovals`.
   */
  autoAdopted: boolean;
}

/**
 * Split an incoming page into "already on screen" and "arrived since".
 *
 * `displayedIds === null` means NOT HOLDING — the first load, or the moment
 * just after the reader adopted the new rows. Everything is rendered and the
 * count is 0. That null is load-bearing: an empty ARRAY would mean "nothing was
 * on screen", which would report an entire first page as new and put a "100
 * new" pill above a list the reader has not seen yet.
 *
 * THE HOLD NEVER EMPTIES THE QUEUE. If every row on screen has gone (a
 * teammate cleared the queue) and arrivals have replaced them, there is no
 * reading position left to protect — and a held list would render "You're
 * caught up" over requests that demonstrably exist, which is the worst
 * sentence this screen can produce. In that case the arrivals are adopted and
 * `autoAdopted` tells the caller to re-seed its hold set, so the protection
 * resumes from the page the reader is now looking at.
 */
export function withheldApprovals<T extends { id: string }>(
  incoming: readonly T[] | undefined,
  displayedIds: readonly string[] | null,
): ApprovalArrivals<T> {
  const rows = incoming ?? [];
  if (displayedIds === null) {
    return { rows: [...rows], newCount: 0, autoAdopted: false };
  }
  const seen = new Set(displayedIds);
  const kept: T[] = [];
  let newCount = 0;
  for (const row of rows) {
    if (seen.has(row.id)) kept.push(row);
    else newCount += 1;
  }
  if (kept.length === 0 && newCount > 0) {
    return { rows: [...rows], newCount: 0, autoAdopted: true };
  }
  return { rows: kept, newCount, autoAdopted: false };
}

/** The ids to hold against once the reader has seen this page. */
export function displayedApprovalIds<T extends { id: string }>(
  rows: readonly T[],
): string[] {
  return rows.map((row) => row.id);
}

/**
 * The pill's copy, or null when there is nothing to announce.
 *
 * "request(s)" rather than "approval(s)": the rows are things ASKING to be
 * approved, and "3 new approvals" reads as three decisions already made — the
 * opposite of what arrived.
 */
export function approvalArrivalLabel(count: number): string | null {
  if (count <= 0) return null;
  const noun = count === 1 ? "new request" : "new requests";
  return `${count} ${noun} — tap to load`;
}

/**
 * The spoken form. A VoiceOver user gets the whole sentence including what
 * happens on activation, not a bare number they have to interpret — the same
 * treatment AuditTailBanner gives its counter.
 */
export function approvalArrivalSpokenLabel(count: number): string {
  const noun = count === 1 ? "request" : "requests";
  return `${count} new approval ${noun} arrived. Double tap to load them.`;
}
