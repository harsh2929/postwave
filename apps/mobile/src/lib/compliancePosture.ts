/**
 * lib/compliancePosture.ts — "is anything about to lapse", answered without
 * inventing a date nobody recorded.
 *
 * THE ONE QUESTION THIS SURFACE EXISTS FOR. Attesting to a framework is a desk
 * job: it wants the auditor's report open, the document hash to hand and a
 * deliberate signature. Noticing that the SOC 2 attestation runs out in nine
 * days is not — it is a glance, and the cost of missing it is measured in the
 * weeks between the lapse and somebody looking. So every judgement here is
 * about EXPIRY, and none of it is about authoring.
 *
 * FOUR WAYS TO LIE ABOUT AN EXPIRY, AND WHAT THIS MODULE DOES INSTEAD:
 *
 *  1. TREAT A MISSING RENEWAL DATE AS EXPIRED. `renewal_at` is nullable
 *     (migration 0193 line 35) and three of the seven supported frameworks —
 *     GDPR, CAN-SPAM, CASL — are standing obligations with no renewal at all.
 *     A null there means "no renewal date recorded", which is `open_ended`,
 *     and it is never counted as due or lapsed.
 *
 *  2. DERIVE A DATE FROM THE CADENCE. The catalogue knows SOC 2 is normally
 *     annual. That is what the FRAMEWORK says; `renewal_at` is what this
 *     WORKSPACE recorded, and only the second one is a fact about this tenant.
 *     The cadence is used for exactly one thing: noticing that a framework
 *     which normally expires has no expiry date on file (`renewal_unset`),
 *     which is a gap worth naming and is not the same as `open_ended`.
 *
 *  3. COUNT HIPAA. The server returns it as `status: "unsupported"` with a
 *     fixed reason and never stores a row (compliance.go:161-164, :493-499).
 *     Putting it in the denominator of "3 of 8 attested" would permanently
 *     cap the workspace at 7/8 for a framework the product refuses to
 *     support. It is excluded from every count and shown last.
 *
 *  4. READ `in_progress` AS PROGRESS. It is synthesized for a framework with
 *     no row at all — see the note in `lib/compliancePrograms`. It is
 *     `no_record` here, and the copy says "no attestation record", never
 *     "in progress".
 *
 * ROUNDING IS CONSERVATIVE IN BOTH DIRECTIONS. `daysUntilRenewal` is a
 * FLOOR of the signed day delta, so 8.5 days left reads as 8 (never round a
 * deadline up towards yourself) and 5.5 days overdue reads as 6 days overdue
 * (never round a lapse down). `now` is always injected so this is testable.
 *
 * DELIBERATELY IMPORT-FREE apart from the two pure sibling modules.
 */
import {
  HIPAA_SLUG,
  metaForFramework,
  type ComplianceFrameworkMeta,
} from "@/lib/complianceFrameworks";
import {
  programCatalogueIndex,
  type ComplianceProgram,
} from "@/lib/compliancePrograms";

/** How far ahead counts as "renewing soon". Weeks, per the domain. */
export const RENEWAL_DUE_SOON_DAYS = 30;

const DAY_MS = 86_400_000;

export type PostureState =
  /** The product refuses this framework. Never counted. */
  | "unsupported"
  /** Attested, and its own renewal date has passed. */
  | "lapsed"
  /** Attested, renewing within RENEWAL_DUE_SOON_DAYS (today included). */
  | "due_soon"
  /** Attested, but a framework that normally expires has no expiry on file. */
  | "renewal_unset"
  /** Attested, and the framework has no renewal by nature. */
  | "open_ended"
  /** Attested, renewal comfortably ahead. */
  | "current"
  /** An attestation was explicitly withdrawn. */
  | "revoked"
  /** No attestation record came back for this framework. */
  | "no_record"
  /** A status this client does not model. Shown, never guessed at. */
  | "unknown";

/** A subset of PillTone. Kept as a local union so this module stays pure. */
export type PostureTone = "neutral" | "success" | "warning" | "danger" | "info";

export interface ProgramPosture {
  program: ComplianceProgram;
  meta: ComplianceFrameworkMeta;
  state: PostureState;
  /**
   * Signed whole days until `renewalAt`, floored. Negative when overdue.
   * `null` when no renewal date was recorded OR it did not parse — the two
   * are the same fact to a reader: there is no usable date.
   */
  daysUntilRenewal: number | null;
  /** True when the record says attested, whatever its renewal state. */
  attested: boolean;
}

export interface CompliancePosture {
  /** Every program, urgency first. HIPAA always last. */
  rows: readonly ProgramPosture[];
  /** Frameworks the product supports — the denominator for everything. */
  tracked: number;
  /** How many of those the record calls attested, lapsed ones included. */
  attested: number;
  lapsed: number;
  dueSoon: number;
  renewalUnset: number;
  openEnded: number;
  current: number;
  revoked: number;
  noRecord: number;
  unknown: number;
  /** Excluded from every count above. Always 1 today (HIPAA). */
  unsupported: number;
}

/** Signed whole days from `now` to an ISO stamp, floored. */
export function daysUntil(iso: string, now: number): number | null {
  if (!iso) return null;
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return null;
  return Math.floor((at - now) / DAY_MS);
}

function attestedState(
  days: number | null,
  meta: ComplianceFrameworkMeta,
): PostureState {
  if (days === null) {
    return meta.renewalCadenceMonths === null ? "open_ended" : "renewal_unset";
  }
  if (days < 0) return "lapsed";
  if (days <= RENEWAL_DUE_SOON_DAYS) return "due_soon";
  return "current";
}

