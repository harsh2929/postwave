/**
 * lib/sequenceDraftSave.ts — turning a REVIEWED AI draft into a save the
 * sequence API will accept.
 *
 * Split from `lib/sequenceDraft` on a real seam, not just to fit a budget:
 * that module speaks to the DRAFTING endpoint (what may be asked of the model,
 * and how to read what it says back), while this one speaks to the SEQUENCE
 * endpoint (what may be persisted). They mirror two different Go files with
 * two different sets of bounds, and they change for different reasons.
 *
 * BOTH HALVES ARE IMPORT-FREE so vitest's node environment can exercise them.
 *
 * THE ONE THING THAT MAKES THIS FILE NECESSARY. `POST /voice/sequences/draft`
 * only drops a step when subject AND body are both empty
 * (generation/draft.go::parseSequenceDraftJSON), whereas
 * `POST /voice/sequences` rejects the WHOLE sequence when any email has no
 * subject (handlers/sequence_validation.go::validateEmailConfig →
 * validateSingleLine with required=true). A perfectly ordinary draft response
 * can therefore be unsaveable, and without `draftSaveProblems` the operator
 * would meet that as one opaque 400 after reading five emails.
 */
import type { SequenceStepWire } from "@/api/sequenceWire";

import { runeCount, type SequenceDraftEmail } from "./sequenceDraft";
/** The NAME rule is the same rule the blank-create sheet already mirrors, and
 *  a second copy of it here is how the two would drift. `sequenceCreate` is
 *  import-free for exactly this reason. */
import { validateSequenceName } from "./sequenceCreate";

/** `sequenceMaxSubjectRunes` (handlers/sequence_validation.go:24). */
export const SEQUENCE_STEP_SUBJECT_MAX_RUNES = 255;
/** `sequenceMaxBodyRunes` (:25). */
export const SEQUENCE_STEP_BODY_MAX_RUNES = 262_144;

/** One reason a drafted email cannot be saved as it stands. */
export interface SequenceDraftProblem {
  /** `SequenceDraftEmail.id`, or `"sequence"` for a whole-draft problem. */
  readonly id: string;
  readonly message: string;
}

/**
 * Everything `POST /api/v1/voice/sequences` would reject, found before the
 * request rather than after it.
 *
 * The name check is `validateSingleLine("name", …, 200, required)` and the
 * per-email checks are `validateEmailConfig`. Reported as a LIST rather than a
 * first-failure so the review screen can mark every bad card at once — a
 * one-at-a-time save loop over five emails is the interaction this is here to
 * avoid.
 */
export function draftSaveProblems(input: {
  name: string;
  emails: readonly SequenceDraftEmail[];
}): SequenceDraftProblem[] {
  const problems: SequenceDraftProblem[] = [];
  const nameCheck = validateSequenceName(input.name);
  if (!nameCheck.ok) {
    problems.push({ id: "sequence", message: nameCheck.error });
  }
  if (input.emails.length === 0) {
    problems.push({
      id: "sequence",
      message: "Keep at least one email, or discard the draft.",
    });
  }
  for (const email of input.emails) {
    if (email.subject.trim() === "") {
      problems.push({ id: email.id, message: "Add a subject line." });
    } else if (runeCount(email.subject) > SEQUENCE_STEP_SUBJECT_MAX_RUNES) {
      problems.push({
        id: email.id,
        message: `Subject lines are limited to ${SEQUENCE_STEP_SUBJECT_MAX_RUNES} characters.`,
      });
    }
    if (email.body.trim() === "") {
      problems.push({ id: email.id, message: "Add an email body." });
    } else if (runeCount(email.body) > SEQUENCE_STEP_BODY_MAX_RUNES) {
      problems.push({ id: email.id, message: "This email body is too long." });
    }
  }
  return problems;
}

/**
 * Expand a reviewed draft into the step union the save endpoint accepts.
 *
 * A draft email carries a `delay_hours` wait RELATIVE to the previous email;
 * the sequence contract models a wait as its own node ahead of the email. So a
 * positive wait becomes a standalone `delay` step and positions are renumbered
 * densely 1..N across the whole flow — `validateSteps` rejects a duplicate or
 * a zero position, so the renumbering is a requirement, not tidiness.
 *
 * `delay.value`/`delay.unit` are emitted alongside `seconds` because
 * `validateDelayConfig` cross-checks them when they are present, and days read
 * better than 48 hours on every surface that renders the saved sequence.
 */
export function draftEmailsToWireSteps(
  emails: readonly SequenceDraftEmail[],
): SequenceStepWire[] {
  const out: SequenceStepWire[] = [];
  for (const email of emails) {
    const hours = email.delayHours ?? 0;
    if (hours > 0) {
      const seconds = hours * 3600;
      const whole = hours % 24 === 0;
      out.push({
        type: "delay",
        position: out.length + 1,
        delay: whole
          ? { seconds, value: hours / 24, unit: "days" }
          : { seconds, value: hours, unit: "hours" },
      });
    }
    out.push({
      type: "email",
      position: out.length + 1,
      email: { subject: email.subject.trim(), body: email.body },
    });
  }
  return out;
}

