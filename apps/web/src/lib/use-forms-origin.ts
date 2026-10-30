// SPDX-License-Identifier: AGPL-3.0-only
"use client";

//
// `useFormsOrigin()` returns the hosted-forms origin in a hydration-safe way
// (FORM-001). During SSR and the FIRST client paint it returns the deterministic
// configured/default origin — never `window.location.origin` — so server and
// client HTML agree. Only AFTER mount, and only when no origin is explicitly
// configured, does it swap to the live browser origin. The swap happens in an
// effect (post-hydration), so it never causes a hydration mismatch.

import { useEffect, useState } from "react";

import { configuredFormsOrigin, publicFormsOrigin } from "@/lib/forms-api";

export function useFormsOrigin(): string {
  const [origin, setOrigin] = useState(() => publicFormsOrigin());

  useEffect(() => {
    if (configuredFormsOrigin()) return; // explicit config wins; nothing to swap
    if (typeof window !== "undefined") setOrigin(window.location.origin);
  }, []);

  return origin;
}
