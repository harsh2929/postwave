/**
 * lib/rowDensityStore.ts — the applied row density, readable synchronously
 * from anywhere in the tree.
 *
 * WHY A MODULE STORE AND NOT A CONTEXT. The density is consumed by leaf row
 * components (SubscriberRow, CampaignListRow) that sit under a FlatList, four
 * or five levels below the screen. Prop-drilling it would touch every list
 * screen, every `renderItem`, and every memo comparator on the way down — a
 * lot of surface for a display preference. A provider would be the other
 * answer, but every provider in this app is mounted in `app/_layout.tsx`, and
 * adding one there is a change to the launch tree for a padding value.
 *
 * WHY THAT IS NOT AN IDENTITY-HYGIENE HOLE, which is the obvious objection
 * given this app's history (desktop and web both shipped caches that bled
 * across tenants on a shared device):
 *
 *  - This module holds NO stored state. It is a live mirror of a value that is
 *    read from, and written to, the identity-scoped `lib/listPreferences`
 *    store — the same origin+tenant+user key the query persister uses.
 *  - The single publisher (`useDisplayPreferences`, mounted app-wide in
 *    ShellLifecycle) pushes `DEFAULT_ROW_DENSITY` the instant the identity
 *    changes and only pushes a stored value once the read for THAT identity
 *    has landed. So the worst case on a workspace switch is the default, never
 *    the previous operator's choice.
 *  - And the value itself is a padding number. It is scoped for consistency
 *    with everything else, not because a density leaks information.
 *
 * `useSyncExternalStore` is the consumer side (see hooks/useRowDensity.ts);
 * this file stays import-free so the store semantics are testable under node.
 */
import {
  DEFAULT_ROW_DENSITY,
  type RowDensity,
} from "@/lib/displayPreferences";

let applied: RowDensity = DEFAULT_ROW_DENSITY;
const listeners = new Set<() => void>();

/** The density every list row is rendering at right now. */
export function appliedRowDensity(): RowDensity {
  return applied;
}

/**
 * Publish a new density. A no-op when nothing changed, so the publisher can
 * call it on every render of its effect without re-rendering every row in
 * every list in the app.
 */
export function setAppliedRowDensity(next: RowDensity): void {
  if (next === applied) return;
  applied = next;
  for (const listener of [...listeners]) listener();
}

export function subscribeRowDensity(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test seam: drop subscribers and return to the default. */
export function resetRowDensityStore(): void {
  applied = DEFAULT_ROW_DENSITY;
  listeners.clear();
}
