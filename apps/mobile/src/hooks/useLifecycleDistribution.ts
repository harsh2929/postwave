/**
 * useLifecycleDistribution — the tenant-wide lifecycle-stage rollup for the
 * analytics screen.
 *
 * One query, two calls: the histogram is the datum, the stage catalog is
 * decoration (ordering + zero-fill), so a failed catalog read degrades to
 * distribution-only ordering rather than failing the section — the same
 * degrade desktop's LifecycleDistributionCard performs.
 *
 * Resolves to `null` when the deployment has no lifecycle routes mounted
 * (404): the section hides rather than nags. Both routes are viewer-floor
 * in the routeauth manifest, so there is no role gate here — only the
 * online gate every read shares.
 */
import { useQuery } from "@tanstack/react-query";

import {
  fetchLifecycleDistribution,
  fetchLifecycleStages,
  isLifecycleUnavailable,
} from "@/api/lifecycleRollup";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import {
  buildLifecycleView,
  type LifecycleDistributionView,
} from "@/lib/lifecycleDistribution";

export function lifecycleDistributionKey(
  tenantId: string | null | undefined,
): readonly unknown[] {
  return ["lifecycle", tenantId ?? null, "distribution"];
}

/**
 * The histogram and its stage catalog, read as ONE wave.
 *
 * Both calls are argument-free and neither consumes the other, so the catalog
 * goes on the wire WITH the histogram rather than a round trip behind it —
 * 50-300ms on a phone, paid on every analytics visit that outlived the stale
 * window. Exported so the shape is testable without a renderer.
 */
export async function readLifecycleDistribution(): Promise<LifecycleDistributionView | null> {
  // Started before the await, and never awaited on the 404 branch; it already
  // swallows its own failures, so the dangling promise cannot reject.
  const stagesPromise = fetchLifecycleStages().catch(() => []);
  let items;
  try {
    items = await fetchLifecycleDistribution();
  } catch (err) {
    // 404 = routes not mounted on this deployment — hide, don't nag. The
    // catalog read is in flight by now and will 404 alongside it; that one
    // discarded request is the price of not serialising the common case.
    if (isLifecycleUnavailable(err)) return null;
    throw err;
  }
  return buildLifecycleView(items, await stagesPromise);
}

export function useLifecycleDistribution() {
  const gate = useOnlineQueryGate();
  return useQuery<LifecycleDistributionView | null>({
    queryKey: lifecycleDistributionKey(gate.tenantId),
    enabled: gate.enabled && Boolean(gate.tenantId),
    staleTime: 60_000,
    queryFn: readLifecycleDistribution,
  });
}
