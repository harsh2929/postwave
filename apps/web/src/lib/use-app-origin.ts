// SPDX-License-Identifier: AGPL-3.0-only
"use client";

//
// `useAppOrigin()` returns the current deployment origin in a hydration-safe
// way. During SSR and the FIRST client paint it returns "" so any URL built
// from it renders as a deterministic RELATIVE path (server and client HTML
// agree); only AFTER mount does it resolve to `window.location.origin`, so an
// absolute URL (for copy-to-clipboard, canonical, etc.) becomes available
// without ever causing a hydration mismatch. Mirrors the useFormsOrigin idiom
// but for pages hosted on the app's own origin (e.g. /landing/{slug}).

import { useEffect, useState } from "react";

export function useAppOrigin(): string {
  const [origin, setOrigin] = useState("");
  useEffect(() => {
    if (typeof window !== "undefined") setOrigin(window.location.origin);
  }, []);
  return origin;
}
