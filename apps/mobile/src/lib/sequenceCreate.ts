/**
 * lib/sequenceCreate.ts — the policy behind starting a new sequence on mobile.
 *
 * WHY MOBILE CREATES A SHELL AND SAYS SO. The offline-mutation substrate for
 * `OFFLINE_MUTATION_KEYS.sequenceCreate` has existed — with defaults, a queue
 * label and five tests — with ZERO UI call sites. This module is the missing
 * half's rules, kept import-free so every branch is unit-testable in the node
 * environment.
 *
 * WHAT CREATE ACTUALLY DOES, per the handler and not per hope.
 * `POST /api/v1/voice/sequences` with no `template_id` runs
 * `createDraftSequence` (services/voice/internal/handlers/sequences.go:693):
 * it validates the name, normalises an absent status to `draft`, stores an
 * empty step list, and returns 201. It spends NO LLM quota. So the honest
 * promise is "a named, empty draft in this workspace", and the sheet's copy
 * says exactly that rather than implying a journey has been built.
 *
 * WHAT CREATE CANNOT DO, also per the handler. `active` is refused on create
 * (:709) AND on update (:906), both through `writeSequenceStatusError`, which
 * answers 409 "live sequence statuses are unavailable because the execution
 * runtime is not qualified; allowed authoring values are draft and archived".
 * There is therefore no activate verb to build on any surface — mobile is not
 * missing one.
 *
 * NAME RULES ARE THE SERVER'S, MIRRORED. `validateSingleLine` (sequence_
 * validation.go) requires a non-empty trimmed value, at most
 * `sequenceMaxNameRunes` = 200 RUNES (counted on the RAW value, before
 * trimming), and rejects any control character including CR/LF. Mirroring it
 * client-side is not a second authority: the server still decides, and its 400
 * text is surfaced verbatim. It exists so a name that cannot possibly succeed
 * is caught before it costs a round trip and a lost sheet.
 */

/**
 * Server ceiling, in Unicode code points, from `sequenceMaxNameRunes`.
 * Counted with the spread operator rather than `.length` so an emoji or an
 * astral-plane character costs 1 here exactly as it costs 1 in Go's
 * `utf8.RuneCountInString`.
 */
export const SEQUENCE_NAME_MAX_RUNES = 200;

export type SequenceNameCheck =
  | { readonly ok: true; readonly name: string }
  | { readonly ok: false; readonly error: string };

/** Rune count, matching Go's `utf8.RuneCountInString` for well-formed input. */
export function runeCount(value: string): number {
  return [...value].length;
}

/**
 * Go's `unicode.IsControl` over the ranges a UTF-8 name can carry: C0
 * (U+0000–U+001F), DEL (U+007F) and C1 (U+0080–U+009F). CR and LF are inside
 * C0, so the handler's explicit newline rejection is covered by the same test.
 * Written as escapes, never as literal bytes — a raw control character in a
 * source file is invisible to every reviewer who follows.
 */
