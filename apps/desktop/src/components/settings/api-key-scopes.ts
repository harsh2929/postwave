/**
 * api-key-scopes — the canonical API-key scope catalog for the desktop
 * key-management UI, plus pure selection helpers.
 *
 * Mirrors apps/api/internal/apikeys/apikeys.go `AllScopes` (13 scopes:
 * 7 core CRUD + 6 audit:* added by rbac-meta-audit). Keep in sync —
 * the server 400s on unknown scopes at create time.
 *
 * API capability notes (verified against main.go:3133-3140):
 *   - scopes are set at CREATE only — there is no PATCH route, so
 *     scopes cannot be edited on an existing key;
 *   - POST /{id}/rotate revokes + re-mints with the SAME scope set and
 *     returns a fresh plaintext;
 *   - all five key-management routes require the `admin` scope.
 */

export interface ApiKeyScopeInfo {
  id: string;
  /** Short human description rendered next to the checkbox. */
  description: string;
  group: "Core" | "Audit";
  /** Privileged wildcard — render with danger affordance. */
  privileged?: boolean;
}

export const API_KEY_SCOPES: readonly ApiKeyScopeInfo[] = [
  {
    id: "read:subscribers",
    description: "View subscribers, lists, and segments",
    group: "Core",
  },
  {
    id: "write:subscribers",
    description: "Create, update, and delete subscribers",
    group: "Core",
  },
  {
    id: "read:campaigns",
    description: "View campaigns, sequences, and templates",
    group: "Core",
  },
  {
    id: "write:campaigns",
    description: "Create and edit campaigns and sequences",
    group: "Core",
  },
  {
    id: "send:transactional",
    description: "Send transactional email",
    group: "Core",
  },
  {
    id: "read:reports",
    description: "View analytics and reports",
    group: "Core",
  },
  {
    id: "admin",
    description:
      "Everything — wildcard over all scopes, incl. key management, webhooks, domains",
    group: "Core",
    privileged: true,
  },
  {
    id: "audit:read",
    description: "View the audit log (list, stats, search)",
    group: "Audit",
  },
  {
    id: "audit:read_pii",
    description: "See PII columns in audit rows (IP, user agent)",
    group: "Audit",
  },
  {
    id: "audit:read_all_tenants",
    description: "Cross-tenant audit read (operator role)",
    group: "Audit",
  },
  {
    id: "audit:configure_sinks",
    description: "Manage audit sinks and evidence-export schedules",
    group: "Audit",
  },
  {
    id: "audit:configure_retention",
    description: "Set per-tenant audit retention",
    group: "Audit",
  },
  {
    id: "audit:execute_actions",
    description: "Trigger destructive audit operations",
    group: "Audit",
  },
];

export const API_KEY_SCOPE_GROUPS: ReadonlyArray<"Core" | "Audit"> = [
  "Core",
  "Audit",
];

/** Immutable toggle — returns a new array with `scope` added/removed. */
export function toggleScope(selected: readonly string[], scope: string): string[] {
  return selected.includes(scope)
    ? selected.filter((s) => s !== scope)
    : [...selected, scope];
}

/**
 * Pre-flight validation for the create form. Returns null when
 * sendable, else inline error copy.
 */
export function validateKeyDraft(
  label: string,
  scopes: readonly string[],
): string | null {
  if (!label.trim()) return "A label is required.";
  if (scopes.length === 0) return "Pick at least one scope.";
  return null;
}

/**
 * Display summary for a key row's scope set: "admin" wins (wildcard),
 * otherwise up to `max` ids then "+N more".
 */
export function scopesSummary(scopes: readonly string[], max = 3): string {
  if (scopes.length === 0) return "no scopes";
  if (scopes.includes("admin")) return "admin (all scopes)";
  if (scopes.length <= max) return scopes.join(", ");
  return `${scopes.slice(0, max).join(", ")} +${scopes.length - max} more`;
}
