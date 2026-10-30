/**
 * lib/auditAlertPolicy.ts — the DECISIONS the audit-alert surface makes over
 * the rules that `lib/auditAlertRules.ts` parses and describes.
 *
 * The seam is deliberate rather than merely mechanical (the file crossed its
 * 450-line source budget, and splitting it was the required fix): the sibling
 * module is a WIRE + DESCRIBE layer — it knows the Go struct, the envelope and
 * how to render a rule in words. This module knows POLICY — what order the
 * roster is in, who may pause a rule, what the confirm sheet says, and what a
 * failure means. Adding a new channel kind touches one file; changing who may
 * pause a rule touches the other.
 *
 * DELIBERATELY IMPORT-FREE of react-native / expo, like its sibling, so both
 * run in the node vitest environment.
 */
import { pathLabel } from "@/lib/direction";
import {
  channelLabel,
  ruleHealth,
  type AuditAlertHealth,
  type AuditAlertRule,
} from "@/lib/auditAlertRules";

/**
 * List order: what is broken, then what is watching, then what is off.
 *
 * The server returns `created_at DESC` — chronological by authoring date, which
 * is the one ordering that never matches why anyone opens this screen. Within a
 * health band the most recently fired rule comes first (a rule that fired ten
 * minutes ago is the live story); rules that have never fired sort after the
 * ones that have, and ties break on name so the order is stable across renders.
 */
const HEALTH_RANK: Readonly<Record<AuditAlertHealth, number>> = {
  failing: 0,
  active: 1,
  paused: 2,
};

export function orderAuditAlertRules(
  rules: readonly AuditAlertRule[],
): AuditAlertRule[] {
  return [...rules].sort((a, b) => {
    const health = HEALTH_RANK[ruleHealth(a)] - HEALTH_RANK[ruleHealth(b)];
    if (health !== 0) return health;
    const at = a.lastFiredAt ? Date.parse(a.lastFiredAt) : Number.NaN;
    const bt = b.lastFiredAt ? Date.parse(b.lastFiredAt) : Number.NaN;
    const aMissing = Number.isNaN(at);
    const bMissing = Number.isNaN(bt);
    if (aMissing !== bMissing) return aMissing ? 1 : -1;
    if (!aMissing && !bMissing && at !== bt) return bt - at;
    return a.name.localeCompare(b.name);
  });
}

/**
 * A rule that has never fired is the interesting case, and nothing else on this
 * screen says so.
 *
 * `enabled` answers "is it switched on" and `last_error` answers "did the last
 * delivery work". Neither answers the question an on-call engineer actually
 * has, which is whether the detection is CONNECTED TO REALITY. A rule watching
 * `subscribers.export*` that has been enabled for three weeks with zero fires
 * is either a quiet workspace or a glob that matches nothing — and the second
 * is a control that silently does not exist.
 *
 * ABSENCE IS NOT ZERO, so every claim below is dated. A rule whose `created_at`
 * did not survive the wire produces NO attention note at all rather than a
 * guess: "never fired" is only meaningful next to "and it has been N days".
 */
const DAY_MS = 24 * 60 * 60 * 1000;
export const AUDIT_ALERT_SILENT_AFTER_DAYS = 14;
export const AUDIT_ALERT_DORMANT_AFTER_DAYS = 30;

export type AuditAlertAttentionKind = "never_fired" | "dormant";

export interface AuditAlertAttention {
  kind: AuditAlertAttentionKind;
  /** The visible pill word. */
  label: string;
  tone: "warning" | "neutral";
  /** The sentence a screen reader gets, including what it does NOT prove. */
  spoken: string;
}

function daysBetween(iso: string, now: number): number | null {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return null;
  return Math.floor((now - at) / DAY_MS);
}