function hasControlCharacter(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

/**
 * Validate a proposed sequence name against the server's own rules.
 *
 * Order matters and mirrors the handler: emptiness first (that is the message
 * an operator who has typed nothing needs), then length, then the printable
 * single-line rule. Length is measured on the RAW string because the server
 * does — `validateSingleLine` trims only for the required-check.
 */
export function validateSequenceName(raw: string): SequenceNameCheck {
  const trimmed = raw.trim();
  if (trimmed === "") {
    return { ok: false, error: "Give the sequence a name." };
  }
  if (runeCount(raw) > SEQUENCE_NAME_MAX_RUNES) {
    return {
      ok: false,
      error: `Names are limited to ${SEQUENCE_NAME_MAX_RUNES} characters.`,
    };
  }
  if (hasControlCharacter(raw)) {
    return {
      ok: false,
      error: "A sequence name has to be a single line of plain text.",
    };
  }
  return { ok: true, name: trimmed };
}

/**
 * Characters remaining, or null when the field is far enough from the ceiling
 * that a counter would be chrome. Surfacing it only near the limit keeps the
 * sheet quiet in the normal case and loud in the case that matters.
 */
export function nameRemaining(raw: string): number | null {
  const left = SEQUENCE_NAME_MAX_RUNES - runeCount(raw);
  return left <= 40 ? left : null;
}

/**
 * Human sentence for a failed create, per the statuses this route can really
 * answer. Anything unmapped falls through to the server's own text, because
 * for the 400s on this route that text IS the validation reason.
 */
export function sequenceCreateErrorMessage(
  status: number,
  fallback?: string | undefined,
): string {
  const message = fallback?.trim();
  if (status === 403) {
    return "Your role can't create sequences. Ask an admin or an owner.";
  }
  if (status === 409) {
    // writeSequenceStatusError's 409. Unreachable from this sheet (we never
    // send a status) but mapped so a future caller cannot mistake it for a
    // duplicate-name conflict.
    return (
      message ||
      "Live sequence statuses aren't available in this deployment; sequences can only be created as drafts."
    );
  }
  if (status === 404 || status === 405 || status === 501) {
    return "This deployment doesn't expose sequence creation. Use the desktop or web app.";
  }
  if (status === 429) {
    return "Too many requests just now. Wait a moment and try again.";
  }
  if (status === 503) {
    return "The sequence service is unavailable right now. Try again shortly.";
  }
  if (status >= 500) {
    return "The sequence service couldn't create this draft. Try again shortly.";
  }
  return message || "Couldn't create this sequence.";
}

/**
 * What happens after a successful create, said in one sentence.
 *
 * Two genuinely different outcomes, and conflating them is how an operator
 * ends up waiting for a row that will not appear until reconnect:
 *   - online  → the draft exists now and we can open it;
 *   - queued  → nothing exists on the server yet, and there is no id to open.
 */
export function sequenceCreatedMessage(input: {
  name: string;
  queued: boolean;
}): string {
  const name = input.name.trim();
  const label = name ? `“${name}”` : "The sequence";
  return input.queued
    ? `${label} will be created when you're back online.`
    : `${label} created as an empty draft.`;
}

/**
 * Whether to offer "New sequence" at all.
 *
 * Deliberately does NOT take an `online` flag, and that is the interesting
 * part: unlike delete — which `lib/offlineQueueSafety` refuses to queue, so it
 * must be hidden the moment the gate closes — create is registered in the
 * offline mutation queue under a stable key with a persisted mutationFn. With
 * the network down it pauses, persists to the encrypted vault and replays on
 * reconnect. Hiding it offline would suppress the one write on this screen
 * that was built to survive being offline.
 *
 * What it does need: an identity to stamp the queued record with (a queued
 * write with a half-identity is how a replay lands in the wrong workspace on a
 * shared device), an editor-or-better role, and an endpoint that exists.
 */
export function canCreateSequence(input: {
  hasTenant: boolean;
  /** The list read answered 404/405/501 — the route is not deployed here. */
  unavailable: boolean;
  /** Result of `canAccessMinimumRole("editor", role, mode)`. */
  canWrite: boolean;
}): boolean {
  return input.hasTenant && !input.unavailable && input.canWrite;
}

/**
 * The one sentence the sheet must carry, because it is the part a phone
 * cannot deliver.
 *
 * RE-CHECKED against the flag flip (GATE#3): `MOBILE_SEQUENCE_AUTHORING_AVAILABLE`
 * is now true, so the justification this note used to carry — "the canvas this
 * draft opens into is read-only" — is gone. The SENTENCE survives it unchanged,
 * because what it claims is narrower than that justification was: steps are
 * ADDED on desktop, and that is still exactly true. The step palette was not
 * restored with the flag (`StepPalette.tsx` does not exist, and
 * sequenceCapabilities.test.ts pins its absence), so this canvas can edit,
 * reorder and delete steps that exist and can create none. A draft created here
 * therefore really does open onto an empty canvas the operator cannot fill from
 * the phone — which is the promise this note exists to keep.
 */
export const SEQUENCE_CREATE_SCOPE_NOTE =
  "Creates an empty draft. Steps are added in the desktop or web app; this screen then shows you its shape from anywhere.";
