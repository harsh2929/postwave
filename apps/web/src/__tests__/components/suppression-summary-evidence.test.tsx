// SPDX-License-Identifier: AGPL-3.0-only
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SuppressionStatStrip } from "@/app/(dashboard)/app/suppressions/_components/suppression-stat-strip";

describe("suppression summary evidence", () => {
  const now = Date.parse("2026-10-25T00:00:00Z");
  const rows = [{ reason: "manual", created_at: "2026-10-24T00:00:00Z" }];

  it("does not infer abnormal growth from one recent manual hold", () => {
    const html = renderToStaticMarkup(
      createElement(SuppressionStatStrip, { rows, total: 1, now }),
    );
    expect(html).toContain("Added in the last 7 days");
    expect(html).not.toContain("Growing fast");
    expect(html).not.toContain("Within normal range");
  });

  it("does not declare an entire workspace clean from a partial roster", () => {
    const html = renderToStaticMarkup(
      createElement(SuppressionStatStrip, { rows, total: 101, now }),
    );
    expect(html).toContain("No complaints in loaded rows");
    expect(html).not.toContain("Clean");
    expect(html).not.toContain("No complaint suppressions recorded");
  });
});
