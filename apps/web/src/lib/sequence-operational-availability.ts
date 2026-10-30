// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Sequence authoring is present, but this repository does not contain a
 * release-qualified trigger, enrollment, scheduling, delivery, and analytics
 * runtime. Keep every web surface default-closed: a stored status string is
 * not proof that a sequence is running.
 */
export const SEQUENCE_RUNTIME_AVAILABLE: boolean = false;

/**
 * Regeneration is an authoring-only, two-step operation: the service returns
 * an unpersisted review candidate, and the web persists it only after explicit
 * acceptance through the ordinary version-protected draft PATCH.
 *
 * This does not imply that sequence enrollment or delivery is available.
 */
export const SEQUENCE_REGENERATION_AVAILABLE: boolean = true;

export const SEQUENCE_RUNTIME_UNAVAILABLE_REASON =
  "Live sequence triggers, enrollment, delivery, and runtime analytics are not available in this build. You can safely design and review confirmed drafts, but you cannot activate them.";

export type SequenceStatusPresentationTone = "neutral" | "warning" | "danger";

export interface SequenceStatusPresentation {
  label: string;
  tone: SequenceStatusPresentationTone;
  detail: string;
  known: boolean;
}

/**
 * Present legacy operational labels without converting them into runtime
 * claims. Older rows can still contain active/paused/running values.
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
      detail: "Stored as archived and read-only in the web draft designer.",
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

export function isEditableSequenceDraft(status: string | undefined): boolean {
  return status?.trim().toLowerCase() === "draft";
}

export function hasConfirmedSequenceVersion(
  version: number | undefined,
): version is number {
  return Number.isSafeInteger(version) && (version ?? 0) > 0;
}

/** A save needs both draft lifecycle authority and a strong server revision. */
export function canEditSequenceDraft(
  status: string | undefined,
  version: number | undefined,
): boolean {
  return (
    isEditableSequenceDraft(status) && hasConfirmedSequenceVersion(version)
  );
}

export function sequenceEditUnavailableReason(
  status: string | undefined,
  version: number | undefined,
): string {
  if (!isEditableSequenceDraft(status)) {
    return `${sequenceStatusPresentation(status).detail} Only confirmed drafts can be edited.`;
  }
  if (!hasConfirmedSequenceVersion(version)) {
    return "This draft has no confirmed server version, so editing is locked. Reload after the service returns a positive version.";
  }
  return "";
}
