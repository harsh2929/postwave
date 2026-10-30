import { describe, expect, it } from "vitest";

import {
  buildDmarcCsv,
  filterDmarcReports,
  parseDmarcInsights,
  parseDmarcReports,
  parseDmarcSourceDetail,
  rangeStart,
} from "../../components/dmarc/dmarc-contract";

const REPORT_ID = "123e4567-e89b-42d3-a456-426614174000";

function reportEnvelope() {
  return {
    items: [
      {
        id: REPORT_ID,
        orgName: "Example Receiver",
        reportId: "receiver-2026-08-03",
        domain: "mail.example.com",
        policyP: "none",
        policyPct: null,
        dateBegin: "2026-08-02T00:00:00Z",
        dateEnd: "2026-08-03T00:00:00Z",
        passCount: 85,
        failCount: 15,
        receivedAt: "2026-08-03T01:00:00Z",
      },
    ],
    meta: {
      generatedAt: "2026-08-03T08:30:00Z",
      limit: 500,
      returned: 1,
      totalReports: 1,
      hasMore: false,
      availableDomains: ["mail.example.com"],
      domainInventoryTruncated: false,
      scope: {
        from: "2026-07-04T08:30:00Z",
        to: "2026-08-03T08:30:00Z",
      },
    },
  };
}

function source() {
  return {
    sourceIp: "2001:db8::10",
    messages: 100,
    dkimPass: 80,
    spfPass: 75,
    bothPass: 70,
    alignedPct: 0.85,
    primaryDisposition: "none",
    quarantined: 5,
    rejected: 5,
    envelopeFromDomain: "bounce.example.com",
  };
}

function insights() {
  return {
    domain: "mail.example.com",
    periodDays: 30,
    generatedAt: "2026-08-03T08:30:00Z",
    windowStart: "2026-07-04T08:30:00Z",
    windowEnd: "2026-08-03T08:30:00Z",
    latestReportAt: "2026-08-03T01:00:00Z",
    reportingDays: 1,
    reportCount: 1,
    totalMessages: 100,
    sourceCount: 1,
    sourceListTruncated: false,
    alignment: {
      bothPass: 70,
      dkimOnlyPass: 10,
      spfOnlyPass: 5,
      neitherPass: 15,
      alignedPct: 0.85,
    },
    disposition: { none: 90, quarantine: 5, reject: 5, unknown: 0 },
    topSources: [source()],
    topFailingSources: [],
    suggestions: [
      {
        code: "alignment_low",
        severity: "warning",
        action: "Review the unaligned source evidence.",
        reason: "15 messages had no aligned authentication result.",
      },
    ],
    series: [
      { date: "2026-08-03", messages: 100, aligned: 85, alignedPct: 0.85 },
    ],
    latestPolicy: "none",
  };
}

