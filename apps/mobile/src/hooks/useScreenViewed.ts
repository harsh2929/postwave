import { useEffect, useRef } from "react";

import { EVENTS } from "@postwave/telemetry";

import { track } from "@/lib/telemetry";

/**
 * useScreenViewed — emit one screen-view event per mount.
 *
 * The whole automation cluster (sequences list, sequence detail, voice, forms)
 * had ZERO telemetry: `mobile.tab_viewed` is fired by the bottom-tab layout's
 * `tabPress` listeners only, so every secondary destination reached through the
 * More menu or a deep link was invisible. Nobody could answer whether anyone
 * opens these screens at all — which is exactly the data needed to decide how
 * much to invest in them.
 *
 * Uses the existing canonical `mobile.tab_viewed` name with the already
 * allow-listed `tab` property, so no new event vocabulary is introduced and
 * `sanitizeTelemetryProperties` keeps its allowlist guarantee. The ref makes it
 * once-per-mount rather than once-per-render.
 */
export function useScreenViewed(screen: string): void {
  const sent = useRef<string | null>(null);
  useEffect(() => {
    if (sent.current === screen) return;
    sent.current = screen;
    track(EVENTS.MOBILE_TAB_VIEWED, { tab: screen });
  }, [screen]);
}
