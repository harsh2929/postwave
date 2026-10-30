/**
 * useRowDensity — the density a list row should render at.
 *
 * `useSyncExternalStore` rather than context: rows are leaves under a
 * virtualised list, and this keeps the read O(1) with no provider in the
 * launch tree. See lib/rowDensityStore.ts for why a module store is the right
 * shape here and why it is not an identity-hygiene hole.
 *
 * Returns the resolved MEASUREMENTS, not the token, so a row cannot invent its
 * own interpretation of "compact" — the numbers live in one place and the
 * 44pt touch floor is asserted against them in lib/displayPreferences.test.ts.
 */
import { useSyncExternalStore } from "react";

import {
  densityMetrics,
  type DensityMetrics,
  type RowDensity,
} from "@/lib/displayPreferences";
import {
  appliedRowDensity,
  subscribeRowDensity,
} from "@/lib/rowDensityStore";

export function useRowDensity(): RowDensity {
  return useSyncExternalStore(
    subscribeRowDensity,
    appliedRowDensity,
    // Server snapshot: RN has no SSR, but the third argument is required for
    // the type and must return the same value as the client snapshot.
    appliedRowDensity,
  );
}

export function useDensityMetrics(): DensityMetrics {
  return densityMetrics(useRowDensity());
}
