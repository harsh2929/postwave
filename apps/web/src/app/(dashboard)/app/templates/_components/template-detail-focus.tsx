// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useEffect } from "react";

export function TemplateDetailFocus({ headingId }: { headingId: string }) {
  useEffect(() => {
    document.getElementById(headingId)?.focus({ preventScroll: true });
  }, [headingId]);
  return null;
}
