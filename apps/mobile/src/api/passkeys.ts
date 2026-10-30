/**
 * api/passkeys.ts — passkey MANAGEMENT.
 *
 *   GET    /api/v1/auth/webauthn/credentials        what can sign in as me
 *   PATCH  /api/v1/auth/webauthn/credentials/{id}   rename one
 *   DELETE /api/v1/auth/webauthn/credentials/{id}   remove one
 *
 * (apps/api/internal/auth, mounted in the authenticated tenant-resolved group
 * and gated session-only / viewer-minimum by the routeauth manifest.)
 *
 * MANAGEMENT, NOT ENROLLMENT — and the distinction is the whole reason this
 * module can exist. Creating a passkey needs a platform authenticator and a
 * WebAuthn ceremony that validates against the server's RPOrigins; the Expo app
 * bundles no passkey module, so enrollment is genuinely out of reach here.
 * Listing, renaming and deleting are ordinary authenticated JSON calls that
 * need no authenticator at all — so "we cannot do passkeys on mobile" was true
 * of half the surface and quietly applied to all of it. A user who lost the
 * device holding a passkey could not remove that passkey from their phone.
 *
 * Everything goes through `authRequest`, inheriting the cookie round-trip, the
 * X-Postwave-Client CSRF header, the AuthApiError envelope and the
 * response-size guards.
 */
import { authRequest, type AuthResult } from "./auth";

export interface PasskeyCredential {
  id: string;
  name?: string;
  created_at: string;
  last_used_at?: string;
}

/**
 * Defensive parse. The server owning this shape is not a reason to trust the
 * bytes: a mis-shaped payload here would render an unnamed, un-deletable row
 * that looks like a real credential.
 *
 * `null` means the ENVELOPE is unreadable, and the caller reports that as an
 * error. It must never read as `[]`: "No passkeys registered" on the screen
 * that revokes a lost device's passkey is a security statement. The server
 * always writes a non-nil `items` (webauthn_handlers.go), so only a readable
 * envelope may say "none". A malformed ROW is still skipped.
 */
function parseCredentials(raw: unknown): PasskeyCredential[] | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  // `items` is the server's envelope key (webauthn_handlers.go writes
  // {"items": …}). Reading `credentials` returned [] for every account, and
  // a wrong key was indistinguishable from an empty account. That drift
  // shipped once; it now fails closed.
  const list = (raw as { items?: unknown }).items;
  if (!Array.isArray(list)) return null;
  const out: PasskeyCredential[] = [];
  for (const row of list) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    if (typeof r.id !== "string" || r.id === "") continue;
    if (typeof r.created_at !== "string") continue;
    out.push({
      id: r.id,
      created_at: r.created_at,
      ...(typeof r.name === "string" ? { name: r.name } : {}),
      ...(typeof r.last_used_at === "string"
        ? { last_used_at: r.last_used_at }
        : {}),
    });
  }
  return out;
}

export async function listPasskeys(
  baseUrl: string,
): Promise<AuthResult<PasskeyCredential[]>> {
  const res = await authRequest<unknown>(
    baseUrl,
    "/api/v1/auth/webauthn/credentials",
  );
  if (res.error) return { error: res.error };
  const rows = parseCredentials(res.data);
  if (!rows) {
    return {
      error: {
        code: "invalid_passkeys_response",
        kind: "parse",
        message: "The server returned an unreadable passkey list.",
      },
    };
  }
  return { data: rows };
}

export async function renamePasskey(
  baseUrl: string,
  id: string,
  name: string,
): Promise<AuthResult<void>> {
  return authRequest<void>(
    baseUrl,
    `/api/v1/auth/webauthn/credentials/${encodeURIComponent(id)}`,
    { method: "PATCH", body: JSON.stringify({ name }) },
  );
}

export async function deletePasskey(
  baseUrl: string,
  id: string,
): Promise<AuthResult<void>> {
  return authRequest<void>(
    baseUrl,
    `/api/v1/auth/webauthn/credentials/${encodeURIComponent(id)}`,
    { method: "DELETE" },
  );
}
