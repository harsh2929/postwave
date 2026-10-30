/**
 * lib/emailHealthRollup.ts — the pure half of a bulk email-health read.
 *
 * The batch endpoint answers per ADDRESS; the question a person asks over a
 * list of members is per LIST — "how much of this roster should I not be
 * mailing". That summary is arithmetic, not rendering, so it lives here where
 * mobile's node vitest can exercise it.
 *
 * TWO SERVER CONSTRAINTS SHAPE THIS FILE:
 *
 *  - MaxBatch is 1000 (apps/api/internal/verification/verification.go), and
 *    the handler answers 413 above it. So the caller chunks.
 *  - api/emailHealth's batch validator asserts
 *    `total + duplicates === emails.length` and rejects any result outside the
 *    set it asked for. Chunking a list that still contains duplicates would
 *    make two chunks each claim the same address, so the addresses are
 *    normalized and de-duplicated BEFORE they are cut up — which also means
 *    `duplicates` comes back 0 and the arithmetic holds per chunk.
 *
 * TYPE-ONLY IMPORTS, and that is load-bearing rather than stylistic:
 * `@/api/emailHealth` reaches the SDK and therefore react-native, so a VALUE
 * imported from it (EMAIL_HEALTH_GRADES, say) would put this module out of
 * reach of mobile's node vitest entirely. The zeroed summary below is an
 * object LITERAL typed as `Record<EmailHealthGrade, number>`, so the compiler
 * still refuses it if a grade is ever added and missed here.
 */
import type { EmailHealth, EmailHealthGrade } from "@/api/emailHealth";

/** apps/api/internal/verification/verification.go: `const MaxBatch = 1000`. */
export const EMAIL_HEALTH_MAX_BATCH = 1000;

/**
 * The addresses actually worth asking about, in first-seen order.
 *
 * Normalized the same way the server does (trim + lowercase), so a roster
 * holding "Ada@Example.com" and "ada@example.com" costs one lookup rather than
 * two — and, more importantly, cannot land in two different chunks and break
 * the batch client's own duplicate check.
 */
export function normalizeHealthAddresses(
  emails: readonly (string | null | undefined)[],
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of emails) {
    const email = (raw ?? "").trim().toLowerCase();
    // The server's own floor: 3..320 characters. Anything shorter is not an
    // address at all and would fail the whole chunk with a 422 rather than
    // coming back graded.
    if (email.length < 3 || email.length > 320) continue;
    if (seen.has(email)) continue;
    seen.add(email);
    out.push(email);
  }
  return out;
}

/** Cut a normalized list into requests the handler will accept. */
export function chunkHealthAddresses(
  emails: readonly string[],
  size: number = EMAIL_HEALTH_MAX_BATCH,
): string[][] {
  const limit = Math.max(1, Math.min(size, EMAIL_HEALTH_MAX_BATCH));
  const out: string[][] = [];
  for (let i = 0; i < emails.length; i += limit) {
    out.push(emails.slice(i, i + limit));
  }
  return out;
}

export interface EmailHealthRollup {
  /** How many addresses were graded. */
  total: number;
  /** Count per grade, every grade present — a missing key reads as unknown. */
  summary: Record<EmailHealthGrade, number>;
  /** Addresses the server says must not be mailed. */
  doNotSend: number;
  /** Addresses carrying a hard stop — consent or suppression. */
  hardStop: number;
  /**
   * Addresses whose evidence the server could not fully assemble.
   *
   * Carried separately and never folded into a grade: `evidence_complete:
   * false` means the grade is provisional, and a rollup that hid it would
   * present a partial answer as a measurement.
   */
  incompleteEvidence: number;
}

/** Every grade at zero. Exhaustiveness is enforced by the return type. */
function zeroSummary(): Record<EmailHealthGrade, number> {
  return { A: 0, B: 0, C: 0, D: 0, F: 0, U: 0 };
}

export const EMPTY_HEALTH_ROLLUP: EmailHealthRollup = {
  total: 0,
  summary: zeroSummary(),
  doNotSend: 0,
  hardStop: 0,
  incompleteEvidence: 0,
};

/** Roll a set of per-address results (possibly from several chunks) into one. */
export function rollupEmailHealth(
  results: readonly EmailHealth[],
): EmailHealthRollup {
  const summary = zeroSummary();
  let doNotSend = 0;
  let hardStop = 0;
  let incompleteEvidence = 0;
  for (const row of results) {
    summary[row.grade] = (summary[row.grade] ?? 0) + 1;
    if (row.recommendation === "do_not_send" || row.recommendation === "blocked") {
      doNotSend += 1;
    }
    if (row.hard_stop) hardStop += 1;
    if (!row.evidence_complete) incompleteEvidence += 1;
  }
  return {
    total: results.length,
    summary,
    doNotSend,
    hardStop,
    incompleteEvidence,
  };
}

/**
 * The one sentence the card leads with.
 *
 * Deliberately does NOT say "your list is healthy" when nothing is wrong: the
 * only thing measured is the addresses that were checked, and a roster where
 * every loaded member is fine says exactly that and no more.
 */
export function healthRollupHeadline(rollup: EmailHealthRollup): string {
  if (rollup.total === 0) return "No addresses were checked.";
  const noun = rollup.total === 1 ? "address" : "addresses";
  if (rollup.doNotSend === 0) {
    return `${rollup.total} ${noun} checked — none is flagged do-not-send.`;
  }
  const flagged = rollup.doNotSend === 1 ? "1 is" : `${rollup.doNotSend} are`;
  return `${rollup.total} ${noun} checked — ${flagged} flagged do-not-send.`;
}
