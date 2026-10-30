/**
 * lib/apiKeyRows.ts — ordering and labelling for the API-keys screen.
 *
 * Kept pure and separate from the query hook because both decisions are
 * judgement calls that deserve a test:
 *
 *  - ORDER. A revoked key is history; a key that authenticated a request five
 *    minutes ago is the one you are looking for. So: live before revoked, then
 *    most-recently-used, then newest. Sorting by creation date alone buries the
 *    hot key under a year of dormant ones.
 *  - RISK. "Which of these could actually do damage if it leaked?" is answered
 *    by the scope list, not by the label. A key with a write or admin scope is
 *    flagged; a sandbox-only key never sends real mail and is not.
 */

export interface ApiKeyLike {
  id: string;
  scopes: readonly string[];
  createdAt: string;
  lastUsedAt?: string | undefined;
  revokedAt?: string | undefined;
  expiresAt?: string | undefined;
  sandboxOnly: boolean;
}

function at(value: string | undefined): number {
  if (!value) return 0;
  const n = new Date(value).getTime();
  return Number.isFinite(n) ? n : 0;
}

/** Live keys first, then most recently used, then newest. Stable and total. */
export function sortApiKeys<T extends ApiKeyLike>(keys: readonly T[]): T[] {
  return [...keys].sort((a, b) => {
    const aRevoked = a.revokedAt ? 1 : 0;
    const bRevoked = b.revokedAt ? 1 : 0;
    if (aRevoked !== bRevoked) return aRevoked - bRevoked;
    const used = at(b.lastUsedAt) - at(a.lastUsedAt);
    if (used !== 0) return used;
    const created = at(b.createdAt) - at(a.createdAt);
    if (created !== 0) return created;
    return a.id.localeCompare(b.id);
  });
}

export type ApiKeyState = "revoked" | "expired" | "sandbox" | "live";

/**
 * The single most important fact about a key, resolved in precedence order.
 * Revoked wins over expired (both are dead, but revoked is the deliberate one);
 * an expired key cannot authenticate regardless of scope.
 */
export function apiKeyState(
  key: ApiKeyLike,
  now: number = Date.now(),
): ApiKeyState {
  if (key.revokedAt) return "revoked";
  const expiry = at(key.expiresAt);
  if (expiry > 0 && expiry <= now) return "expired";
  if (key.sandboxOnly) return "sandbox";
  return "live";
}

/** Scope prefixes that can change or exfiltrate data if the key leaks. */
const SENSITIVE_SCOPE_RE = /^(write|admin|send)/i;

/**
 * True when a live key carries a scope that can act, not merely read. Drives
 * the "revoke this first" emphasis — a read-only reports key leaking is a very
 * different incident from an admin key leaking.
 */
export function isHighRiskKey(key: ApiKeyLike, now: number = Date.now()): boolean {
  if (apiKeyState(key, now) !== "live") return false;
  return key.scopes.some((scope) => SENSITIVE_SCOPE_RE.test(scope.trim()));
}
