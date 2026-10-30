/**
 * lib/workspaceDateFormat.ts — the workspace's date-format preference.
 *
 * Desktop's WorkspaceProfileSection offers four formats
 * (apps/desktop/src/components/settings/sections.tsx DATE_FORMATS) and PATCHes
 * them to /api/v1/settings/workspace. Mobile's workspace editor carried every
 * other field on that endpoint — display name, reply-to, timezone, brand
 * colour, logo — and silently omitted this one, so the phone could not read or
 * change how the workspace renders dates.
 *
 * SERVER TRUTH (apps/api/internal/settings/workspace.go):
 *   `allowedDateFormats` is a closed set of exactly these four strings; any
 *   other non-blank value is refused 400 `bad_date_format` with the sentence
 *   below. A blank/omitted value leaves the column alone, and an unset column
 *   reads back as the "MMM D, YYYY" default (Get's ErrWorkspaceNotFound
 *   branch, and the COALESCE in Upsert).
 *
 * Import-free so it runs under node vitest.
 */

export interface WorkspaceDateFormatOption {
  /** The exact string the column stores and `allowedDateFormats` accepts. */
  value: string;
  /** Desktop's own label for the option. */
  label: string;
  /** The rendered sample, split out so a chip can show it alone. */
  example: string;
}

/** The four, in desktop's order, with desktop's labels. */
export const WORKSPACE_DATE_FORMATS: readonly WorkspaceDateFormatOption[] = [
  { value: "MMM D, YYYY", label: "May 3, 2026 (MMM D, YYYY)", example: "May 3, 2026" },
  { value: "D MMM YYYY", label: "3 May 2026 (D MMM YYYY)", example: "3 May 2026" },
  { value: "YYYY-MM-DD", label: "2026-05-03 (YYYY-MM-DD)", example: "2026-05-03" },
  { value: "MM/DD/YYYY", label: "05/03/2026 (MM/DD/YYYY)", example: "05/03/2026" },
];

/** What the column reads back as when it has never been set. */
export const WORKSPACE_DATE_FORMAT_DEFAULT = "MMM D, YYYY";

/** The handler's own `bad_date_format` sentence, echoed rather than reworded. */
export const WORKSPACE_DATE_FORMAT_REJECTED =
  "date_format must be one of YYYY-MM-DD, MMM D, YYYY, D MMM YYYY, MM/DD/YYYY";

/** Exactly the membership test `allowedDateFormats` performs, after a trim. */
export function isAllowedWorkspaceDateFormat(value: string): boolean {
  const trimmed = value.trim();
  return WORKSPACE_DATE_FORMATS.some((option) => option.value === trimmed);
}

function option(value: string): WorkspaceDateFormatOption | null {
  const trimmed = value.trim();
  return (
    WORKSPACE_DATE_FORMATS.find((entry) => entry.value === trimmed) ?? null
  );
}

/** Desktop's label for a stored value, or null when the server sent something else. */
export function workspaceDateFormatLabel(value: string): string | null {
  return option(value)?.label ?? null;
}

/** The sample date for a stored value, or null for an unknown one. */
export function workspaceDateFormatExample(value: string): string | null {
  return option(value)?.example ?? null;
}

/**
 * The line under the picker. An unset column is reported as unset — with the
 * default the server will apply — rather than by silently highlighting the
 * default chip as if someone had chosen it. A value this client does not know
 * is shown verbatim rather than hidden: the server is the authority on what is
 * stored, and pretending it is one of the four would be a lie.
 */
export function workspaceDateFormatSummary(value: string): string {
  const trimmed = value.trim();
  if (trimmed === "") {
    return `Not set — dates render as ${
      workspaceDateFormatExample(WORKSPACE_DATE_FORMAT_DEFAULT) ?? ""
    } until you choose one.`;
  }
  const example = workspaceDateFormatExample(trimmed);
  if (example === null) {
    return `This workspace stores "${trimmed}", which this version of Moosewave does not recognise.`;
  }
  return `Dates render as ${example}.`;
}

/**
 * What (if anything) to PATCH for a chosen format against the saved one.
 *
 * `null` means "unchanged, send nothing" — the endpoint is PATCH-style and an
 * unchanged field is omitted. An unknown value never leaves the phone: it is
 * refused locally with the same sentence the handler would have answered.
 */
export function workspaceDateFormatPatch(
  saved: string,
  next: string,
):
  | { ok: true; value: string | null }
  | { ok: false; message: string } {
  const chosen = next.trim();
  if (chosen === "") {
    // Blank is "leave the column alone" server-side, so there is nothing to
    // send and nothing to refuse.
    return { ok: true, value: null };
  }
  if (!isAllowedWorkspaceDateFormat(chosen)) {
    return { ok: false, message: WORKSPACE_DATE_FORMAT_REJECTED };
  }
  return { ok: true, value: chosen === saved.trim() ? null : chosen };
}
