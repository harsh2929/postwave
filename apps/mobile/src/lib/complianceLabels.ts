/**
 * lib/complianceLabels.ts — the words and tones the posture states are shown
 * with, kept pure so they can be node-tested and so two components can never
 * describe the same state differently.
 *
 * STATE IS NEVER COLOUR ALONE. Every state has a written label AND a tone, and
 * every row's spoken label leads with the same word the pill shows — so a
 * red-green colour-blind reader, a VoiceOver user and a sighted reader all get
 * the same verdict from the same row.
 *
 * "IN PROGRESS" IS NOT A LABEL HERE, ON PURPOSE. The server synthesizes
 * `status: "in_progress"` for a framework with no stored row at all
 * (compliance.go:168 — and the package's only INSERT hard-codes 'attested', so
 * nothing is ever stored as in_progress). Printing "In progress" would claim
 * somebody is working on it. "No record" claims only what is true: nothing came
 * back.
 *
 * DELIBERATELY IMPORT-FREE apart from the posture types.
 */
import type {
  PostureState,
  PostureTone,
  ProgramPosture,
} from "@/lib/compliancePosture";

const LABELS: Readonly<Record<PostureState, string>> = {
  lapsed: "Lapsed",
  due_soon: "Renews soon",
  renewal_unset: "No renewal date",
  open_ended: "No renewal needed",
  current: "Attested",
  revoked: "Withdrawn",
  no_record: "No record",
  unknown: "Unrecognised status",
  unsupported: "Not supported",
};

const TONES: Readonly<Record<PostureState, PostureTone>> = {
  lapsed: "danger",
  due_soon: "warning",
  renewal_unset: "warning",
  open_ended: "info",
  current: "success",
  revoked: "danger",
  no_record: "neutral",
  unknown: "warning",
  unsupported: "neutral",
};

export function postureStateLabel(state: PostureState): string {
  return LABELS[state];
}

export function postureStateTone(state: PostureState): PostureTone {
  return TONES[state];
}

/**
 * The one-line explanation under a row. It states the RECORD, not a guess:
 * where there is no date it says there is no date rather than implying one.
 */
export function postureStateExplanation(row: ProgramPosture): string {
  switch (row.state) {
    case "lapsed":
      return `The renewal date on this attestation has passed, ${overduePhrase(row.daysUntilRenewal)}. The attestation itself is still recorded as valid.`;
    case "due_soon":
      return `Renews ${remainingPhrase(row.daysUntilRenewal)}.`;
    case "renewal_unset":
      return `This framework normally renews every ${cadencePhrase(row.meta.renewalCadenceMonths)}, and no renewal date was recorded for it.`;
    case "open_ended":
      return "A standing obligation rather than a certificate — there is no renewal date to track.";
    case "current":
      return `Renews ${remainingPhrase(row.daysUntilRenewal)}.`;
    case "revoked":
      return "Somebody withdrew this attestation. The ledger below records who and when.";
    case "no_record":
      return "No attestation record came back for this framework. That is the same answer the server gives for a framework nobody has touched.";
    case "unknown":
      return `The server sent the status “${row.program.rawStatus || "(empty)"}”, which this app does not model. Open Compliance on the web admin.`;
    case "unsupported":
      return (
        row.program.notes ||
        "Moosewave does not offer a Business Associate Agreement and must not be used for Protected Health Information."
      );
  }
}

/** "in 8 days" / "today" / "in 1 day". Never negative. */
export function remainingPhrase(days: number | null): string {
  if (days === null) return "on a date that was not recorded";
  if (days <= 0) return "today";
  if (days === 1) return "tomorrow";
  return `in ${days} days`;
}

/** "6 days ago" for a negative day count. Never a negative number in prose. */
export function overduePhrase(days: number | null): string {
  if (days === null) return "on a date that was not recorded";
  const overdue = Math.abs(days);
  if (overdue === 0) return "today";
  if (overdue === 1) return "yesterday";
  return `${overdue} days ago`;
}

function cadencePhrase(months: number | null): string {
  if (months === null) return "review cycle";
  if (months === 12) return "12 months";
  return `${months} months`;
}

/**
 * The row's spoken label.
 *
 * Leads with the state word — the same word the pill shows — then the
 * framework, then the exact date. `renewalDate` is passed in already formatted
 * because date formatting is locale work that belongs to `lib/format`, and
 * pulling it in here would make this module a formatting module too.
 */
export function postureRowSpokenLabel(
  row: ProgramPosture,
  renewalDate: string,
  selected: boolean,
): string {
  const dateClause =
    row.daysUntilRenewal === null
      ? "No renewal date on file."
      : `Renewal date ${renewalDate}.`;
  return [
    `${postureStateLabel(row.state)}.`,
    `${row.meta.short}, ${row.meta.full}.`,
    row.state === "unsupported" ? "" : dateClause,
    selected ? "Showing its detail." : "Show its detail.",
  ]
    .filter(Boolean)
    .join(" ");
}

const EVENT_VERBS: Readonly<Record<string, string>> = {
  attested: "Attested",
  renewed: "Renewed",
  revoked: "Withdrawn",
  amended: "Amended",
  unknown: "Recorded",
};

/**
 * The ledger's verb. `amended` is in the CHECK constraint (migration 0193
 * line 54) but no handler ever writes it, so a row carrying it came from
 * somewhere else — it is rendered rather than dropped.
 */
export function eventVerb(eventType: string): string {
  return EVENT_VERBS[eventType] ?? EVENT_VERBS.unknown ?? "Recorded";
}
