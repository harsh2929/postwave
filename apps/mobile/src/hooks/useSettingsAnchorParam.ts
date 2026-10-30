/**
 * useSettingsAnchorParam — jump to the Settings section a `?anchor=` names.
 *
 * The command palette (lib/paletteSettingsItems) routes "App lock" to
 * /(tabs)/settings?anchor=app-lock. This is the consumer: the screen calls it
 * with its anchor registry and its jumpToSection, and the hook does exactly
 * what a SettingsIndex tap does — once the section has laid out.
 *
 * Why it waits: offsets are registered by each SectionHeader's onLayout, which
 * lands a frame or more after mount, while the param is readable on the very
 * first render. Jumping immediately would find no offset and show the "isn't
 * available for your role" notice for a section that is merely not measured
 * yet. So it polls briefly; if the offset never appears (a role-gated section
 * that never mounts) the jump runs anyway, and that notice is then the truth.
 *
 * The param is cleared after the jump, as campaigns/index.tsx clears `?new=1`:
 * a tab re-focus or a back navigation must not yank the scroll position again.
 * Clearing is also what lets a SECOND palette pick of the same section fire —
 * expo-router reuses the mounted screen, so without it the param value would
 * never change.
 */
import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useRef } from "react";

import type { SettingsAnchorRegistry } from "@/components/settings/SettingsAnchors";
import {
  SETTINGS_ANCHOR_PARAM,
  parseSettingsAnchorParam,
} from "@/lib/paletteSettingsItems";

const LAYOUT_POLL_MS = 80;
/** ~1s of patience — long past any first paint, short of feeling stuck. */
const LAYOUT_POLL_ATTEMPTS = 12;

export function useSettingsAnchorParam(
  anchors: SettingsAnchorRegistry,
  jumpToSection: (key: string) => void,
): void {
  const params = useLocalSearchParams<{ anchor?: string }>();
  const key = parseSettingsAnchorParam(params[SETTINGS_ANCHOR_PARAM]);
  // Read through a ref: jumpToSection closes over the toast and the scroll
  // ref and is re-created when they are, and a fresh identity must not
  // restart the poll mid-way or jump twice.
  const jumpRef = useRef(jumpToSection);
  jumpRef.current = jumpToSection;

  useEffect(() => {
    if (!key) return;
    let cancelled = false;
    let attempts = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = () => {
      if (cancelled) return;
      if (anchors.offsetFor(key) === null && attempts < LAYOUT_POLL_ATTEMPTS) {
        attempts += 1;
        timer = setTimeout(tick, LAYOUT_POLL_MS);
        return;
      }
      jumpRef.current(key);
      router.setParams({ [SETTINGS_ANCHOR_PARAM]: undefined });
    };
    tick();
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [anchors, key]);
}
