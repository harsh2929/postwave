/**
 * listCreate — the policy behind creating a list from the phone.
 *
 * Contract, read off apps/api/internal/lists/lists.go:
 *
 *   POST /api/v1/lists  { name, type?, optin?, description?, tags? }
 *     400 missing_name when `name` trims to empty (Create :262-266)
 *     type  defaults to "private" server-side (:267-269)
 *     optin defaults to "single"  server-side (:270-272)
 *     503 repo_unavailable when the list-identity repository is not wired —
 *         and, importantly, the handler states NO upstream list was created,
 *         so this is a clean failure the UI may report as "nothing happened".
 *
 * The route is mounted with `apikeys.RequireScope(apikeys.ScopeWriteSubscribers)`
 * inside MountIdempotentRoutes. `write:subscribers` is in `editorWriteScopes`
 * (apps/api/internal/apikeys/middleware.go), so on the session path
 * owner|admin|editor may create — this is an EDITOR action.
 *
 * Import-free so the validation and the copy are unit-tested.
 */

export type ListType = "private" | "public";
export type ListOptin = "single" | "double";

/**
 * The server does not cap the name, but a list whose name does not fit a row
 * is unreadable everywhere it appears (pickers, campaign headers, the
 * subscriber's memberships card). Capped here so the operator finds out while
 * typing rather than after the write.
 */
export const LIST_NAME_MAX = 120;

export const LIST_TYPE_OPTIONS: readonly {
  value: ListType;
  label: string;
  hint: string;
}[] = [
  {
    value: "private",
    label: "Private",
    hint: "Only reachable from inside Moosewave. The safe default.",
  },
  {
    value: "public",
    label: "Public",
    hint: "Can be shown on hosted subscription pages, so anyone with the link can join it.",
  },
];

export const LIST_OPTIN_OPTIONS: readonly {
  value: ListOptin;
  label: string;
  hint: string;
}[] = [
  {
    value: "single",
    label: "Single",
    hint: "Subscribers are mailable as soon as they are added.",
  },
  {
    value: "double",
    label: "Double",
    hint: "Subscribers must confirm by email before they can be mailed.",
  },
];

/** Why the name cannot be submitted, or null when it is fine. */
export function listNameProblem(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return "Give the list a name.";
  if (Array.from(trimmed).length > LIST_NAME_MAX) {
    return `Keep the name under ${LIST_NAME_MAX} characters.`;
  }
  return null;
}

/** The POST body. Type and opt-in are always sent so the choice is explicit. */
export function createListBody(input: {
  name: string;
  type: ListType;
  optin: ListOptin;
}): { name: string; type: ListType; optin: ListOptin } {
  return {
    name: input.name.trim(),
    type: input.type,
    optin: input.optin,
  };
}

/**
 * Map a create failure onto a sentence.
 *
 * `repo_unavailable` is called out because the handler guarantees nothing was
 * created upstream — telling the user to retry is correct there, whereas a
 * generic "something went wrong" leaves them wondering whether a half-made
 * list exists.
 */
export function createListFailure(error: {
  status: number;
  code?: string | undefined;
  message: string;
}): string {
  if (error.code === "missing_name") return "Give the list a name.";
  if (error.code === "repo_unavailable" || error.status === 503) {
    return "Lists aren't available on this deployment right now. Nothing was created.";
  }
  if (error.status === 403) {
    return "Creating a list needs an editor role or higher.";
  }
  if (error.status === 409) {
    return "A list with that name already exists.";
  }
  return error.message || "Couldn't create that list.";
}
