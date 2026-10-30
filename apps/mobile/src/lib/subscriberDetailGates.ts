/**
 * lib/subscriberDetailGates.ts — who may do what on a subscriber profile.
 *
 * Lifted out of `app/(tabs)/subscribers/[id].tsx` (mirroring the existing
 * lib/campaignDetailGates.ts) when AUDIENCE#33 split "add to list" away from
 * the screen's single `canMutate`. Two reasons, and the second is the real one:
 *
 *  - the component was already at its function-size ceiling, and a nested
 *    ternary chain is the worst possible thing to grow there; and
 *  - WHICH ACTIONS SURVIVE BEING OFFLINE is a policy, not a rendering detail.
 *    It is the kind of decision that should be pinned by a test rather than
 *    re-derived by whoever next edits the JSX.
 *
 * THE POLICY. Adding someone to a list is queued while offline; every other
 * write on the profile is refused. That asymmetry is not arbitrary:
 * `lists.AddSubscribers` (apps/api/internal/lists/membership_write.go:111)
 * only ever ADDS, and the route is documented as idempotent by construction,
 * so a replay minutes or hours later cannot destroy anything. Status,
 * suppression and tags cannot say the same — the first two are compliance
 * state and the third is a full-array replace that would silently drop a tag
 * someone else added in the meantime.
 *
 * Import-free, so the policy is tested in the node environment.
 */

export interface SubscriberDetailGateInput {
  /** OS reachability. */
  online: boolean;
  /** `canAccessMinimumRole("editor", role, mode)`. */
  hasWriteRole: boolean;
  /**
   * `canAccessMinimumRole("admin", role, mode)`.
   *
   * A THIRD boundary, and it is not a rounding of the second. The consent
   * ledger read (GET /api/v1/consent/receipts/by-email/{email}) is mounted
   * with `apikeys.RequireScope(apikeys.ScopeAdmin)`
   * (apps/api/internal/consent/consent.go:156), and ScopeAdmin is in neither
   * `readOnlyScopes` nor `editorWriteScopes` — so on a session it admits
   * owner|admin only. An EDITOR may edit this subscriber and still cannot see
   * their consent records; folding the two together would put a section on
   * the screen that can only ever render a 403.
   */
  hasAdminRole?: boolean;
  /** True when the session is cached-but-unvalidated (cachedSessionNotice). */
  hasSessionNotice: boolean;
}

export interface SubscriberDetailGates {
  /** Status, suppression, tags — everything that needs a live connection. */
  canMutate: boolean;
  unavailableReason: string | undefined;
  /** Add-to-list, which is queued rather than refused when offline. */
  canAddToList: boolean;
  addToListUnavailableReason: string | undefined;
  /**
   * The consent-records section. A READ, so a cached-but-unvalidated session
   * does not close it — the request either succeeds or 401s honestly, and
   * hiding an auditor's evidence because the session is stale would be the
   * wrong failure. Role is the only gate.
   */
  canReadConsent: boolean;
}

const NO_ROLE = "Your role has read-only access to subscribers.";
const OFFLINE = "You're offline. Subscriber changes need a connection.";
const UNVALIDATED = "Reconnect this session before making changes.";

export function subscriberDetailGates(
  input: SubscriberDetailGateInput,
): SubscriberDetailGates {
  const { online, hasWriteRole, hasSessionNotice } = input;
  // Optional so existing call sites that only care about the write tier keep
  // compiling; absent means "not an admin", which fails closed.
  const hasAdminRole = input.hasAdminRole === true;

  // A cached-but-unvalidated session blocks BOTH, including the queued write:
  // the queue re-proves origin + tenant + principal + role at replay time, so
  // enqueuing against an identity that may yet 401 would only produce a
  // failure the user reads long after the moment they acted.
  const roleOrSession = !hasWriteRole
    ? NO_ROLE
    : hasSessionNotice
      ? UNVALIDATED
      : undefined;

  return {
    canMutate: online && !roleOrSession,
    unavailableReason:
      roleOrSession ?? (online ? undefined : OFFLINE),
    canAddToList: !roleOrSession,
    addToListUnavailableReason: roleOrSession,
    canReadConsent: hasAdminRole,
  };
}
