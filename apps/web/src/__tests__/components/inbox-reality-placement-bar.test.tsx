// SPDX-License-Identifier: AGPL-3.0-only

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { PlacementBar } from "@/components/inbox-reality/placement-bar";

describe("Inbox Reality placement bar", () => {
  it("normalizes invalid and negative shares before emitting SVG geometry", () => {
    const html = renderToStaticMarkup(
      createElement(PlacementBar, {
        primary: Number.NaN,
        promotions: -0.5,
        spam: Number.POSITIVE_INFINITY,
        showLabels: true,
      }),
    );

    expect(html).toContain("Primary 0%, Promotions 0%, Spam 0%");
    expect(html).not.toContain("NaN");
    expect(html).not.toContain("Infinity");
    expect(html).not.toMatch(/width="-/u);
  });

  it("expresses the normalized distribution in its accessible name", () => {
    const html = renderToStaticMarkup(
      createElement(PlacementBar, {
        primary: 0.6,
        promotions: 0.3,
        spam: 0.1,
      }),
    );

    expect(html).toContain("Primary 60%, Promotions 30%, Spam 10%");
  });
});
