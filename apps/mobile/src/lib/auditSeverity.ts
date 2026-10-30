/**
 * lib/auditSeverity.ts — the audit log's classification vocabulary.
 *
 * Two cross-client contracts used to live inline in app/(tabs)/audit.tsx,
 * kept in sync with apps/desktop/src/components/audit/AuditSeverity.ts by
 * comment only:
 *
 *   1. Severity classification (destructive / export / auth / ops), the
 *      thing that decides which rows get a coloured Pill.
 *   2. The actor-type chip vocabulary.
 *
 * Both are now here, with tests, because both have already caused a real
 * defect: `portal_session` was once absent from the actor vocabulary, so
 * portal rows showed under "All" and vanished under every other chip.
 * `actor_type` is a free string column on the Go side
 * (apps/api/internal/handlers/audit.go:61 `ActorType string`) — there is
 * no enum keeping this list exhaustive, so the vocabulary MUST have a
 * catch-all. `AUDIT_ACTOR_FILTERS` ends with an "Other" entry that claims
 * exactly what the earlier entries don't; the test asserts the partition
 * property for arbitrary strings.
 */

export type AuditSeverity = "destructive" | "auth" | "export" | "ops";

export const DESTRUCTIVE_TOKENS = [
  "delete",
  "purge",
  "drop",
  "remove",
  "wipe",
  "unsubscribe",
  "suppress",
  "revoke",
  "rotate",
  "disable",
  "archive",
  "destroy",
] as const;

export const EXPORT_TOKENS = ["export", "download", "sar", "dump"] as const;

export const AUTH_TOKENS = [
  "login",
  "logout",
  "signin",
  "signout",
  "mfa",
  "password",
  "token",
  "permission",
  "role",
  "api_key",
  "session",
] as const;

/**
 * Order matters: destructive wins over export which wins over auth. A
 * `subscriber.export.delete` is a deletion first.
 */
export function classifyAction(action: string): AuditSeverity {
  const a = (action || "").toLowerCase();
  if (!a) return "ops";
  if (DESTRUCTIVE_TOKENS.some((tok) => a.includes(tok))) return "destructive";
  if (EXPORT_TOKENS.some((tok) => a.includes(tok))) return "export";
  if (AUTH_TOKENS.some((tok) => a.includes(tok))) return "auth";
  return "ops";
}

export function severityLabel(s: AuditSeverity): string {
  switch (s) {
    case "destructive":
      return "Destructive";
    case "auth":
      return "Auth";
    case "export":
      return "Export";
    default:
      return "Ops";
  }
}

export function severityTone(
  s: AuditSeverity,
): "danger" | "warning" | "info" | "neutral" {
  switch (s) {
    case "destructive":
      return "danger";
    case "auth":
      return "warning";
    case "export":
      return "info";
    default:
      return "neutral";
  }
}

export type AuditActorFilterKey =
  | "all"
  | "user"
  | "api"
  | "agent"
  | "system"
  | "other";

export interface AuditActorFilterDef {
  key: AuditActorFilterKey;
  label: string;
  /**
   * The canonical `actor_type` values this chip claims. Empty for "all"
   * (matches everything) and for "other" (matches the complement).
   */
  wireActorTypes: readonly string[];
}

/**
 * The canonical Go `actor_type` vocabulary emitted by the audit pipeline
 * (apps/api/internal/audit). Human-initiated events surface as
 * user/human/impersonator, plus `portal_session` (an end-subscriber acting
 * through the preference/privacy portal). AI agent activity is first-class
 * so an EU AI Act reviewer can scope to it directly.
 */
const ACTOR_DEFS: readonly AuditActorFilterDef[] = [
  { key: "all", label: "All", wireActorTypes: [] },
  {
    key: "user",
    label: "User",
    wireActorTypes: ["user", "human", "impersonator", "portal_session"],
  },
  { key: "api", label: "API", wireActorTypes: ["api", "api_key"] },
  { key: "agent", label: "Agent", wireActorTypes: ["agent"] },
  {
    key: "system",
    label: "System",
    wireActorTypes: [
      "system",
      "service",
      "automation",
      "slack",
      "partner_app",
    ],
  },
  { key: "other", label: "Other", wireActorTypes: [] },
];

/** Every actor_type claimed by a named chip — computed once. */
const CLAIMED_ACTOR_TYPES: ReadonlySet<string> = new Set(
  ACTOR_DEFS.flatMap((def) => def.wireActorTypes),
);

export const AUDIT_ACTOR_FILTERS: readonly AuditActorFilterDef[] = ACTOR_DEFS;

/**
 * Does `actorType` belong under this chip? "all" matches everything;
 * "other" matches anything no named chip claims — including the empty
 * string, so a row with a missing actor_type is reachable rather than
 * invisible under every chip but All.
 */
export function matchesAuditActor(
  key: AuditActorFilterKey,
  actorType: string | null | undefined,
): boolean {
  if (key === "all") return true;
  const normalized = (actorType ?? "").trim().toLowerCase();
  if (key === "other") return !CLAIMED_ACTOR_TYPES.has(normalized);
  const def = ACTOR_DEFS.find((d) => d.key === key);
  return def ? def.wireActorTypes.includes(normalized) : true;
}

/**
 * The server's `actor_type` filter is exact single-value equality
 * (`AND ($2 = '' OR actor_type = $2)` in handlers/audit.go), so a chip
 * covering several wire values CANNOT be pushed server-side without
 * silently dropping the others. Only single-value chips are safe to send;
 * everything else stays a client-side narrowing over the fetched window.
 */
export function serverActorTypeFor(
  key: AuditActorFilterKey,
): string | undefined {
  const def = ACTOR_DEFS.find((d) => d.key === key);
  if (!def || def.wireActorTypes.length !== 1) return undefined;
  return def.wireActorTypes[0];
}
