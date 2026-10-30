/**
 * lib/auditViews.ts — named filter sets for the audit log, and the Security
 * lens that sits beside them.
 *
 * Import-free (node-testable) on purpose, like lib/auditGrouping and
 * lib/auditSeverity: everything here is a decision about what a filter set
 * MEANS, and those have to be assertable without mounting a screen.
 *
 * THE HARD PART IS NOT THE UI, IT IS THE BLOB.
 *
 * `GET/POST /api/v1/audit/saved-views` (apps/api/internal/handlers/
 * audit_extras.go:200/:244) stores `filters` as an OPAQUE jsonb map. The
 * server never validates it, so whatever a client writes is exactly what
 * every other client reads back. Desktop already ships this feature and
 * writes ITS filter vocabulary (apps/desktop/src/pages/audit/
 * AuditFilterPanels.tsx:20-27):
 *
 *     { actorType, actorLabel, actionQuery, resourceType, resourceId,
 *       days, category }
 *
 * — where `days` is a plain number (1 | 7 | 30 | 90 | 0 for All, see the
 * DAY_CHIPS table in components/audit/AuditFilters.tsx) and `category` is one
 * of all | destructive | auth | export | one_click.
 *
 * Mobile's controls are NOT the same set (it has a 24h window desktop lacks,
 * and no actorLabel/resource inputs), so a naive port would either write a
 * blob desktop silently ignores or read one it cannot honour. Both would make
 * "the views you saved" a lie on one of the two clients.
 *
 * So every mobile view is written TWICE into the one blob:
 *
 *   1. The desktop-compatible keys, best-effort. A view saved on a phone
 *      opens on the desktop with the right actor, window and category.
 *   2. A namespaced `postwaveMobile` object holding the exact chip identity.
 *      Decoding prefers it, so a mobile→mobile round trip is lossless even
 *      where the desktop projection had to approximate.
 *
 * The one deliberate approximation, stated because it is a real lossy edge:
 * mobile's SECURITY lens has no desktop equivalent. It projects onto
 * desktop's `category: "auth"`, which is the nearest neighbour (desktop's auth
 * category is login/logout/MFA/password/token/permission/role). Reading a
 * desktop view with `category: "auth"` therefore turns the Security lens on.
 * That is a superset, not a different answer, and `describeAuditView` names
 * it so nobody reads an approximation as an exact recall.
 */
import type { AuditWindowKey } from "./auditGrouping";
import type { AuditActorFilterKey } from "./auditSeverity";

/**
 * The security slice of the audit stream, kept token-for-token in step with
 * apps/web's SECURITY_KEYWORDS (settings/security/security-activity-card.tsx:
 * 25-39) so the same event is "security" on both clients. Web inlines the top
 * matches next to the security controls; mobile makes it a lens over the full
 * log. Divergence here would mean the two products disagree about what
 * counts as a security event, which is exactly the kind of quiet
 * inconsistency an auditor catches and a changelog never mentions.
 */
export const SECURITY_ACTION_KEYWORDS = [
  "login",
  "logout",
  "session",
  "totp",
  "2fa",
  "mfa",
  "password",
  "oauth",
  "sso",
  "scim",
  "security",
  "token",
  "role",
  "device",
] as const;

/** Is this audit action part of the security slice? */
export function isSecurityAction(action: string | null | undefined): boolean {
  const a = (action ?? "").toLowerCase();
  if (!a) return false;
  return SECURITY_ACTION_KEYWORDS.some((kw) => a.includes(kw));
}

/** Everything the audit screen's narrowing controls hold. */
export interface AuditViewState {
  actor: AuditActorFilterKey;
  windowKey: AuditWindowKey;
  destructiveOnly: boolean;
  securityOnly: boolean;
  query: string;
}

export const DEFAULT_AUDIT_VIEW: AuditViewState = {
  actor: "all",
  windowKey: "7d",
  destructiveOnly: false,
  securityOnly: false,
  query: "",
};

/** Mirrors handlers.AuditSavedView (camelCase JSON tags). */
export interface AuditSavedView {
  id: string;
  name: string;
  description?: string;
  filters: Record<string, unknown>;
  createdAt?: string;
  updatedAt?: string;
  createdBy?: string | null;
}