export function programPosture(
  program: ComplianceProgram,
  now: number,
): ProgramPosture {
  const meta = metaForFramework(program.framework);
  const days = daysUntil(program.renewalAt, now);
  const attested = program.status === "attested";
  let state: PostureState;
  if (program.framework === HIPAA_SLUG || program.status === "unsupported") {
    state = "unsupported";
  } else if (attested) {
    state = attestedState(days, meta);
  } else if (program.status === "revoked") {
    state = "revoked";
  } else if (program.status === "in_progress") {
    state = "no_record";
  } else {
    state = "unknown";
  }
  return { program, meta, state, daysUntilRenewal: days, attested };
}

/**
 * Urgency order. Everything the reader might have to act on comes before
 * everything that is fine, and the framework the product refuses is last so it
 * never occupies the top of a phone screen.
 */
const STATE_RANK: Readonly<Record<PostureState, number>> = {
  lapsed: 0,
  due_soon: 1,
  renewal_unset: 2,
  revoked: 3,
  no_record: 4,
  unknown: 5,
  open_ended: 6,
  current: 7,
  unsupported: 8,
};

export function comparePostureUrgency(
  a: ProgramPosture,
  b: ProgramPosture,
): number {
  const byState = STATE_RANK[a.state] - STATE_RANK[b.state];
  if (byState !== 0) return byState;
  // Within lapsed/due_soon the nearest date leads: the most overdue first,
  // then the soonest to expire. Rows without a date keep catalogue order.
  if (a.daysUntilRenewal !== null && b.daysUntilRenewal !== null) {
    const byDate = a.daysUntilRenewal - b.daysUntilRenewal;
    if (byDate !== 0) return byDate;
  }
  return (
    programCatalogueIndex(a.program) - programCatalogueIndex(b.program)
  );
}

export function compliancePosture(
  programs: readonly ComplianceProgram[],
  now: number,
): CompliancePosture {
  const rows = programs
    .map((program) => programPosture(program, now))
    .sort(comparePostureUrgency);
  const count = (state: PostureState) =>
    rows.filter((row) => row.state === state).length;
  const unsupported = count("unsupported");
  return {
    rows,
    tracked: rows.length - unsupported,
    attested: rows.filter((row) => row.attested).length,
    lapsed: count("lapsed"),
    dueSoon: count("due_soon"),
    renewalUnset: count("renewal_unset"),
    openEnded: count("open_ended"),
    current: count("current"),
    revoked: count("revoked"),
    noRecord: count("no_record"),
    unknown: count("unknown"),
    unsupported,
  };
}

/**
 * The headline.
 *
 * Every branch names its denominator, and the branch order is the order a
 * compliance owner would want to be told things: what has already lapsed, then
 * what is about to, then what was never recorded, then the good news.
 *
 * The all-clear is stated positively rather than as "0 lapsed" — a zero beside
 * the word "lapsed" reads as a measurement of failure, and this one is a
 * measurement of success.
 */
export function postureHeadline(posture: CompliancePosture): string {
  if (posture.tracked === 0) {
    return "No supported framework came back for this workspace.";
  }
  const of = `of ${posture.tracked} tracked framework${posture.tracked === 1 ? "" : "s"}`;
  if (posture.lapsed > 0) {
    return `${posture.lapsed} ${of} ${posture.lapsed === 1 ? "is" : "are"} past ${posture.lapsed === 1 ? "its" : "their"} own renewal date.`;
  }
  if (posture.dueSoon > 0) {
    return `${posture.dueSoon} ${of} renew${posture.dueSoon === 1 ? "s" : ""} within ${RENEWAL_DUE_SOON_DAYS} days.`;
  }
  if (posture.attested === 0) {
    return `No attestation record came back for any of the ${posture.tracked} tracked framework${posture.tracked === 1 ? "" : "s"}.`;
  }
  if (posture.attested < posture.tracked) {
    return `${posture.attested} ${of} ${posture.attested === 1 ? "has" : "have"} an attestation on file.`;
  }
  return `All ${posture.tracked} tracked framework${posture.tracked === 1 ? " has" : "s have"} an attestation on file, and none renews within ${RENEWAL_DUE_SOON_DAYS} days.`;
}

/**
 * The qualifier under the headline: what the numbers were computed over, and
 * every category the headline did not mention. Nothing is silently dropped —
 * a framework with no expiry date on file is invisible in a "due soon" count
 * and would otherwise never be named.
 */
export function postureQualifier(posture: CompliancePosture): string {
  const parts: string[] = [];
  if (posture.renewalUnset > 0) {
    parts.push(
      `${posture.renewalUnset} attested framework${posture.renewalUnset === 1 ? "" : "s"} that normally renew${posture.renewalUnset === 1 ? "s" : ""} ${posture.renewalUnset === 1 ? "has" : "have"} no renewal date on file`,
    );
  }
  if (posture.openEnded > 0) {
    parts.push(
      `${posture.openEnded} ${posture.openEnded === 1 ? "is" : "are"} a standing obligation with no renewal`,
    );
  }
  if (posture.revoked > 0) {
    parts.push(
      `${posture.revoked} attestation${posture.revoked === 1 ? " was" : "s were"} withdrawn`,
    );
  }
  if (posture.noRecord > 0) {
    parts.push(
      `${posture.noRecord} ${posture.noRecord === 1 ? "has" : "have"} no attestation record`,
    );
  }
  if (posture.unknown > 0) {
    parts.push(
      `${posture.unknown} came back with a status this app does not recognise`,
    );
  }
  const tail =
    posture.unsupported > 0
      ? ` HIPAA is excluded from these counts — Moosewave offers no BAA, so it is not a framework you can attest to here.`
      : "";
  if (parts.length === 0) return `Counted across every supported framework.${tail}`;
  return `${parts.join("; ")}.${tail}`;
}
