/**
 * lib/revealOnceSecret.ts — surviving a navigation without ever persisting.
 *
 * THE BUG. An outbound webhook's signing secret is returned by the server
 * exactly once, at create time. On mobile it lived in `useState` inside a
 * section of the Settings screen, so ANY unmount destroyed it: switching to
 * another tab, a re-render triggered by pull-to-refresh, or the OS reclaiming a
 * backgrounded screen. The user's most likely next action — leaving the app to
 * paste it into a password manager — is exactly the action that could lose it.
 * And because mobile has no rotate, a lost secret meant the webhook was
 * unusable until someone opened a laptop. The component's own header even said
 * so: "once dismissed, the only recovery is a rotate (desktop-only today)."
 *
 * THE RULE WE KEPT. The secret is still NEVER persisted. Nothing here touches
 * SecureStore, AsyncStorage, the offline vault or the query cache. This is
 * process memory, and process memory only: killing the app loses it, which is
 * correct.
 *
 * WHAT CHANGED. The value now outlives the component instead of the component
 * owning it, and it self-expires. A secret that is still on screen after the
 * TTL is a secret the operator walked away from, so it is dropped rather than
 * left sitting in memory indefinitely.
 *
 * Deliberately free of React and of every native module, so the expiry and
 * eviction rules are unit-testable in a node environment.
 */

export interface StashedSecret {
  /** The entity the secret belongs to (a webhook id). */
  id: string;
  value: string;
  /** Epoch ms when the secret was captured from the server response. */
  revealedAt: number;
}

/**
 * Ten minutes. Long enough to leave the app, open a password manager, and come
 * back; short enough that a phone left on a desk does not hold a signing key in
 * memory for the rest of the day.
 */
export const REVEAL_ONCE_TTL_MS = 10 * 60_000;

/** Only ever one reveal-once secret in flight; a second create replaces it. */
let current: StashedSecret | null = null;

/** Store the just-revealed secret. Replaces any previous one. */
export function stashSecret(
  id: string,
  value: string,
  now: number = Date.now(),
): StashedSecret | null {
  const trimmedId = (id ?? "").trim();
  const trimmedValue = (value ?? "").trim();
  if (!trimmedId || !trimmedValue) {
    current = null;
    return null;
  }
  current = { id: trimmedId, value: trimmedValue, revealedAt: now };
  return current;
}

/**
 * Read the live secret, or null when there is none or it has expired.
 * Reading also evicts an expired value, so an expiry cannot be observed twice.
 */
export function peekSecret(now: number = Date.now()): StashedSecret | null {
  if (!current) return null;
  if (now - current.revealedAt >= REVEAL_ONCE_TTL_MS) {
    current = null;
    return null;
  }
  return current;
}

/** Milliseconds left before the stash self-evicts; 0 when there is nothing. */
export function secretTimeLeftMs(now: number = Date.now()): number {
  const live = peekSecret(now);
  if (!live) return 0;
  return Math.max(0, REVEAL_ONCE_TTL_MS - (now - live.revealedAt));
}

/** Explicit dismissal — the operator says they have captured it. */
export function clearSecret(): void {
  current = null;
}
