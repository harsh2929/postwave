// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useEffect, useState } from "react";

/**
 * The current year in a footer copyright line.
 *
 * `new Date().getFullYear()` inside a server component is evaluated when the
 * page is *rendered*, and every page carrying these footers is statically
 * generated — so the year was frozen at build time. From 1 January until the
 * next deploy, the docs, the marketing site and the 404 page all claimed the
 * wrong year, on every page, with nothing to notice it.
 *
 * Hydration-safe by construction: the first client render returns exactly what
 * the server produced (`buildYear`), and the correction happens in an effect
 * afterwards. This is the same shape PreProductionBanner uses for its stored
 * dismissal and DocsToc for its derived headings — render the server's answer,
 * then reconcile once mounted.
 */
export function CopyrightYear({
  buildYear,
}: {
  /** The year at build time, so server and first client render agree. */
  buildYear: number;
}): JSX.Element {
  const [year, setYear] = useState(buildYear);
  useEffect(() => {
    const now = new Date().getFullYear();
    if (now !== buildYear) setYear(now);
  }, [buildYear]);
  return <>{year}</>;
}
