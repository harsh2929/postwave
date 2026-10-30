// SPDX-License-Identifier: AGPL-3.0-only
//
// INBOX-032: normalizeDmarcStats defends the summary tiles against a partial
// or malformed payload (every counter defaults to 0, never NaN), and the mock
// fixtures match the snake_case wire contract field-for-field.

import { describe, expect, it } from "vitest";

import { normalizeDmarcStats } from "@/lib/inbox-reality-api";
import {
  mockDmarcReport,
  mockDmarcReports,
  mockDmarcStats,
} from "@/lib/inbox-reality-mocks";

describe("normalizeDmarcStats", () => {
  it("defaults every counter to 0 for an empty payload", () => {
    expect(normalizeDmarcStats({})).toEqual({
      total_reports: 0,
      total_records: 0,
      total_count: 0,
      dkim_pass: 0,
      dkim_fail: 0,
      spf_pass: 0,
      spf_fail: 0,
      pass_count: 0,
      fail_count: 0,
    });
  });

  it("coerces non-finite counters to 0 rather than rendering NaN", () => {
    expect(
      normalizeDmarcStats({
        total_reports: Number.NaN,
        total_count: Number.POSITIVE_INFINITY,
        dkim_pass: "12" as never,
      }),
    ).toMatchObject({
      total_reports: 0,
      total_count: 0,
      dkim_pass: 0,
    });
  });

  it("passes finite counters through unchanged", () => {
    const full = mockDmarcStats();
    expect(normalizeDmarcStats(full)).toEqual(full);
  });

  it("handles null/undefined without throwing", () => {
    expect(normalizeDmarcStats(null).total_reports).toBe(0);
    expect(normalizeDmarcStats(undefined).fail_count).toBe(0);
  });
});

describe("DMARC mock fixtures match the wire contract", () => {
  it("reports are newest-first so index 0 is the latest", () => {
    const reports = mockDmarcReports();
    expect(reports.length).toBeGreaterThan(0);
    const first = reports[0];
    // snake_case keys present.
    expect(first).toHaveProperty("id");
    expect(first).toHaveProperty("org_name");
    expect(first).toHaveProperty("date_range_end");
    expect(first).toHaveProperty("policy_p");
    // Newest first: report[0].date_range_end >= report[1].date_range_end.
    if (reports.length > 1) {
      expect(
        Date.parse(reports[0].date_range_end),
      ).toBeGreaterThanOrEqual(Date.parse(reports[1].date_range_end));
    }
  });

  it("detail records span pass/fail dispositions with distinct source IPs", () => {
    const detail = mockDmarcReport("dmr_x");
    expect(detail.report.id).toBe("dmr_x");
    expect(detail.records.length).toBeGreaterThan(1);
    const ips = new Set(detail.records.map((r) => r.source_ip));
    expect(ips.size).toBe(detail.records.length); // all distinct
    const dispositions = new Set(detail.records.map((r) => r.disposition));
    // At least a delivered (none) and an enforced (reject/quarantine) row.
    expect(dispositions.size).toBeGreaterThan(1);
    for (const record of detail.records) {
      expect(record).toHaveProperty("dkim_result");
      expect(record).toHaveProperty("spf_result");
      expect(record).toHaveProperty("header_from");
      expect(typeof record.count).toBe("number");
    }
  });
});
