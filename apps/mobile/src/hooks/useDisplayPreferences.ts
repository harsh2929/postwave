/**
 * useDisplayPreferences — row density and landing screen, on top of the store
 * that already exists.
 *
 * The brief for LOVE#51 was explicit that this must EXTEND `useListPreferences`
 * rather than invent a second memory of the user, and it does: the values live
 * under the `display` screen slug in the same
 * `postwave.listprefs.v1:<origin>:<tenant>:<user>:` namespace as every remembered
 * sort and filter. That inheritance is the whole point —
 *
 *   - identity scoping is not re-implemented, so one account's density can
 *     never surface under another on a shared device;
 *   - `clearListPreferences()` on sign-out already wipes it, with no new
 *     teardown step for a future contributor to forget;
 *   - a corrupt blob degrades to defaults instead of blocking a screen.
 *
 * It is mounted app-wide from `ShellLifecycle` so the density store has a
 * publisher for the whole session, and again inside the Settings section that
 * edits it. Two mounts of the same hook are fine: both read the same key, and
 * the store rejects a write that does not change the value.
 */
import { useEffect } from "react";

import { useListPreferences } from "@/hooks/useListPreferences";
import {
  DEFAULT_LANDING_ROUTE,
  DEFAULT_ROW_DENSITY,
  resolveRowDensity,
  type LandingRoute,
  type RowDensity,
} from "@/lib/displayPreferences";
import { setAppliedRowDensity } from "@/lib/rowDensityStore";

const SCREEN = "display";

const DEFAULTS = {
  density: DEFAULT_ROW_DENSITY as string,
  landing: DEFAULT_LANDING_ROUTE as string,
};

export interface DisplayPreferencesApi {
  density: RowDensity;
  /**
   * The stored landing route, NOT yet checked against the current role —
   * `resolveLandingRoute(landing, canApprove)` is what a navigator should use.
   * Kept unresolved here so the Settings control can show what the user chose
   * even in the moment their role is still loading.
   */
  landing: string;
  hydrated: boolean;
  setDensity: (next: RowDensity) => void;
  setLanding: (next: LandingRoute) => void;
}

export function useDisplayPreferences(): DisplayPreferencesApi {
  const [values, update, { hydrated }] = useListPreferences(SCREEN, DEFAULTS);
  const density = resolveRowDensity(values.density);

  useEffect(() => {
    // Until the read for THIS identity has landed, publish the default rather
    // than a value that may belong to the account that was signed in a moment
    // ago. `useListPreferences` keeps the previous values on screen across an
    // identity change (it only flips `hydrated` to false), so this is the line
    // that stops a workspace switch inheriting the previous operator's view.
    setAppliedRowDensity(hydrated ? density : DEFAULT_ROW_DENSITY);
  }, [density, hydrated]);

  return {
    density,
    landing: values.landing,
    hydrated,
    setDensity: (next: RowDensity) => update({ density: next }),
    setLanding: (next: LandingRoute) => update({ landing: next }),
  };
}
