/**
 * Mobile sequence capability boundary.
 *
 * These two flags were introduced together and are no longer in the same state,
 * because the two claims behind them stopped being equally true.
 *
 * RUNTIME stays closed, and the evidence is stronger than the flag ever was: the
 * SERVER refuses. services/voice/internal/handlers/sequences.go:1239 answers "live
 * sequence statuses are unavailable because the execution runtime is not
 * qualified". A client flag is not what is holding this shut, and flipping it would
 * build a UI the server actively rejects.
 *
 * AUTHORING opens (GATE#3, 2026-08-18). Both of its original justifications were
 * checked rather than inherited:
 *
 *  1. "no qualified live execution runtime" — true, and it gates the RUNTIME flag
 *     above. Editing a draft's steps does not require executing them.
 *  2. "no complete mobile conflict-recovery workflow" — this was true when written
 *     and has since been built. useSequenceCanvasSave holds the row version,
 *     chains it (asserting the server's new version is exactly base + 1), clears
 *     the held version on an authority error so the next attempt fails closed
 *     rather than replaying against a version it no longer owns, and surfaces
 *     "This draft moved on. Reload the latest version before saving."
 *     SequenceSaveAuthorityError is that contract's name.
 *
 * The server side was verified too: POST/PATCH/DELETE /api/v1/voice/sequences are
 * mounted at apps/api/main.go:4791-4793 behind ScopeWriteCampaigns, and the
 * generated manifest floors them at `editor` with `review_status: reviewed`.
 *
 * One thing was removed rather than released with it: the step editor's three
 * "AI" buttons, whose endpoint is deterministic string templating (GATE#2). They
 * are gone, so opening this exposes an editor that claims only what it does.
 */
export const MOBILE_SEQUENCE_RUNTIME_AVAILABLE = false;
export const MOBILE_SEQUENCE_AUTHORING_AVAILABLE = true;

export interface MobileSequenceStatusPresentation {
  label: string;
  tone: "warning" | "neutral";
  draft: boolean;
  /**
   * The SERVER's answer to "may this sequence's steps be edited at all", derived
   * from its stored status alone.
   *
   * services/voice/internal/handlers/sequences.go:892-895 rejects a PATCH with
   * 409 — "only draft sequences are editable; duplicate this sequence into a new
   * draft before changing it" — whenever the stored status is not `draft`. That
   * is a rule about the ROW, not about this client: desktop gets the same 409.
   * So this is exactly `!draft`, and it was previously the literal `true` in all
   * five branches, which made it simultaneously constant and dead — nothing read
   * it, and the detail canvas gated its step verbs on the mobile authoring flag
   * alone. With authoring open that meant Edit / Delete / Move rendered on
   * archived, paused and legacy-active journeys, and every save they queued was
   * a guaranteed 409.
   *
   * An UNRECOGNISED status is read-only too: this is the term that decides
   * whether a write is offered, and an unknown status is not evidence that the
   * server will accept one.
   */
  readOnly: boolean;
}

export function mobileSequenceStatusPresentation(
  raw: string | undefined,
): MobileSequenceStatusPresentation {
  const status = (raw ?? "").trim().toLowerCase();
  if (status === "draft") {
    // The one editable status. See `readOnly` on the interface above.
    return { label: "Draft", tone: "neutral", draft: true, readOnly: false };
  }
  if (status === "active" || status === "running") {
    return {
      label: "Legacy active label",
      tone: "warning",
      draft: false,
      readOnly: true,
    };
  }
  if (status === "archived") {
    return {
      label: "Archived · read-only",
      tone: "neutral",
      draft: false,
      readOnly: true,
    };
  }
  // `paused` is a first-class status in the shared status whitelist
  // (apps/desktop/src/pages/Sequences.tsx:577). Dumping it into the
  // "Unverified" fallback made a legitimately paused row read as a
  // data-integrity warning — the one place this module's honest-labelling
  // premise broke.
  if (status === "paused") {
    return {
      label: "Paused",
      tone: "warning",
      draft: false,
      readOnly: true,
    };
  }
  return {
    label: "Unverified · read-only",
    tone: "warning",
    draft: false,
    readOnly: true,
  };
}

/**
 * May this build edit THIS sequence's steps?
 *
 * The composition of both terms, in one place, because it has three consumers
 * that must never disagree: the canvas's `readOnly`, the step editor's
 * `visible`, and the persistence hook's enqueue guard. When it was an inline
 * expression at the first two of those, the third silently kept queueing.
 *
 *  - `MOBILE_SEQUENCE_AUTHORING_AVAILABLE` — the CLIENT's release decision:
 *    whether this build ships the step editor at all.
 *  - `!readOnly` — the SERVER's rule about this particular row. A PATCH is
 *    rejected with 409 unless the stored status is `draft`
 *    (services/voice/internal/handlers/sequences.go:892-895). Desktop gets the
 *    same refusal, so this is not a mobile ceiling; it is the sequence's own
 *    state, and offering Edit / Delete / Move on an archived or paused journey
 *    is offering a save that cannot land.
 *
 * FAILS CLOSED on the statuses that mean "we do not know yet": an empty string
 * (the detail has not arrived, or the stored projection carries no status) and
 * anything unrecognised both present as read-only.
 */
export function mobileSequenceStepsEditable(
  rawStatus: string | undefined,
): boolean {
  return (
    MOBILE_SEQUENCE_AUTHORING_AVAILABLE &&
    !mobileSequenceStatusPresentation(rawStatus).readOnly
  );
}
