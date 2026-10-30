/**
 * lib/formLifecycle.ts — which lifecycle verbs a form offers, and what each
 * one says before it fires.
 *
 * The desktop ships publish / move-to-draft / archive as a selection toolbar
 * (apps/desktop/src/pages/Forms.tsx:1289-1296, each a `api.updateForm
 * {status}` PATCH). The mobile port keeps the same three verbs but computes
 * them from the row's CURRENT status, because a phone acts on one form at a
 * time and "Publish" beside an already-published form is a button that can
 * only confuse.
 *
 * TRANSPORT POLICY, decided by lib/offlineQueueSafety.ts rather than here:
 * `isSafeQueueBody` explicitly refuses to queue a `/forms/{id}` PATCH whose
 * body carries `status` — "Publish/unpublish changes a PUBLIC surface". So
 * every verb in this table is ONLINE-ONLY: the point of pulling a misbehaving
 * live form is that it stops NOW, and an archive replayed from a queue an
 * hour late has already failed at the only thing it was for.
 *
 * ROLE. PATCH /api/v1/forms/{id} carries `session_minimum_role: editor` in
 * the routeauth manifest (`write:campaigns` on the API-key path); DELETE is
 * admin. The constants below are what screens gate their affordances on, via
 * `canAccessMinimumRole`.
 *
 * ARCHIVED IS TERMINAL. `AllowedTransition` (apps/api/internal/forms/
 * forms.go:141-154) permits draft→published/archived and
 * published→draft/archived, and NOTHING out of archived — an attempt surfaces
 * as a 500, not a polite 422. So the archive verb here is IRREVERSIBLE and
 * says so, and an archived form offers no lifecycle verbs at all. The desktop
 * toolbar offers the same three verbs on any selection and lets mixed
 * selections hit the wall; a per-form client can do better than that.
 *
 * Import-free so every rule is unit-tested in the node vitest run.
 */

export type FormLifecycleStatus = "draft" | "published" | "archived";

/** The manifest floor for PATCH /api/v1/forms/{id}. */
export const FORM_LIFECYCLE_MINIMUM_ROLE = "editor" as const;
/** The manifest floor for DELETE /api/v1/forms/{id}. */
export const FORM_DELETE_MINIMUM_ROLE = "admin" as const;

export interface FormLifecycleAction {
  /** What the PATCH body will say: `{ status: target }`. */
  target: FormLifecycleStatus;
  /** Button label. A verb, per the ConfirmSheet house style. */
  label: string;
  /** ConfirmSheet title. */
  confirmTitle: string;
  /** ConfirmSheet message — what this does to the public surface. */
  confirmMessage: string;
  /** Paint the affirmative button in the danger colour. */
  destructive: boolean;
  /** Toast after the server confirms. */
  successMessage: string;
}

function normalizeFormLifecycleStatus(
  status: string | null | undefined,
): FormLifecycleStatus | null {
  const normalized = (status ?? "").trim().toLowerCase();
  return normalized === "draft" ||
    normalized === "published" ||
    normalized === "archived"
    ? normalized
    : null;
}

function publishAction(name: string): FormLifecycleAction {
  return {
    target: "published",
    label: "Publish",
    confirmTitle: `Publish ${name}?`,
    confirmMessage:
      "The hosted page goes live and embeds start rendering it. Visitors can submit it the moment this lands.",
    destructive: false,
    successMessage: `${name} is live.`,
  };
}

function draftAction(name: string): FormLifecycleAction {
  return {
    target: "draft",
    label: "Move to draft",
    confirmTitle: `Move ${name} to draft?`,
    confirmMessage:
      "The hosted page stops being served and embeds stop rendering it. Nothing already captured is lost, and it can be published again.",
    destructive: true,
    successMessage: `${name} is a draft — it is no longer served.`,
  };
}