describe("DMARC fail-closed wire decoders", () => {
  it("accepts a reconciled bounded report envelope and rejects forged metadata", () => {
    const valid = reportEnvelope();
    expect(parseDmarcReports(valid)).toMatchObject({
      items: [{ id: REPORT_ID, passCount: 85, failCount: 15 }],
      meta: { returned: 1, totalReports: 1, hasMore: false },
    });
    expect(
      parseDmarcReports(valid, {
        from: "2026-07-04T08:30:00.000Z",
        to: "2026-08-03T08:30:00.000Z",
        limit: 500,
      }),
    ).not.toBeNull();
    expect(
      parseDmarcReports(valid, {
        domain: "other.example.com",
        from: "2026-07-04T08:30:00.000Z",
        to: "2026-08-03T08:30:00.000Z",
        limit: 500,
      }),
    ).toBeNull();

    expect(
      parseDmarcReports({
        ...valid,
        meta: { ...valid.meta, returned: 2 },
      }),
    ).toBeNull();
    expect(
      parseDmarcReports({
        ...valid,
        items: [{ ...valid.items[0], orgEmail: "private@example.com" }],
      }),
    ).toBeNull();
    expect(
      parseDmarcReports({
        ...valid,
        items: [
          {
            ...valid.items[0],
            dateBegin: "2026-02-30T00:00:00Z",
            dateEnd: "2026-03-02T00:00:00Z",
          },
        ],
      }),
    ).toBeNull();
    expect(
      parseDmarcReports({
        ...valid,
        meta: { ...valid.meta, generatedAt: "2026-08-03T08:30:00" },
      }),
    ).toBeNull();
    expect(
      parseDmarcReports({
        ...valid,
        items: [{ ...valid.items[0], id: "not-a-uuid" }],
      }),
    ).toBeNull();
    expect(
      parseDmarcReports({
        ...valid,
        meta: {
          ...valid.meta,
          availableDomains: ["z.example.com", "a.example.com"],
        },
      }),
    ).toBeNull();
    expect(
      parseDmarcReports({
        ...valid,
        items: [
          valid.items[0],
          {
            ...valid.items[0],
            id: "223e4567-e89b-42d3-a456-426614174000",
            dateEnd: "2026-08-04T00:00:00Z",
          },
        ],
        meta: {
          ...valid.meta,
          returned: 2,
          totalReports: 2,
        },
      }),
    ).toBeNull();
  });

  it("accepts reconciled insights and rejects invented totals or DNS actuation", () => {
    const valid = insights();
    expect(parseDmarcInsights(valid)).toMatchObject({
      totalMessages: 100,
      alignment: { alignedPct: 0.85 },
      reportingDays: 1,
    });
    expect(
      parseDmarcInsights(valid, { domain: "mail.example.com", days: 30 }),
    ).not.toBeNull();
    expect(
      parseDmarcInsights(valid, { domain: "mail.example.com", days: 7 }),
    ).toBeNull();
    expect(
      parseDmarcInsights({
        ...valid,
        alignment: { ...valid.alignment, neitherPass: 14 },
      }),
    ).toBeNull();
    expect(
      parseDmarcInsights({
        ...valid,
        latestReportAt: undefined,
      }),
    ).toBeNull();
    expect(
      parseDmarcInsights({
        ...valid,
        series: [{ ...valid.series[0], date: "2026-02-30" }],
      }),
    ).toBeNull();
    expect(
      parseDmarcInsights({
        ...valid,
        suggestions: [
          {
            ...valid.suggestions[0],
            code: "future_unreviewed_rule",
          },
        ],
      }),
    ).toBeNull();
    expect(
      parseDmarcInsights({
        ...valid,
        series: [{ ...valid.series[0], messages: 99 }],
      }),
    ).toBeNull();
    expect(
      parseDmarcInsights({
        ...valid,
        domain: "",
      }),
    ).toBeNull();
    expect(
      parseDmarcInsights({
        ...valid,
        latestPolicy: undefined,
      }),
    ).toBeNull();
    expect(
      parseDmarcInsights({
        ...valid,
        suggestions: [
          {
            ...valid.suggestions[0],
            policyRecord: "v=DMARC1; p=reject",
          },
        ],
      }),
    ).toBeNull();
  });

  it("validates IPs, UUID report keys, requested scope, and source truncation", () => {
    const detail = {
      sourceIp: "2001:db8::10",
      domain: "mail.example.com",
      periodDays: 30,
      generatedAt: "2026-08-03T08:30:00Z",
      windowStart: "2026-07-04T08:30:00Z",
      windowEnd: "2026-08-03T08:30:00Z",
      hasMore: false,
      summary: source(),
      perReport: [
        {
          reportId: REPORT_ID,
          orgName: "Example Receiver",
          dateBegin: "2026-08-02T00:00:00Z",
          dateEnd: "2026-08-03T00:00:00Z",
          messages: 100,
          dkimPass: 80,
          spfPass: 75,
          bothPass: 70,
          alignedPct: 0.85,
          primaryDisposition: "none",
        },
      ],
    };
    expect(
      parseDmarcSourceDetail(detail, {
        ip: "2001:db8::10",
        domain: "mail.example.com",
        days: 30,
      }),
    ).not.toBeNull();
    expect(
      parseDmarcSourceDetail(
        {
          ...detail,
          sourceIp: "999.999.999.999",
          summary: { ...source(), sourceIp: "999.999.999.999" },
        },
        { ip: "999.999.999.999", domain: "mail.example.com", days: 30 },
      ),
    ).toBeNull();
    expect(
      parseDmarcSourceDetail(detail, {
        ip: "2001:db8::10",
        domain: "other.example.com",
        days: 30,
      }),
    ).toBeNull();
    expect(
      parseDmarcSourceDetail(
        {
          ...detail,
          perReport: [{ ...detail.perReport[0], messages: 99 }],
        },
        { ip: "2001:db8::10", domain: "mail.example.com", days: 30 },
      ),
    ).toBeNull();
    expect(
      parseDmarcSourceDetail(
        { ...detail, hasMore: true },
        { ip: "2001:db8::10", domain: "mail.example.com", days: 30 },
      ),
    ).toBeNull();
  });
});

describe("DMARC export and range receipts", () => {
  it("uses a rolling range boundary and neutralizes spreadsheet formulas", () => {
    expect(rangeStart("30d", new Date("2026-08-03T08:30:00Z"))).toBe(
      "2026-07-04T08:30:00.000Z",
    );
    const parsed = parseDmarcReports(reportEnvelope());
    expect(parsed).not.toBeNull();
    const row = { ...parsed!.items[0]!, orgName: '=WEBSERVICE("https://bad")' };
    const csv = buildDmarcCsv([row], {
      exportedAt: "2026-08-03T08:31:00Z",
      snapshotGeneratedAt: "2026-08-03T08:30:00Z",
      scopeDomain: "mail.example.com",
      scopeFrom: "2026-07-04T08:30:00Z",
      scopeTo: "2026-08-03T08:30:00Z",
      scopeWindowDays: 30,
      localFilter: "all",
      localQuery: "none",
      totalReports: 2,
      partial: true,
      stale: false,
    });
    expect(csv).toContain("export_created_at,snapshot_generated_at");
    expect(csv).toContain("partial_export,stale_snapshot,postwave_receipt_id");
    expect(csv).toContain("2026-08-03T08:31:00Z,2026-08-03T08:30:00Z");
    expect(csv).toContain(",true,false,123e4567-e89b-42d3-a456-426614174000");
    expect(csv).toContain('"\'=WEBSERVICE(""https://bad"")"');
  });

  it("does not classify a zero-message receipt as fully aligned", () => {
    const row = parseDmarcReports(reportEnvelope())!.items[0]!;
    expect(
      filterDmarcReports(
        [{ ...row, passCount: 0, failCount: 0 }],
        "aligned",
        "",
      ),
    ).toEqual([]);
  });
});
