/**
 * lib/auditSavedViewPolicy.ts — who may CREATE or DELETE a saved audit view.
 *
 * ── THE DIVERGENCE THIS EXISTS TO CLOSE ────────────────────────────────────
 * Reading and writing saved views look like one permission and are two, and the
 * two gates disagree. Every saved-view route is mounted behind the SAME
 * mount-site wrapper — `apikeys.RequireScope(apikeys.ScopeAuditRead)`
 * (apps/api/internal/server/audit_operations.go:43-46) — which is why the first
 * implementation gated the whole bar on `hasAuditReadScope` and called it done.
 *
 * But apps/api authorises TWICE. `routeauth.Middleware` is applied to the whole
 * authenticated group (`router.Use(s.authorizeRoute)`,
 * internal/server/authenticated_route_stack.go:38, wired at main.go:2372) and
 * independently evaluates internal/routeauth/manifest.json, where the rows read:
 *
 *   GET    /api/v1/audit/saved-views       session_minimum_role: viewer
 *   POST   /api/v1/audit/saved-views       session_minimum_role: admin
 *   PATCH  /api/v1/audit/saved-views/{id}  session_minimum_role: admin
 *   DELETE /api/v1/audit/saved-views/{id}  session_minimum_role: admin
 *
 * All four rows are `"review_status": "reviewed"`, so this is a deliberate
 * policy and not an auto-generated default. The effective floor is the STRICTER
 * of the two gates, so an editor or viewer holding `audit:read` could list
 * views, was offered "Save current" and "Delete", and could only ever receive
 * `403 insufficient_role` from routeauth/middleware.go:60.
 *
 * An affordance that can only fail is worse than a missing one: it teaches the
 * operator that the product is broken rather than that they lack a permission.
 *
 * ── WHY `isAdmin` AND NOT THE CACHED ROLE ──────────────────────────────────
 * `GET /api/v1/audit/my-scopes` computes `isAdmin` as `role ∈ {owner, admin}`
 * (internal/handlers/audit_rbac.go:79-84) — exactly the set
 * `roleAllows(actual, "admin")` accepts, since its rank table is
 * viewer/member=1 < editor=2 < admin=3 < owner=4 (routeauth/middleware.go:94).
 * It is the server's own answer about the live session, so it cannot drift from
 * a stale cached role the way a client-side rank comparison can.
 *
 * ── THE API-KEY BRANCH IS A DIFFERENT QUESTION ─────────────────────────────
 * For `auth_methods: api_key`, routeauth checks `api_key_scopes:
 * ["audit:execute_actions"]` with mode `any` and never looks at a role — and
 * `apikeys.HasScope` treats `ScopeAdmin` as a wildcard over everything
 * (internal/apikeys/middleware.go:91-93). So a key needs `audit:execute_actions`
 * OR `admin`, and applying the session's admin-role test to it would refuse a
 * key the server would have accepted.
 *
 * Import-free of react-native/expo, so every rule above is unit-tested under
 * node.
 */

/** The `GET /api/v1/audit/my-scopes` answer, as `useAuditScopes` shapes it. */
export interface AuditViewScopeSet {
  scopes: string[];
  auditScopes: string[];
  isAdmin: boolean;
}

export type AuditViewAuthMode = "session" | "api_key" | null | undefined;

export interface SavedViewWriteAccess {
  /** May the client offer Save / Delete at all? */
  allowed: boolean;
  /**
   * False while the scope probe is still in flight. A screen must render
   * NEITHER the control nor a denial until this is true — claiming "you do not
   * have permission" before asking is its own species of lie.
   */
  known: boolean;
  /** Why the controls are absent, or null when they are not. */
  notice: string | null;
}

const EXECUTE_SCOPE = "audit:execute_actions";

/**
 * The floor routeauth puts on EVERY mutating audit route: `session_minimum_role
 * admin`, or an API key holding `audit:execute_actions` (with `admin` acting as
 * the wildcard `apikeys.HasScope` treats it as).
 *
 * Exported because saved-view writes are not the only route carrying it —
 * `POST /api/v1/audit/nlq` carries the identical manifest row
 * (`session_minimum_role: admin`, `api_key_scopes: ["audit:execute_actions"]`,
 * `review_status: reviewed`). Having one predicate rather than two copies is
 * what stops the two surfaces drifting apart the day the row changes; each
 * caller still writes its own denial copy, because the reason a saved view is
 * admin-only is not the reason a question is.
 *
 * Returns `null` while the scope probe is in flight: unknown is not denied, and
 * a screen must render neither the control nor a denial until it answers.
 */
export function auditExecuteFloorMet(input: {
  scopes: AuditViewScopeSet | null | undefined;
  mode: AuditViewAuthMode;
}): boolean | null {
  if (!input.scopes) return null;
  if (input.mode === "api_key") {
    return (
      input.scopes.isAdmin ||
      input.scopes.scopes.includes(EXECUTE_SCOPE) ||
      input.scopes.auditScopes.includes(EXECUTE_SCOPE)
    );
  }
  return input.scopes.isAdmin;
}

export function savedViewWriteAccess(input: {
  scopes: AuditViewScopeSet | null | undefined;
  mode: AuditViewAuthMode;
}): SavedViewWriteAccess {
  const met = auditExecuteFloorMet(input);
  if (met === null) return { allowed: false, known: false, notice: null };
  if (met) return { allowed: true, known: true, notice: null };

  if (input.mode === "api_key") {
    return {
      allowed: false,
      known: true,
      notice:
        "This API key can read saved views but not change them — the route policy requires audit:execute_actions.",
    };
  }
  return {
    allowed: false,
    known: true,
    notice:
      "Saved views are shared with the whole workspace, so creating and deleting them is limited to owners and admins. You can still open any view saved here.",
  };
}
