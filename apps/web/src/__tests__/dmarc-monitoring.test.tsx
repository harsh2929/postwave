// SPDX-License-Identifier: AGPL-3.0-only
//
// INBOX-032: the DMARC monitoring card renders the aggregate stat tiles + a
// per-source-IP alignment table when data is present, and a (non-error)
// empty state for a fresh tenant with no ingested reports.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { DmarcMonitoring } from "@/components/inbox-reality/dmarc-monitoring";
import { mockDmarcReport, mockDmarcStats } from "@/lib/inbox-reality-mocks";
import type { DmarcStats } from "@/lib/inbox-reality-types";

const ZERO_STATS: DmarcStats = {
  total_reports: 0,
  total_records: 0,
  total_count: 0,
  dkim_pass: 0,
  dkim_fail: 0,
  spf_pass: 0,
  spf_fail: 0,
  pass_count: 0,
  fail_count: 0,
};

describe("DmarcMonitoring", () => {
  it("renders stat tiles and a row per source-IP record", () => {
    const detail = mockDmarcReport("dmr_1");
    const html = renderToStaticMarkup(
      createElement(DmarcMonitoring, {
        stats: mockDmarcStats(),
        detail,
      }),
    );
    // Header + at least one stat label.
    expect(html).toContain("DMARC monitoring");
    expect(html).toContain("Messages evaluated");
    expect(html).toContain("DKIM pass");
    // Every record's source IP + header_from renders.
    for (const record of detail.records) {
      expect(html).toContain(record.source_ip);
      expect(html).toContain(record.header_from);
    }
    // A pass row → success badge token; a fail row → destructive badge token.
    expect(html).toContain("text-success");
    expect(html).toContain("text-destructive-foreground");
  });

  it("renders the empty state (not an error) when there are no reports", () => {
    const html = renderToStaticMarkup(
      createElement(DmarcMonitoring, { stats: ZERO_STATS, detail: null }),
    );
    expect(html).toContain("No DMARC reports yet");
    // The alignment table must NOT render in the empty case.
    expect(html).not.toContain("Source IP");
  });

  it("treats missing statistics as unavailable rather than empty", () => {
    const html = renderToStaticMarkup(
      createElement(DmarcMonitoring, {
        stats: null,
        detail: mockDmarcReport("dmr_1"),
      }),
    );
    expect(html).toContain("DMARC monitoring unavailable");
    expect(html).not.toContain("No DMARC reports yet");
  });

  it("shows aggregate tiles (not a false empty) when the detail round-trip failed", () => {
    // stats prove 3 reports exist, but the second round trip returned null
    // (fetch failed). The card must NOT claim "No DMARC reports yet".
    const html = renderToStaticMarkup(
      createElement(DmarcMonitoring, {
        stats: mockDmarcStats(),
        detail: null,
      }),
    );
    expect(html).not.toContain("No DMARC reports yet");
    expect(html).toContain("Messages evaluated"); // aggregate tiles render
    expect(html).toContain("unavailable"); // detail-unavailable note
    expect(html).not.toContain("Source IP"); // no table without records
  });

  it("shows aggregate tiles when the latest report has zero records", () => {
    const detail = mockDmarcReport("dmr_1");
    const html = renderToStaticMarkup(
      createElement(DmarcMonitoring, {
        stats: mockDmarcStats(),
        detail: { report: detail.report, records: [] },
      }),
    );
    expect(html).not.toContain("No DMARC reports yet");
    expect(html).toContain("Messages evaluated");
    expect(html).toContain("unavailable");
  });
});