export function ruleAttention(
  rule: AuditAlertRule,
  now: number,
): AuditAlertAttention | null {
  // A paused rule is not quiet, it is off, and the health pill already says so.
  // A failing rule's error is the louder story and owns the row.
  if (!rule.enabled || ruleHealth(rule) === "failing") return null;

  if (!rule.lastFiredAt) {
    if (!rule.createdAt) return null;
    const age = daysBetween(rule.createdAt, now);
    if (age === null || age < AUDIT_ALERT_SILENT_AFTER_DAYS) return null;
    return {
      kind: "never_fired",
      label: "Never fired",
      tone: "warning",
      spoken: `Enabled for ${age} days and has never fired. That may mean nothing matched it, or that it matches nothing.`,
    };
  }

  const since = daysBetween(rule.lastFiredAt, now);
  if (since === null || since < AUDIT_ALERT_DORMANT_AFTER_DAYS) return null;
  return {
    kind: "dormant",
    label: "No recent fires",
    tone: "neutral",
    spoken: `Last fired ${since} days ago. Quiet is not the same as broken, but nothing has matched it for a month.`,
  };
}

export interface AuditAlertCounts {
  total: number;
  enabled: number;
  failing: number;
  /** Enabled, delivering, and yet nothing has matched it — see ruleAttention. */
  quiet: number;
}

export function auditAlertCounts(
  rules: readonly AuditAlertRule[],
  now: number = Date.now(),
): AuditAlertCounts {
  let enabled = 0;
  let failing = 0;
  let quiet = 0;
  for (const rule of rules) {
    if (rule.enabled) enabled += 1;
    if (ruleHealth(rule) === "failing") failing += 1;
    if (ruleAttention(rule, now) !== null) quiet += 1;
  }
  return { total: rules.length, enabled, failing, quiet };
}

/**
 * The `GET /api/v1/audit/my-scopes` answer, declared structurally.
 *
 * Declared here rather than imported from `hooks/useAudit` on purpose: that
 * module reaches `@/lib/connectivity` → `@react-native-community/netinfo`, and
 * importing it would make this file unloadable in the node vitest environment.
 * The shape is `handlers.MyScopesResponse` (audit_rbac.go:50).
 */
export interface AuditAlertScopeSet {
  /** Every scope on the request context. */
  scopes: readonly string[];
  /** The `audit:` subset of the same list. */
  auditScopes: readonly string[];
  /**
   * API-key auth: the key carries `admin`. Session auth: the workspace role is
   * owner or admin (MyScopes overwrites the flag from `u.Role` on that path).
   */
  isAdmin: boolean;
}

/** `useAuthStore(s => s.mode)`. The two gates below differ by it. */
export type AuditAlertAuthMode = "session" | "api_key" | null | undefined;

export interface AuditAlertToggleAccessInput {
  /** `useAuditScopes().data`. `null`/`undefined` = the answer has not arrived. */
  scopes: AuditAlertScopeSet | null | undefined;
  mode: AuditAlertAuthMode;
  /** The online gate: a governance write is never queued for later. */
  online: boolean;
}

export interface AuditAlertToggleAccess {
  allowed: boolean;
  /**
   * False while the scope answer is still in flight. A screen must not render
   * a permission verdict it has not received — "you may not do this" and "I do
   * not know yet" are different sentences.
   */
  known: boolean;
  /** Copy explaining the denial, or null when nothing is denied. */
  notice: string | null;
}

const CONFIGURE_SINKS = "audit:configure_sinks";
const AUDIT_READ = "audit:read";
const READ_REPORTS = "read:reports";

function hasScope(set: readonly string[], scope: string): boolean {
  return set.includes(scope);
}

