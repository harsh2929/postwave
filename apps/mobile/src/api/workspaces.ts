/**
 * api/workspaces.ts — the two cookie-session calls behind the workspace
 * switcher (SHELL#6).
 *
 *   GET  /api/v1/auth/workspaces         every workspace this email belongs to
 *   POST /api/v1/auth/workspaces/switch  mint a session in a sibling workspace
 *
 * Both are session-only (routeauth manifest: auth_methods ["session"],
 * session_minimum_role "viewer"), which is why they go through `authRequest`
 * — the cookie-aware fetch that also sends the `X-Postwave-Client: mobile`
 * header RN needs to pass the backend's Origin/CSRF gate — rather than the SDK
 * client, which is the API-key path.
 *
 * A separate module from api/auth.ts on purpose: that file is the sign-in
 * surface and is already near its source budget, and nothing here is reachable
 * before sign-in.
 *
 * ON `remember`: the switch body deliberately OMITS it. The server documents
 * that carrying it explicitly is what stops a switch silently upgrading a
 * short-lived session (workspace_switch.go), and mobile's own login
 * (`AuthLoginInput`) sends no `remember` either — so omitting it gives the
 * switched session exactly the lifetime a fresh mobile sign-in would produce.
 * Choosing any other value would be this client inventing a session-lifetime
 * policy the sign-in path does not have.
 */
import { authRequest, type AuthResult } from "./auth";
import { normalizeApiBaseUrl } from "./url";
import {
  parseWorkspaceList,
  type WorkspaceSummary,
} from "../lib/workspaceSwitchPolicy";

export type { WorkspaceSummary };

/** 200 body of POST /api/v1/auth/workspaces/switch. */
export interface WorkspaceSwitchResult {
  tenantId: string;
  userId: string;
  workspaceName: string;
  workspaceSlug: string;
  role: string;
  /**
   * False when the request named the workspace the session was already in.
   * The server does NOT rotate the session in that case, so the client must
   * not tear its local state down either.
   */
  switched: boolean;
}

/**
 * Every workspace the signed-in email belongs to.
 *
 * A malformed envelope is an ERROR, never an empty list — see rule 2 in
 * lib/workspaceSwitchPolicy.ts. Rendering "no other workspaces" because a
 * proxy returned HTML is exactly the lie the offline-first rules forbid.
 */
export async function listWorkspaces(
  baseUrl: string,
): Promise<AuthResult<WorkspaceSummary[]>> {
  const res = await authRequest<unknown>(
    normalizeApiBaseUrl(baseUrl),
    "/api/v1/auth/workspaces",
  );
  if (res.error) return { error: res.error };
  const rows = parseWorkspaceList(res.data);
  if (!rows) {
    return {
      error: {
        code: "invalid_workspaces_response",
        kind: "parse",
        message: "The server returned an unreadable workspace list.",
      },
    };
  }
  return { data: rows };
}

function boundedField(value: unknown): string {
  return typeof value === "string" ? value.trim().slice(0, 120) : "";
}

/**
 * Move this device's session into `workspaceId`.
 *
 * The server revokes the current session BEFORE issuing the new one, so a
 * failure here can leave the caller signed out — the caller must treat an
 * error as "re-authenticate", not "nothing happened". That is why
 * `workspaceSwitchErrorMessage` maps session_revoke_failed / session_failed to
 * "sign in again" rather than "try again".
 */
export async function switchWorkspace(
  baseUrl: string,
  workspaceId: string,
): Promise<AuthResult<WorkspaceSwitchResult>> {
  const res = await authRequest<unknown>(
    normalizeApiBaseUrl(baseUrl),
    "/api/v1/auth/workspaces/switch",
    {
      method: "POST",
      body: JSON.stringify({ workspace_id: workspaceId }),
    },
  );
  if (res.error) return { error: res.error };
  const body = (res.data ?? {}) as Record<string, unknown>;
  const tenantId = boundedField(body.tenant_id);
  const userId = boundedField(body.user_id);
  if (!tenantId || !userId) {
    return {
      error: {
        code: "invalid_switch_response",
        kind: "parse",
        message: "The server returned an incomplete workspace switch.",
      },
    };
  }
  return {
    data: {
      tenantId,
      userId,
      workspaceName: boundedField(body.workspace_name),
      workspaceSlug: boundedField(body.workspace_slug),
      role: boundedField(body.role),
      // Absent is treated as "it switched": the server only omits the flag on
      // a shape this client does not know, and assuming a session was NOT
      // rotated when it was would leave the device holding a stale identity.
      switched: body.switched !== false,
    },
  };
}
