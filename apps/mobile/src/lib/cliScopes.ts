/**
 * cliScopes — what a CLI device grant actually gets, by workspace role.
 *
 * The device-approval screen used to say only "A device is asking to sign in
 * to your workspace with this code". That tap mints a durable API key, so a
 * consent screen that does not say what it grants is not consent.
 *
 * The web console lists four hardcoded scope lines — which is itself wrong for
 * viewers and editors, because the server derives the grant from the approving
 * principal's role: `cliScopesForPrincipal` in
 * apps/api/internal/auth/cli_auth.go returns `cliReadScopes` for viewer,
 * `cliEditorScopes` for editor and `cliAdminScopes` for admin/owner, and
 * refuses entirely for anything else. This module mirrors that mapping exactly
 * so the phone shows the truth rather than a second lie — and
 * `scopeDisclosure` prefers the `scopes` array the approve response actually
 * returns, so the post-approval screen is authoritative rather than a guess.
 */

export const CLI_READ_SCOPES = [
  "read:subscribers",
  "read:campaigns",
  "read:reports",
] as const;

export const CLI_EDITOR_SCOPES = [
  "read:subscribers",
  "write:subscribers",
  "read:campaigns",
  "write:campaigns",
  "read:reports",
] as const;

export const CLI_ADMIN_SCOPES = [
  "read:subscribers",
  "write:subscribers",
  "read:campaigns",
  "write:campaigns",
  "read:reports",
  "send:transactional",
] as const;

/** Plain-language line for each scope the server can grant. */
const SCOPE_COPY: Record<string, string> = {
  "read:subscribers": "Read your subscribers and segments",
  "write:subscribers": "Add, edit and suppress subscribers",
  "read:campaigns": "Read your campaigns and templates",
  "write:campaigns": "Create and edit campaigns",
  "read:reports": "Read delivery and engagement reports",
  "send:transactional": "Send transactional email as your workspace",
};

export type CliScopeRole = "viewer" | "editor" | "admin" | "owner" | "unknown";

/**
 * Narrow a session role string the same way the server does before deriving
 * scopes. Anything unrecognised is "unknown" — the server refuses those with
 * `insufficient_role`, so the screen must not promise a grant.
 */
export function normalizeCliScopeRole(
  role: string | null | undefined,
): CliScopeRole {
  const value = (role ?? "").trim().toLowerCase();
  if (value === "viewer" || value === "member") return "viewer";
  if (value === "editor") return "editor";
  if (value === "admin") return "admin";
  if (value === "owner") return "owner";
  return "unknown";
}

/** The scopes the server WILL grant for this role, or [] when it will refuse. */
export function cliScopesForRole(role: string | null | undefined): string[] {
  switch (normalizeCliScopeRole(role)) {
    case "viewer":
      return [...CLI_READ_SCOPES];
    case "editor":
      return [...CLI_EDITOR_SCOPES];
    case "admin":
    case "owner":
      return [...CLI_ADMIN_SCOPES];
    default:
      return [];
  }
}

/**
 * Editor/admin/owner grants are step-up protected server-side: the durable
 * credential outlives the browser session, so `cliScopesForPrincipal` returns
 * `errCLIMFARequired` unless the session is already `mfa_satisfied`. Viewers
 * are read-only and exempt.
 */
export function cliGrantNeedsStepUp(
  role: string | null | undefined,
  mfaSatisfied: boolean,
): boolean {
  if (mfaSatisfied) return false;
  const normalized = normalizeCliScopeRole(role);
  return (
    normalized === "editor" || normalized === "admin" || normalized === "owner"
  );
}

export interface ScopeLine {
  scope: string;
  label: string;
  /** True for grants that can change or send data, not merely read it. */
  write: boolean;
}

/**
 * Render-ready disclosure lines. Pass the server-returned `scopes` once the
 * grant has been approved; pass the role-derived set beforehand.
 */
export function scopeDisclosure(scopes: readonly string[]): ScopeLine[] {
  const seen = new Set<string>();
  const lines: ScopeLine[] = [];
  for (const raw of scopes) {
    const scope = typeof raw === "string" ? raw.trim() : "";
    if (!scope || seen.has(scope)) continue;
    seen.add(scope);
    lines.push({
      scope,
      label: SCOPE_COPY[scope] ?? scope,
      write: !scope.startsWith("read:"),
    });
  }
  return lines;
}

/** One-line summary used as the screen's accessibility announcement. */
export function scopeSummary(scopes: readonly string[]): string {
  const lines = scopeDisclosure(scopes);
  if (lines.length === 0) {
    return "Your workspace role cannot authorize a CLI device.";
  }
  return `This grants ${lines.length} permission${
    lines.length === 1 ? "" : "s"
  }: ${lines.map((line) => line.label.toLowerCase()).join(", ")}.`;
}

/**
 * Normalise the `user_code` a user types by hand. The device grant exists for
 * headless boxes over SSH where there is no QR to scan, so the code has to be
 * enterable: uppercase, strip everything that is not alphanumeric, cap at the
 * 8 significant characters, then re-insert the hyphen. Mirrors the web
 * console's `normalizeDeviceCode`.
 */
export function normalizeDeviceCode(raw: string): string {
  const cleaned = (raw ?? "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 8);
  if (cleaned.length <= 4) return cleaned;
  return `${cleaned.slice(0, 4)}-${cleaned.slice(4)}`;
}

export const DEVICE_CODE_RE = /^[A-Z0-9]{4}-[A-Z0-9]{4}$/;

export function isValidDeviceCode(code: string): boolean {
  return DEVICE_CODE_RE.test(code);
}