/**
 * May this actor pause or resume a rule?
 *
 * TWO SERVER GATES STACK, and modelling only one of them is how this screen
 * would end up offering a button that always 403s. Both were read off the Go
 * source; neither was taken from a doc comment.
 *
 *   1. `routeauth.Middleware` (`authorizeRoute`, wired at main.go:2265 and
 *      applied to the whole authenticated router by
 *      authenticated_route_stack.go:38) evaluates the generated manifest row
 *      BEFORE the handler chain. For `PATCH /api/v1/audit-alerts/{id}` that row
 *      is `session_minimum_role: "admin"`, `api_key_scopes: ["admin"]`. On the
 *      session path it calls `roleAllows(role, "admin")` — owner/admin only,
 *      and a custom role's stored grants cannot reach it. On the API-key path
 *      it calls `hasAnyScope(["admin"])`, so nothing but the `admin` scope
 *      satisfies it — `audit:configure_sinks` alone does NOT.
 *   2. `apikeys.RequireScope(apikeys.ScopeAuditConfigureSinks)` on the mount
 *      itself (audit_alerts.go:112,115) then requires the scope to be present
 *      on the context. For a session that context is populated by
 *      `auditRBACSessionScopes`, which is the very same set `my-scopes`
 *      reports — so `auditScopes` here is exactly what the gate will see.
 *
 * Hence: API-key callers need `admin`; session callers need owner/admin AND
 * `audit:configure_sinks` in their resolved scopes. The second half is not
 * redundant — a tenant that has edited the `admin` role's `roles_permissions`
 * row (the Settings → Roles matrix writes it) can leave an admin holding
 * `audit:read` only, and `defaultAuditScopesForRole`'s full grant applies only
 * when NO roles row exists.
 *
 * PERMISSION IS CHECKED BEFORE CONNECTIVITY, deliberately: reconnecting will
 * not grant a viewer the ability to pause an alert, and telling them to try
 * again later would be a lie.
 */
export function auditAlertToggleAccess(
  input: AuditAlertToggleAccessInput,
): AuditAlertToggleAccess {
  const scopes = input.scopes;
  if (!scopes) {
    return { allowed: false, known: false, notice: null };
  }
  if (!scopes.isAdmin) {
    return {
      allowed: false,
      known: true,
      notice:
        input.mode === "api_key"
          ? "Changing alert rules — pausing, creating, deleting — needs an API key with the admin scope. This key can read every rule here."
          : "Changing alert rules — pausing, creating, deleting — needs an owner or admin role on this workspace. You can read every rule here.",
    };
  }
  // An API key with `admin` satisfies both gates outright; there is no second
  // scope to check, because `admin` is a wildcard inside `HasScope`.
  if (input.mode !== "api_key" && !hasScope(scopes.auditScopes, CONFIGURE_SINKS)) {
    return {
      allowed: false,
      known: true,
      notice: `Your role has not been granted the audit:configure_sinks scope, so the server will refuse any alert-rule change. A workspace owner can grant it under ${pathLabel(
        ["Settings", "Roles"],
      )}.`,
    };
  }
  if (!input.online) {
    return {
      allowed: false,
      known: true,
      notice:
        "You're offline. Alert-rule changes are never queued for later — a governance change replayed out of context is worse than one that failed now.",
    };
  }
  return { allowed: true, known: true, notice: null };
}

/**
 * The one authorization fact `hasAuditReadScope` cannot express.
 *
 * The read verdict itself is `hooks/useAudit`'s `hasAuditReadScope`, exactly as
 * `app/(tabs)/audit.tsx` uses it, because the handler gate is the same
 * `RequireScope(ScopeAuditRead)`. But the generated manifest row for
 * `GET /api/v1/audit-alerts` is `api_key_scopes: ["read:reports"]` — an
 * auto-generated `safe-default:read` that `routeauth.Middleware` nonetheless
 * ENFORCES ahead of the handler. So an API key holding `audit:read` but neither
 * `read:reports` nor `admin` passes every check this screen can see and is then
 * refused by the router.
 *
 * Returns a caveat rather than a denial: the gate that decides whether to show
 * the roster stays the proven one, and this only explains a 403 the user would
 * otherwise meet as "something went wrong". Session callers are unaffected —
 * that manifest row's session floor is `viewer`.
 */
export function auditAlertReadCaveat(input: {
  scopes: AuditAlertScopeSet | null | undefined;
  mode: AuditAlertAuthMode;
}): string | null {
  const scopes = input.scopes;
  if (!scopes || input.mode !== "api_key") return null;
  if (scopes.isAdmin) return null;
  if (hasScope(scopes.scopes, READ_REPORTS)) return null;
  // Reaching my-scopes at all means the key already holds audit:read, so the
  // missing piece is unambiguous.
  const held = hasScope(scopes.auditScopes, AUDIT_READ)
    ? "This API key has audit:read"
    : "This API key";
  return `${held} but not read:reports, and the route policy for /api/v1/audit-alerts requires it. The list will be refused until the key is granted read:reports.`;
}

