/**
 * hooks/useFirstPageRefresh — the pull-to-refresh callback for a paged list,
 * bounded to one page request.
 *
 * WHY A HOOK RATHER THAN A CALL AT EACH SCREEN. The bound needs the
 * QueryClient and the query-key PREFIX, and every screen that wants it was
 * otherwise growing the same four lines (`useQueryClient`, a `useMemo`, and
 * the reason). The reason belongs in one place — lib/infiniteQueryRefresh —
 * and the screens should read as one line saying which list they mean.
 *
 * NO `useMemo`. The returned closure is handed to `useManualRefresh`, which
 * deliberately keeps its callbacks in a ref precisely because "callers often
 * pass inline wrappers"; a fresh identity per render costs nothing there and
 * memoising it would need the array literal `prefix` stabilised first, which
 * is a second thing to get wrong.
 */
import { useQueryClient } from "@tanstack/react-query";

import { refreshFirstPageOnly } from "@/lib/infiniteQueryRefresh";

export function useFirstPageRefresh(
  /** A true prefix of the paged query's key — see lib/infiniteQueryRefresh. */
  prefix: readonly unknown[],
  refetch: () => Promise<unknown>,
  /**
   * `collapse: false` for a list whose visible rows are narrowed on the CLIENT
   * across every loaded page. There the pages below the fold are load-bearing
   * for what is on screen, so collapsing could empty a view whose only matches
   * were further down; those screens pay the full per-page price on purpose.
   */
  options: { collapse?: boolean } = {},
): () => Promise<unknown> {
  const queryClient = useQueryClient();
  return refreshFirstPageOnly(queryClient, prefix, refetch, options);
}
