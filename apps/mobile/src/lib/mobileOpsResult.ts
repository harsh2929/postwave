/**
 * lib/mobileOpsResult.ts — the two helpers every enterprise/operator hook
 * needs, and the reason they no longer live inside a hook module.
 *
 * `unwrapMobileResult` and `opsTimestamp` were private functions inside
 * hooks/useOps.ts (COMMERCE#60). That made them invisible to the four hook
 * modules that were carved out of it, so each carve-out either re-declared
 * them or kept importing the catch-all it was supposed to be leaving. Both
 * are pure, so they belong in lib/ where a node test can reach them — the
 * hook modules cannot be imported by a .test.ts at all (they transitively
 * reach react-native through the query client).
 *
 * The type import is `import type`, so nothing here pulls @/api/request's
 * runtime — this module stays import-free at run time.
 */
import { type AIApiResult } from "@/api/request";

/**
 * Collapse the gateway's `{data, error}` envelope into the value, or throw.
 *
 * A `null` data with a `null` error is NOT an empty list: it means the call
 * answered without a payload, and reporting that as "no rows" would render a
 * confident empty state over a failed read (house rule 8). Both branches throw
 * so the caller's query lands in its error state.
 */
export function unwrapMobileResult<T>(res: AIApiResult<T>, label: string): T {
  if (res.error) {
    throw new Error(res.error.message || `${label} failed`);
  }
  if (res.data == null) {
    throw new Error(`${label} returned no data`);
  }
  return res.data;
}

/**
 * Sort key for an optional ISO timestamp. Absent/unparseable sorts LAST under
 * the descending comparators these hooks use, which is the honest placement:
 * a row whose time we cannot read has not earned the top of a
 * newest-activity list.
 */
export function opsTimestamp(value: string | null | undefined): number {
  if (!value) return 0;
  const n = new Date(value).getTime();
  return Number.isFinite(n) ? n : 0;
}