export interface AuditAlertToggleCopy {
  title: string;
  message: string;
  consequence: string;
  confirmLabel: string;
  destructive: boolean;
}

/**
 * Confirmation copy for the one write this screen offers.
 *
 * Pausing is the destructive direction and it is silent: nothing else in the
 * product announces that a detection stopped watching, and the worker simply
 * skips disabled rules. The consequence line says so in those terms rather
 * than as "are you sure?".
 */
export function toggleCopy(rule: AuditAlertRule): AuditAlertToggleCopy {
  if (rule.enabled) {
    return {
      title: `Pause “${rule.name}”?`,
      message:
        "The rule stops watching the audit log immediately. Events that match while it is paused are not queued — they are simply never alerted on.",
      consequence: `Nobody is notified about ${rule.actionGlob || "these events"} until it is resumed.`,
      confirmLabel: "Pause",
      destructive: true,
    };
  }
  return {
    title: `Resume “${rule.name}”?`,
    message:
      "The rule starts watching new audit events again. It resumes from where its cursor stopped, so a long pause can deliver a burst of alerts at once.",
    consequence: `${channelLabel(rule.channelKind)} delivery starts again.`,
    confirmLabel: "Resume",
    destructive: false,
  };
}

export function toggleSuccessMessage(
  rule: AuditAlertRule,
  nextEnabled: boolean,
): string {
  return nextEnabled
    ? `Resumed “${rule.name}”.`
    : `Paused “${rule.name}”. It is no longer watching.`;
}

function statusOf(error: unknown): number {
  if (error && typeof error === "object" && "status" in error) {
    const status = (error as { status?: unknown }).status;
    if (typeof status === "number") return status;
  }
  return 0;
}

/**
 * Failure copy for the toggle. 403 is the interesting one: the server answers
 * `insufficient_scope` when the session role lacks `audit:configure_sinks` and
 * `insufficient_role` when it has the scope but not the role — both arrive as a
 * 403 and both mean the same thing to the person holding the phone.
 */
export function auditAlertErrorMessage(error: unknown): string {
  const status = statusOf(error);
  if (status === 403) {
    return "Your role no longer allows changing alert rules. Ask an admin.";
  }
  if (status === 404) return "That rule no longer exists.";
  if (status === 401) return "Your session expired. Sign in again.";
  if (status === 0) {
    return "The change didn't reach the server. Check your connection and try again.";
  }
  if (error instanceof Error && error.message) return error.message;
  return "Please try again.";
}

/**
 * What still stays on desktop, and why.
 *
 * CREATE and DELETE now live here (the create sheet mirrors every server
 * validator and sends credentials write-only), so the old "no create form to
 * rebuild with" objection is gone. What remains desktop-only is EDITING an
 * existing rule's channel_config — the server redacts it on every read, so an
 * edit form here could only show blank credential fields and re-writing them
 * blind is a mis-edit factory — and the
 * `/api/v1/audit-alerts/{jira,pagerduty,servicenow}/auth` VERIFICATION posts,
 * which prove a typed credential against the external system before it is
 * trusted; that check belongs where the credential was configured.
 */
/**
 * The genuinely-empty roster's copy. Split by whether the reader may create:
 * an admin is pointed at the on-screen verb; anyone else at an admin — never
 * at a desk, since the create form now lives here too.
 */
export function auditAlertEmptyCopy(canManage: boolean): {
  title: string;
  description: string;
} {
  return {
    title: "No alert rules",
    description: canManage
      ? "Nothing is watching the audit log. Create a rule with New rule above — it starts watching new events immediately."
      : "Nothing is watching the audit log. A workspace admin can create rules here or on desktop.",
  };
}

export const AUDIT_ALERT_CONFIG_NOTICE =
  "Create, pause, resume or delete rules here. Editing an existing rule's delivery credentials — and verifying Jira, PagerDuty or ServiceNow credentials — stays on desktop.";
