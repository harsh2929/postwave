// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useSyncExternalStore } from "react";

import { absoluteTime, timeAgo } from "@/lib/relative-time";

/**
 * One shared hydration signal for every timestamp on the page.
 *
 * The per-instance `useState(false)` + `useEffect(() => setMounted(true))` pair
 * this replaces made each of the ~78 <RelativeTime> call sites pay its own
 * state write and its own second render on arrival — 100 extra renders on an
 * ordinary 50-row table, landing inside the hydration long task. A store whose
 * snapshot differs between server and client tells React the same thing with
 * no per-instance effect and no state write at all: the server sees `false`,
 * the client sees `true`, and React reconciles it once after hydration.
 *
 * `subscribeToHydration` intentionally never notifies — the value flips
 * exactly once, at hydration, and nothing can change it afterwards.
 */
const subscribeToHydration = () => () => {};
const hydratedSnapshot = () => true;
const serverSnapshot = () => false;

/**
 * Renders a relative "2h ago" timestamp with the absolute time on hover
 * (title). Locale/timezone-dependent formatting runs client-only to avoid the
 * SSR/client hydration mismatch that plain `new Date().toLocaleString()` in
 * render caused on the list (CAMP-033/053/049). Before mount we emit a stable,
 * timezone-independent date slice (YYYY-MM-DD) so server and client HTML match;
 * after hydration we swap to the relative phrasing.
 */
export function RelativeTime({
  iso,
  className,
}: {
  iso: string;
  className?: string;
}) {
  const hydrated = useSyncExternalStore(
    subscribeToHydration,
    hydratedSnapshot,
    serverSnapshot,
  );

  const stable = typeof iso === "string" ? iso.slice(0, 10) : "";
  const relative = hydrated ? timeAgo(iso) || stable : stable;
  // The absolute stamp is a hover tooltip, and it is locale- and
  // timezone-dependent — so there was never anything useful for the server to
  // emit, only a second formatting pass and one more attribute the hydration
  // warning had to be suppressed over. Compute it once, client-side.
  const absolute = hydrated ? absoluteTime(iso) : "";

  return (
    <span className={className} title={absolute || undefined} suppressHydrationWarning>
      {relative || "—"}
    </span>
  );
}
