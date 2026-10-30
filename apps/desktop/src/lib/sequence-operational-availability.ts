/**
 * The repository currently persists sequence drafts, but it does not ship an
 * in-repo trigger evaluator, enrollment orchestrator, or delivery dispatcher.
 * Keep the renderer default-closed until those contracts are implemented and
 * release-qualified together. This is intentionally a product capability,
 * not a development-environment flag: demos must not imply that changing a
 * status string starts automation.
 */
export const SEQUENCE_RUNTIME_AVAILABLE: boolean = false;

/**
 * The Voice endpoint now returns a non-persisting review candidate, but the
 * desktop flow is still not release-qualified end to end: canvas drafts lack
 * stable source-template identity, nested branch emails lack route identity,
 * and preview acceptance still needs dedicated version-conflict evidence.
 * Keep the affordance unavailable until those contracts are complete.
 */
export const SEQUENCE_REGENERATION_AVAILABLE: boolean = false;

export const SEQUENCE_RUNTIME_UNAVAILABLE_REASON =
  "Live sequence triggers, enrollment, delivery, and runtime analytics are not available in this build. You can safely design and review drafts, but you cannot activate them.";

export type SequenceStatusPresentationTone = "neutral" | "warning" | "danger";

export interface SequenceStatusPresentation {
  label: string;
  tone: SequenceStatusPresentationTone;
  detail: string;
  known: boolean;
}

/**
 * Never translate missing or legacy operational labels into an assertion that
 * automation is running. Rows created by older builds may still contain
 * `active` / `paused`; those are displayed as stored labels with an explicit
 * runtime caveat.
 */
export function sequenceStatusPresentation(
  rawStatus: string | undefined,
): SequenceStatusPresentation {
  const status = rawStatus?.trim().toLowerCase();
  if (!status) {
    return {
      label: "Status unavailable",
      tone: "warning",
      detail: "The server did not return a sequence status.",
      known: false,
    };
  }
  if (status === "draft") {
    return {
      label: "Draft",
      tone: "neutral",
      detail: "Editable design draft. Nothing is enrolling or sending.",
      known: true,
    };
  }
  if (status === "archived") {
    return {
      label: "Archived",
      tone: "neutral",
      detail: "Stored as archived and read-only in the desktop builder.",
      known: true,
    };
  }
  if (status === "active" || status === "running") {
    return {
      label: "Legacy active label",
      tone: "danger",
      detail:
        "This row is labelled active, but this build has no qualified sequence runtime. Do not treat it as sending.",
      known: true,
    };
  }
  if (status === "paused") {
    return {
      label: "Legacy paused label",
      tone: "warning",
      detail:
        "This row is labelled paused, but this build has no qualified sequence runtime or active runs to pause.",
      known: true,
    };
  }
  return {
    label: "Unknown status",
    tone: "warning",
    detail: `The server returned an unsupported status (${rawStatus}).`,
    known: false,
  };
}

/** Only confirmed drafts are structurally editable in the current product. */
export function isEditableSequenceDraft(status: string | undefined): boolean {
  return status?.trim().toLowerCase() === "draft";
}
