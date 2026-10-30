/**
 * listSettingsForm — the policy behind editing a list's settings from the
 * phone (desktop anchor: components/lists/tabs/SettingsTab.tsx).
 *
 * Contract, read off apps/api/internal/lists/lists.go `Update` (:495-):
 *
 *   PATCH /api/v1/lists/{id}   — {id} is the LISTMONK BIGINT id; the handler
 *     rejects anything that does not `strconv.ParseInt` with 400 bad_id, so a
 *     UUID from a deep link can never be sent here. Callers must use the
 *     catalogue row's id.
 *   Body: any subset of {name, type, optin, description, tags} — the handler
 *     rejects unknown keys (400 unknown_field) and an EMPTY body (400
 *     empty_body), so the patch builder returns null when nothing changed
 *     rather than letting the UI fire a guaranteed 400.
 *   Validation upstream: name non-empty; type private|public|temporary;
 *     optin single|double.
 *
 * Mounted with `write` (write:subscribers) → session floor EDITOR
 * (routeauth manifest: PATCH /api/v1/lists/{id} session_minimum_role=editor).
 *
 * WHY THIS WRITE IS ONLINE-ONLY (never the offline outbox): flipping
 * `optin` single↔double changes what a subscriber must do before they are
 * mailable — a consent-shaped setting. A queued flip replaying hours later
 * would silently change signup behaviour at a moment nobody is looking at
 * the screen. Fail honestly while offline instead.
 *
 * Import-free so the diffing and validation are node-testable.
 */
import { LIST_NAME_MAX, type ListOptin, type ListType } from "@/lib/listCreate";

export interface ListSettingsDraft {
  name: string;
  description: string;
  type: ListType;
  optin: ListOptin;
}

export interface ListSettingsOriginal {
  name: string;
  description?: string | undefined;
  type?: string | undefined;
  optin?: string | undefined;
}

export type ListSettingsPatch = Partial<{
  name: string;
  description: string;
  type: ListType;
  optin: ListOptin;
}>;

/** Mirror of lib/listCreate's name rule so the edit form rejects the same
 * inputs the create form does (and the server would). */
export function listSettingsNameProblem(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return "A list needs a name.";
  if (trimmed.length > LIST_NAME_MAX) {
    return `Keep the name under ${LIST_NAME_MAX} characters.`;
  }
  return null;
}

/**
 * Diff the draft against the row the operator opened. Returns ONLY the
 * changed fields — the server treats every present key as an instruction —
 * and null when nothing changed, because the handler 400s an empty body.
 *
 * The original's type/optin may be absent on old catalogue rows; they
 * default the way the server does ("private"/"single"), so an untouched
 * control never generates a phantom change.
 */
export function listSettingsPatch(
  original: ListSettingsOriginal,
  draft: ListSettingsDraft,
): ListSettingsPatch | null {
  const patch: ListSettingsPatch = {};
  const name = draft.name.trim();
  if (name && name !== original.name) patch.name = name;
  const description = draft.description.trim();
  if (description !== (original.description ?? "").trim()) {
    patch.description = description;
  }
  if (draft.type !== ((original.type ?? "private") as ListType)) {
    patch.type = draft.type;
  }
  if (draft.optin !== ((original.optin ?? "single") as ListOptin)) {
    patch.optin = draft.optin;
  }
  return Object.keys(patch).length > 0 ? patch : null;
}

/**
 * PATCH/DELETE /api/v1/lists/{id} accept ONLY the Listmonk bigint id
 * (strconv.ParseInt guard). The detail route param can carry a UUID when it
 * arrived from search or a deep link, so manage affordances are offered only
 * for an id this predicate admits.
 */
export function isListmonkBigintId(id: string | null | undefined): boolean {
  return typeof id === "string" && /^[0-9]+$/u.test(id.trim()) && id.trim() !== "";
}

/**
 * The sentence shown when the whole manage surface is withheld from a role.
 * Viewer sees WHY there is nothing to press, per the house rule that a
 * missing affordance for a role gets one caption, not a disabled button.
 */
export const LIST_MANAGE_ROLE_CAPTION =
  "Editing or deleting a list needs the editor role or above.";
