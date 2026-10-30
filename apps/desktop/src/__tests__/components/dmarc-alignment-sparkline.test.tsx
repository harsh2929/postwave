// @vitest-environment happy-dom

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { DmarcAlignmentSparkline } from "../../components/dmarc/DmarcAlignmentSparkline";

describe("DmarcAlignmentSparkline", () => {
  it("preserves missing UTC dates as inspectable gaps instead of compressing time", () => {
    document.body.innerHTML = renderToStaticMarkup(
      <DmarcAlignmentSparkline
        domain="example.test"
        generatedAt="2026-08-03T08:30:00.000Z"
        periodDays={3}
        windowStart="2026-07-31T08:30:00.000Z"
        windowEnd="2026-08-03T08:30:00.000Z"
        series={[
          {
            date: "2026-08-01",
            messages: 100,
            aligned: 90,
            alignedPct: 0.9,
          },
          {
            date: "2026-08-03",
            messages: 80,
            aligned: 76,
            alignedPct: 0.95,
          },
        ]}
      />,
    );

    const chart = document.querySelector<SVGElement>('svg[role="img"]');
    expect(chart?.getAttribute("aria-label")).toContain(
      "4 UTC dates with 2 reporting dates and 2 unobserved dates shown as gaps",
    );
    const path = chart?.querySelector("path")?.getAttribute("d") ?? "";
    expect(path.match(/M/gu)).toHaveLength(2);
    expect(chart?.querySelectorAll('circle[aria-hidden="true"]')).toHaveLength(
      2,
    );
    expect(document.querySelector("details")?.textContent).toContain(
      "View data table",
    );
    expect(document.querySelectorAll("details tbody tr")).toHaveLength(4);
    expect(document.body.textContent).toContain(
      "An unavailable date is not evidence of zero traffic or zero alignment",
    );
  });
});
