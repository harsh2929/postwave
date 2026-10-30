/**
 * lib/scrollMemory.ts — where a scrollable screen was when you left it.
 *
 * More and Settings are plain ScrollViews with no ref and no remembered
 * offset, so navigating into a section and coming back drops you at the top.
 * On mobile the cost is higher than on desktop: Settings is ~20 sections and
 * More has six, so a user configuring webhooks re-scrolls the full height every
 * single time.
 *
 * IN-MEMORY, SESSION-LIFETIME, ON PURPOSE. Persisting a scroll offset to disk
 * would restore a stale position days later against content that has since
 * changed length — the offset is only meaningful for as long as the screen it
 * was measured on is still the same shape. A cold start should start at the
 * top.
 *
 * Import-free so the thresholds are testable in the node environment.
 */

const offsets = new Map<string, number>();

/**
 * Below this, "restoring" is indistinguishable from starting at the top and
 * only risks a visible jump on return.
 */
export const MIN_REMEMBERED_OFFSET = 32;

export function rememberScrollOffset(key: string, y: unknown): void {
  if (!key) return;
  if (typeof y !== "number" || !Number.isFinite(y)) return;
  if (y < MIN_REMEMBERED_OFFSET) {
    // Explicitly forget, so scrolling back to the top is itself remembered.
    offsets.delete(key);
    return;
  }
  offsets.set(key, y);
}

export function recallScrollOffset(key: string): number | null {
  if (!key) return null;
  return offsets.get(key) ?? null;
}

export function forgetScrollOffset(key: string): void {
  offsets.delete(key);
}

/** Called from the sign-out teardown so a new account starts clean. */
export function clearScrollMemory(): void {
  offsets.clear();
}
