/**
 * store/authWorkspaceSwitch.ts — the identity transition behind the workspace
 * switcher (SHELL#6).
 *
 * WHY THIS IS NOT A NEW STORE ACTION
 *
 * A workspace switch is not a variant of sign-in; it IS sign-in, with the
 * credential step replaced by a server call that proves the sibling
 * membership. So this orchestrator reuses `signInSession` verbatim rather than
 * adding a parallel path, and that reuse is the security property: signInSession
 * is the code that
 *
 *   - clears the in-memory SDK client and the whole react-query cache;
 *   - runs `clearLocalAuthArtifacts`, which wipes the encrypted vault, the
 *     persisted query cache, the shared-inbox container, the WIDGET App Group
 *     snapshot, donated Spotlight activities, pending magic-link states and
 *     saved list views; and
 *   - persists the new profile in one keychain transaction, rolling the server
 *     session back (via cancelSession) if that transaction cannot commit.
 *
 * Every one of those is a thing an agency operator switching from client A to
 * client B must not carry across, and none of them would have been true of a
 * bespoke "just change tenantId" mutation. It is also what re-keys the
 * PersistQueryClientProvider: app/_layout.tsx derives its `key` from
 * session.tenantId/userId/effectiveRole, so committing a new profile remounts
 * the provider onto a different encrypted persistence scope.
 *
 * THE ORDER MATTERS AND IT IS NOT OBVIOUS
 *
 * `prepareForSessionAuthentication()` runs FIRST, before the switch request.
 * It drains any journaled "this device owes the server a sign-out" marker.
 * Running it afterwards would be too late: the switch has already replaced the
 * platform cookie by then, so the journal could only be settled against a
 * session that no longer exists.
 *
 * MFA IS NOT INHERITED, AND THAT IS THE SERVER'S DOING
 *
 * The new session is issued with mfa_satisfied = false, so `/me` reports the
 * TARGET tenant's policy and the app's existing MFA gate challenges exactly as
 * it would after a password login. Nothing here needs to special-case it —
 * `canEnterApp()` reads `sessionMfaAllowsEntry`, and the auth layout routes.
 */
import { createAuthClient } from "@/api/auth";
import { switchWorkspace } from "@/api/workspaces";

import { workspaceSwitchErrorMessage } from "@/lib/workspaceSwitchPolicy";
// The ALIAS, not `./auth`, and not by accident: the route-test harness maps
// `^@/store/auth$` to a fixture, and a relative import would slip past the
// mapper and drag the real store's module-scope observer registration into
// every screen test that reaches this file.
import { useAuthStore } from "@/store/auth";

import { AuthSessionStateError } from "./authErrors";
import { sessionProfileFromMe } from "./authSessionProfile";

export interface WorkspaceSwitchOutcome {
  /** False when the server reported the session was already in that workspace. */
  switched: boolean;
  /** What to call the workspace now, for the confirmation toast. */
  workspaceName: string;
}

/**
 * Move this device into `workspaceId`.
 *
 * Throws `AuthSessionStateError` with an actionable message on every failure
 * path. The caller must assume the previous session is GONE once this rejects
 * after the network call: the server revokes before it issues.
 */
export async function switchWorkspaceSession(
  workspaceId: string,
  fallbackName: string,
): Promise<WorkspaceSwitchOutcome> {
  const store = useAuthStore.getState();
  const baseUrl = store.baseUrl;
  if (store.mode !== "session" || !baseUrl || !store.session) {
    throw new AuthSessionStateError(
      "no_session",
      "Switching workspaces needs an email sign-in on this device.",
    );
  }
  if (!store.canUseOnlineServices()) {
    throw new AuthSessionStateError(
      "offline",
      "You're offline. Reconnect to switch workspaces.",
    );
  }

  // Settle any owed server sign-out while the OLD cookie is still the live
  // one. See the header note on ordering.
  await store.prepareForSessionAuthentication();

  const result = await switchWorkspace(baseUrl, workspaceId);
  if (result.error) {
    throw new AuthSessionStateError(
      result.error.code ?? "workspace_switch_failed",
      workspaceSwitchErrorMessage(
        result.error.code,
        result.error.status,
        result.error.message,
      ),
    );
  }
  const switched = result.data.switched;
  const name = result.data.workspaceName || fallbackName;
  if (!switched) {
    // The server did not rotate anything. Tearing local state down here would
    // punish a double-tap with a full cache wipe for no gain.
    return { switched: false, workspaceName: name };
  }

  // The cookie is now the TARGET workspace's. `/me` is the only authority on
  // what that session actually is — role, viewer mode, MFA posture — and the
  // switch response is not a substitute for it.
  const me = await createAuthClient(baseUrl).getMe();
  if (me.error) {
    throw new AuthSessionStateError(
      me.error.code ?? "workspace_switch_incomplete",
      "You were switched, but this device couldn't load the new workspace. Sign in again.",
    );
  }
  if (me.data.tenant_id !== result.data.tenantId) {
    // The identity the server hands back must be the one that was asked for.
    // Anything else is a race or a proxy serving a cached /me, and committing
    // it would silently put the device in a third workspace.
    throw new AuthSessionStateError(
      "workspace_switch_mismatch",
      "The workspace switch didn't complete. Sign in again to continue.",
    );
  }

  // The full sign-in commit: wipe the outgoing workspace's artifacts, persist
  // the new profile, and publish the snapshot the layout re-keys on.
  await useAuthStore.getState().signInSession({
    baseUrl,
    profile: sessionProfileFromMe(me.data),
  });

  return {
    switched: true,
    workspaceName:
      me.data.workspace_name || result.data.workspaceName || fallbackName,
  };
}
