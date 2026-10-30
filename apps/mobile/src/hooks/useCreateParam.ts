/**
 * useCreateParam — open a screen's create sheet when it arrives with `?new=1`.
 *
 * campaigns/index.tsx consumes this flag inline: the onboarding CTA
 * `campaigns.new` and the palette's "New campaign" both send it. The palette's
 * "New list" and "New form" (lib/paletteCreateItems) send the SAME flag to
 * lists/index.tsx and forms/index.tsx, and this is their one-line consumer, so
 * the idiom — open on arrival, then clear the flag so a tab re-focus or a back
 * navigation does not reopen the sheet — is written once and cannot drift
 * between screens.
 *
 * `onCreate` is read through a ref: callers pass `() => setOpen(true)` inline,
 * and a fresh identity every render must not re-run the effect (and reopen)
 * on the render between the open and the param clearing.
 */
import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useRef } from "react";

import { PALETTE_CREATE_PARAM } from "@/lib/paletteCreateItems";

export function useCreateParam(onCreate: () => void): void {
  const params = useLocalSearchParams<{ new?: string }>();
  const wantsCreate = params[PALETTE_CREATE_PARAM] === "1";
  const onCreateRef = useRef(onCreate);
  onCreateRef.current = onCreate;

  useEffect(() => {
    if (!wantsCreate) return;
    onCreateRef.current();
    router.setParams({ [PALETTE_CREATE_PARAM]: undefined });
  }, [wantsCreate]);
}
