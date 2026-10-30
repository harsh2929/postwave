// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-only
//
// `new Date().getFullYear()` inside a server component is evaluated when the
// page is rendered — and every page carrying these footers is statically
// generated, so the year was frozen at build time. From 1 January until the
// next deploy the docs layout, the marketing layout and the root 404 page all
// showed the wrong year, on every page, with nothing to notice it.
//
// The fix has to stay hydration-safe: the first client render must return
// exactly what the server produced, with the correction landing in an effect.
// Rendering the live year directly would mismatch across the year boundary,
// which React resolves by discarding the server HTML for that subtree.
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { CopyrightYear } from "@/components/copyright-year";

import { visibleCode } from "./helpers/visible-code";

const SRC = resolve(process.cwd(), "src");

const FOOTERS = [
  "app/(docs)/layout.tsx",
  "app/(marketing)/layout.tsx",
  "app/not-found.tsx",
];

describe("footer copyright year", () => {
  it("renders the build year on the server, so hydration matches", () => {
    // Not the live year: server and first client render must agree, and only
    // the effect may move it.
    expect(renderToStaticMarkup(<CopyrightYear buildYear={2019} />)).toBe(
      "2019",
    );
  });

  it("corrects itself once mounted", () => {
    const source = visibleCode(
      readFileSync(join(SRC, "components/copyright-year.tsx"), "utf8"),
    );
    expect(source).toMatch(/useEffect\(/);
    expect(source).toMatch(/new Date\(\)\.getFullYear\(\)/);
    // The update has to be conditional, or every mount schedules a render.
    expect(source).toMatch(/if \(now !== buildYear\) setYear\(now\)/);
  });

  it("leaves no footer rendering the year straight from the server", () => {
    const offenders = FOOTERS.filter((rel) => {
      const text = visibleCode(readFileSync(join(SRC, rel), "utf8"));
      // A bare {new Date().getFullYear()} as a JSX child is the frozen-at-build
      // shape. The lookbehind is what separates it from the *correct* usage,
      // buildYear={new Date().getFullYear()} — the two differ only by what
      // precedes the brace, and without it this flagged the fix as the bug.
      return /(?<!buildYear=)\{\s*new Date\(\)\.getFullYear\(\)\s*\}/.test(text);
    });
    expect(offenders.sort()).toEqual([]);
  });

  it("still stamps every one of those footers with a year", () => {
    // Guard the guard: deleting the year would also satisfy the check above.
    const missing = FOOTERS.filter(
      (rel) =>
        !/<CopyrightYear buildYear=\{new Date\(\)\.getFullYear\(\)\} \/>/.test(
          readFileSync(join(SRC, rel), "utf8"),
        ),
    );
    expect(missing.sort()).toEqual([]);
  });
});
