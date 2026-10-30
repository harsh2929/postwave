/**
 * lib/templateLifecycle.ts — the reversible archive / restore pair as
 * node-testable rules (desktop parity: TemplateDetailSlideover.tsx:255,
 * `onArchive` / `onRestore`).
 *
 * ONE MODULE, TWO READERS. hooks/useTemplateLifecycle decides whether to
 * confirm and what to say afterwards; components/templates/
 * TemplateLifecycleAction decides whether the control is offered and how it
 * is labelled. Both read from here, so the sheet can never offer a verb the
 * hook would refuse, or the other way round.
 *
 * SERVER FACTS MIRRORED (apps/api/internal/campaigntemplates/lifecycle.go):
 *   - `PATCH /{id}/archive` and `PATCH /{id}/restore` (setArchived:381) are
 *     mounted `write` — editor-and-up on the session path, which the
 *     routeauth manifest states too.
 *   - requireTemplateIfMatch (lifecycle.go:68) demands exactly ONE strong
 *     entity tag: 428 when missing or `*`, 412 when weak (`W/`), unquoted or
 *     multi-valued. The tag is `Template.ETag` off the single-template read;
 *     the catalogue projection carries none, so `etag` gates the offer here.
 *   - `archived_at` is a timestamp restore clears (Repo.setArchived): the
 *     row's `archivedAt` alone decides which verb it gets.
 *   - Archive is REVERSIBLE — the reason it is offered on a phone at all —
 *     but it still pulls a design off every browse shelf and out of every
 *     "start a campaign" list in the workspace, so it is confirmed, in the
 *     danger colour. Restore is the recoverable half and goes straight through.
 */
import type { MobileTemplate } from "@/lib/templateCatalog";

export type TemplateLifecycleVerb = "archive" | "restore";

/** The two fields the rules read — a whole row is not needed. */
export type LifecycleTemplate = Pick<MobileTemplate, "etag" | "archivedAt">;

export function templateLifecycleVerb(
  template: Pick<MobileTemplate, "archivedAt">,
): TemplateLifecycleVerb {
  return template.archivedAt === null ? "archive" : "restore";
}

/**
 * Exactly what requireTemplateIfMatch accepts: quoted, so never `W/`-weak.
 * The length check refuses the lone `"` a truncated payload could carry.
 */
export function isStrongTemplateEtag(etag: string): boolean {
  return etag.length >= 2 && etag.startsWith('"') && etag.endsWith('"');
}

/**
 * Whether the control is offered at all. Silent when not — the two creating
 * verbs above it already say "needs an editor role" / "you're offline", and
 * a third copy of that sentence would be noise; the missing-tag case is a
 * catalogue row the detail read has not yet replaced, and "Checking the
 * design…" is already on screen for that.
 */
export function templateLifecycleOffered(input: {
  template: LifecycleTemplate | null;
  canWrite: boolean;
  online: boolean;
}): boolean {
  return (
    input.template !== null &&
    input.canWrite &&
    input.online &&
    isStrongTemplateEtag(input.template.etag)
  );
}

export const TEMPLATE_LIFECYCLE_A11Y: Record<
  TemplateLifecycleVerb,
  { label: string; hint: string }
> = {
  archive: {
    label: "Archive this design",
    hint: "Takes it off the browse shelf. Nothing is deleted — restore it any time from the Archived shelf.",
  },
  restore: {
    label: "Restore this design to the library",
    hint: "Puts it back on the browse shelf and makes it usable for new campaigns again.",
  },
};

export function templateLifecycleButtonLabel(
  verb: TemplateLifecycleVerb,
  busy: boolean,
): string {
  if (verb === "archive") return busy ? "Archiving…" : "Archive this design";
  return busy ? "Restoring…" : "Restore to the library";
}

/**
 * Structurally a ConfirmSheet `ConfirmOptions`; declared here rather than
 * imported so this module stays react-native-free for the node test runner.
 */
export interface TemplateArchiveConfirm {
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel: string;
  destructive: true;
}

/** Only ARCHIVE is confirmed; restore has nothing to warn about. */
export function templateArchiveConfirm(name: string): TemplateArchiveConfirm {
  return {
    title: `Archive “${name}”?`,
    message:
      "It leaves every browse shelf and stops being offered for new campaigns. Nothing is deleted — restore it any time from the Archived shelf.",
    confirmLabel: "Archive",
    cancelLabel: "Cancel",
    destructive: true,
  };
}

export function templateLifecycleSuccessMessage(
  verb: TemplateLifecycleVerb,
  name: string,
): string {
  return verb === "archive"
    ? `Archived ${name}. Restore it any time from the Archived shelf.`
    : `Restored ${name} to the library.`;
}

/** The fallback when the server's refusal carries no code this app names. */
export function templateLifecycleFailureFallback(
  verb: TemplateLifecycleVerb,
): string {
  return verb === "archive"
    ? "Couldn't archive that design."
    : "Couldn't restore that design.";
}