/** Desktop's `days` number for a mobile window chip. 0 is its "All". */
function windowToDays(key: AuditWindowKey): number {
  switch (key) {
    case "24h":
      return 1;
    case "7d":
      return 7;
    case "30d":
      return 30;
    default:
      return 0;
  }
}

/**
 * Desktop's `days` back to the nearest mobile window. Desktop offers 90d,
 * which mobile does not — it lands on "all" rather than silently pretending
 * a 90-day view is a 30-day one, because under-reporting a window makes a
 * log look emptier than it is.
 */
function daysToWindow(days: number): AuditWindowKey {
  if (days === 1) return "24h";
  if (days === 7) return "7d";
  if (days === 30) return "30d";
  return "all";
}

const MOBILE_BLOB_KEY = "postwaveMobile";

/**
 * The blob to POST. Both projections, always — a mobile-only blob would be
 * unreadable on desktop and a desktop-only one would lose the 24h window and
 * the Security lens.
 */
export function encodeAuditView(
  state: AuditViewState,
  serverActorType: string | undefined,
): Record<string, unknown> {
  const category = state.destructiveOnly
    ? "destructive"
    : state.securityOnly
      ? "auth"
      : "all";
  return {
    // Desktop vocabulary.
    actorType: serverActorType ?? "",
    actorLabel: "",
    actionQuery: state.query.trim(),
    resourceType: "",
    resourceId: "",
    days: windowToDays(state.windowKey),
    category,
    // Mobile's exact chip identity.
    [MOBILE_BLOB_KEY]: {
      actor: state.actor,
      window: state.windowKey,
      destructiveOnly: state.destructiveOnly,
      securityOnly: state.securityOnly,
      query: state.query.trim(),
    },
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

const ACTOR_KEYS: readonly AuditActorFilterKey[] = [
  "all",
  "user",
  "api",
  "agent",
  "system",
  "other",
];

const WINDOW_KEYS: readonly AuditWindowKey[] = ["24h", "7d", "30d", "all"];

/**
 * Map a wire `actor_type` onto the chip that claims it. Only the
 * single-value chips are recoverable (they are the only ones the server
 * filter can express); anything else falls back to "all" rather than
 * guessing, because a chip that silently drops rows is the failure mode
 * lib/auditSeverity already documents.
 */
function actorKeyForWireType(wire: string): AuditActorFilterKey {
  switch (wire) {
    case "agent":
      return "agent";
    default:
      return "all";
  }
}

/**
 * Read a stored blob back into screen state. Tolerant by construction: the
 * column is opaque jsonb written by two clients and three schema eras, so
 * every field is validated independently and an unreadable one falls back to
 * its default instead of taking the whole view down.
 */
export function decodeAuditView(
  filters: unknown,
  base: AuditViewState = DEFAULT_AUDIT_VIEW,
): AuditViewState {
  const blob = asRecord(filters);
  if (!blob) return { ...base };
  const out: AuditViewState = { ...base };

  // Desktop projection first…
  if (typeof blob.days === "number" && Number.isFinite(blob.days)) {
    out.windowKey = daysToWindow(blob.days);
  }
  if (typeof blob.actionQuery === "string") out.query = blob.actionQuery;
  if (typeof blob.actorType === "string" && blob.actorType) {
    out.actor = actorKeyForWireType(blob.actorType.trim().toLowerCase());
  }
  if (typeof blob.category === "string") {
    out.destructiveOnly = blob.category === "destructive";
    out.securityOnly = blob.category === "auth";
  }

  // …then mobile's exact identity wins where present.
  const mine = asRecord(blob[MOBILE_BLOB_KEY]);
  if (mine) {
    if (
      typeof mine.actor === "string" &&
      (ACTOR_KEYS as readonly string[]).includes(mine.actor)
    ) {
      out.actor = mine.actor as AuditActorFilterKey;
    }
    if (
      typeof mine.window === "string" &&
      (WINDOW_KEYS as readonly string[]).includes(mine.window)
    ) {
      out.windowKey = mine.window as AuditWindowKey;
    }
    if (typeof mine.destructiveOnly === "boolean") {
      out.destructiveOnly = mine.destructiveOnly;
    }
    if (typeof mine.securityOnly === "boolean") {
      out.securityOnly = mine.securityOnly;
    }
    if (typeof mine.query === "string") out.query = mine.query;
  }
  return out;
}

/** Was this blob written by a mobile client (i.e. is the recall exact)? */
export function isNativeAuditView(filters: unknown): boolean {
  const blob = asRecord(filters);
  return Boolean(blob && asRecord(blob[MOBILE_BLOB_KEY]));
}

/** Do two filter sets describe the same view? Drives the "active" chip. */
export function auditViewsEqual(a: AuditViewState, b: AuditViewState): boolean {
  return (
    a.actor === b.actor &&
    a.windowKey === b.windowKey &&
    a.destructiveOnly === b.destructiveOnly &&
    a.securityOnly === b.securityOnly &&
    a.query.trim() === b.query.trim()
  );
}

const WINDOW_WORDS: Record<AuditWindowKey, string> = {
  "24h": "24 hours",
  "7d": "7 days",
  "30d": "30 days",
  all: "all history",
};

const ACTOR_WORDS: Record<AuditActorFilterKey, string> = {
  all: "",
  user: "user actions",
  api: "API-key actions",
  agent: "agent actions",
  system: "system actions",
  other: "uncategorised actors",
};

/**
 * A one-line description of what a view will show, used as the subtitle on
 * the saved-view row. `approximate` is true when the blob came from another
 * client and mobile had to project it — the reader is told, rather than
 * being shown an approximation dressed as an exact recall.
 */
export function describeAuditView(
  state: AuditViewState,
  approximate = false,
): string {
  const parts: string[] = [WINDOW_WORDS[state.windowKey]];
  if (ACTOR_WORDS[state.actor]) parts.push(ACTOR_WORDS[state.actor]);
  if (state.destructiveOnly) parts.push("destructive only");
  if (state.securityOnly) parts.push("security only");
  if (state.query.trim()) parts.push(`matching “${state.query.trim()}”`);
  const body = parts.join(" · ");
  return approximate ? `${body} · adapted from another device` : body;
}

export const AUDIT_VIEW_NAME_MAX = 60;

/**
 * Validate a name before POSTing. The server rejects a blank name with 400
 * `missing_name` (audit_extras.go:257) but has no uniqueness constraint, so
 * duplicate detection is a client courtesy — two identically named chips are
 * indistinguishable once saved and there is no rename affordance on a phone.
 */
export function savedViewNameError(
  name: string,
  existingNames: readonly string[],
): string | null {
  const trimmed = name.trim();
  if (!trimmed) return "Give the view a name.";
  if (trimmed.length > AUDIT_VIEW_NAME_MAX) {
    return `Keep the name under ${AUDIT_VIEW_NAME_MAX} characters.`;
  }
  const clash = existingNames.some(
    (existing) => existing.trim().toLowerCase() === trimmed.toLowerCase(),
  );
  return clash ? "A view with that name already exists." : null;
}

function viewStamp(view: AuditSavedView): number | null {
  const raw = Date.parse(view.updatedAt ?? view.createdAt ?? "");
  return Number.isFinite(raw) ? raw : null;
}

/**
 * Newest-updated first, matching the server's `ORDER BY updated_at DESC`
 * (audit_extras.go:217). Re-sorted client-side rather than trusted, because
 * the list is merged with rows the screen has only just created.
 *
 * A row with NO parseable timestamp sorts LAST, not first. The tempting
 * comparator — compare stamps only when both parse, else compare names —
 * is not a total order: it makes the result depend on the input order, which
 * is how an undated row ends up claiming to be the most recent thing in the
 * list. Unknown age is unknown, so it goes to the bottom and is ordered by
 * name among its own kind.
 */
export function sortSavedViews(
  views: readonly AuditSavedView[],
): AuditSavedView[] {
  return [...views].sort((a, b) => {
    const at = viewStamp(a);
    const bt = viewStamp(b);
    if (at !== null && bt !== null) {
      if (at !== bt) return bt - at;
    } else if (at !== null) {
      return -1;
    } else if (bt !== null) {
      return 1;
    }
    return a.name.localeCompare(b.name);
  });
}