function archiveAction(
  name: string,
  from: FormLifecycleStatus,
): FormLifecycleAction {
  return {
    target: "archived",
    label: "Archive",
    confirmTitle: `Archive ${name}?`,
    confirmMessage:
      (from === "published"
        ? "The hosted page stops being served immediately. "
        : "") +
      "Submissions already captured are kept, but archiving is PERMANENT: the server allows no way out of the archived state, so this form can never be published or edited again.",
    destructive: true,
    successMessage: `${name} is archived — permanently retired.`,
  };
}

/**
 * The verbs the given form offers, in the order a phone should list them.
 *
 * An ARCHIVED form offers NOTHING: `AllowedTransition` has no edge out of
 * archived, so any verb here would be a guaranteed server error dressed as a
 * button. `FORM_ARCHIVED_TERMINAL_NOTE` is the caption that explains the
 * absence.
 *
 * An UNKNOWN status also returns [] rather than guessing: offering "Publish"
 * on a status this build has never seen could flip a state the server
 * considers more advanced than published.
 */
export function formLifecycleActions(
  status: string | null | undefined,
  name?: string | null,
): FormLifecycleAction[] {
  const current = normalizeFormLifecycleStatus(status);
  const label = (name ?? "").trim() || "this form";
  if (current === "draft") {
    return [publishAction(label), archiveAction(label, current)];
  }
  if (current === "published") {
    return [draftAction(label), archiveAction(label, current)];
  }
  return [];
}

/** What the lifecycle runner needs to know about one form. */
export interface FormLifecycleTarget {
  id: string;
  name?: string | undefined;
  slug?: string | undefined;
  status?: string | undefined;
}

/** Normalise a list row (whose fields are all optional) into a target. */
export function lifecycleTargetFromListItem(item: {
  id?: unknown;
  name?: string | undefined;
  slug?: string | undefined;
  status?: unknown;
}): FormLifecycleTarget {
  return {
    id: String(item.id ?? ""),
    name: item.name ?? undefined,
    slug: item.slug ?? undefined,
    status: typeof item.status === "string" ? item.status : undefined,
  };
}

/** Why an archived form shows no lifecycle buttons. */
export const FORM_ARCHIVED_TERMINAL_NOTE =
  "Archived is permanent for a form — the server allows no transition out of it. The submissions it captured stay readable here.";

/** The one sentence an offline tap gets. Stated once so screens agree. */
export const FORM_LIFECYCLE_OFFLINE_MESSAGE =
  "Changing what the public is served is never queued. Reconnect and try again.";

/* ------------------------------------------------------------------ *
 * Creating a form — the 4-field modal, not schema authoring.
 * Client-side mirrors of the server's CreateInput rules (forms.go:117-124,
 * handlers.go:142-154): name ≤200, slug `[a-z0-9._~-]+` ≤128, optInMode
 * REQUIRED (the server 422s rather than defaulting it).
 * ------------------------------------------------------------------ */

export const FORM_NAME_MAX = 200;
export const FORM_SLUG_MAX = 128;
const FORM_SLUG_PATTERN = /^[a-z0-9._~-]+$/;

/** A slug suggestion from the name, matching desktop's behaviour. */
export function suggestFormSlug(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9._~-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, FORM_SLUG_MAX);
}

export interface CreateFormDraft {
  name: string;
  slug: string;
  optInMode: "single" | "double";
  successMessage: string;
}

/** Null when submittable; otherwise the one sentence to show. */
export function createFormDraftProblem(draft: CreateFormDraft): string | null {
  const name = draft.name.trim();
  if (name === "") return "Give the form a name.";
  if (name.length > FORM_NAME_MAX)
    return `The name can be at most ${FORM_NAME_MAX} characters.`;
  const slug = draft.slug.trim();
  if (slug === "") return "The form needs a slug — it becomes the public URL.";
  if (slug.length > FORM_SLUG_MAX)
    return `The slug can be at most ${FORM_SLUG_MAX} characters.`;
  if (!FORM_SLUG_PATTERN.test(slug))
    return "The slug may only use lowercase letters, digits, and . _ ~ -";
  return null;
}
