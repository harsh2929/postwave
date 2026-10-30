/**
 * hooks/useEmailHealthBatch.ts — grade a whole roster at once.
 *
 *   POST /api/v1/verification/health/batch   viewer / read:subscribers
 *
 * The transport for this has existed, fully validated, with ZERO call sites:
 * only the single-address sibling was ever rendered, so answering "how much of
 * this list should I not be mailing" meant opening subscribers one at a time.
 *
 * A MUTATION, not a query, and that is a deliberate reading of what this
 * endpoint costs. It derives evidence per address, and the input is whatever
 * happens to be loaded in a paginated list — so as a query it would re-fire on
 * every focus and grow its own key on every page append, silently turning a
 * scroll into a fan-out. On demand means the person asked.
 *
 * NOT OFFLINE-QUEUEABLE. It is a read shaped as a POST: replaying it an hour
 * later would produce an answer about a roster nobody is looking at. It gets
 * no `offlineSafeMutationMeta` and the route is not on the outbox allowlist.
 *
 * CHUNKED, because MaxBatch is 1000 (verification.go) and the handler answers
 * 413 above it. Chunks run in SEQUENCE rather than in parallel: this is an
 * evidence read over a tenant's whole event history, and firing ten of them at
 * once from a phone is how a background job's worth of work arrives as a
 * thundering herd.
 */
import { useMutation } from "@tanstack/react-query";

import { getEmailHealthBatch, type EmailHealth } from "@/api/emailHealth";
import {
  chunkHealthAddresses,
  normalizeHealthAddresses,
  rollupEmailHealth,
  type EmailHealthRollup,
} from "@/lib/emailHealthRollup";

export interface EmailHealthBatchResult {
  rollup: EmailHealthRollup;
  results: EmailHealth[];
  /**
   * Addresses that were asked about, after normalization and de-duplication.
   * Reported so a caller can say "42 of the 60 loaded" rather than implying it
   * measured everything it was handed.
   */
  requested: number;
}

export function useEmailHealthBatch() {
  return useMutation({
    mutationFn: async (
      emails: readonly (string | null | undefined)[],
    ): Promise<EmailHealthBatchResult> => {
      const addresses = normalizeHealthAddresses(emails);
      if (addresses.length === 0) {
        return { rollup: rollupEmailHealth([]), results: [], requested: 0 };
      }
      const results: EmailHealth[] = [];
      for (const chunk of chunkHealthAddresses(addresses)) {
        const response = await getEmailHealthBatch(chunk);
        results.push(...response.results);
      }
      return {
        rollup: rollupEmailHealth(results),
        results,
        requested: addresses.length,
      };
    },
  });
}
