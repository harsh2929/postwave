/**
 * Auto-remediation row helpers (#38-#41 of the 2026-06-11 wiring
 * backlog):
 *
 *   1. retryActionsFor — verdict buttons must only appear on rows the
 *      worker hasn't resolved (mirrors intelligent_retry transitions);
 *   2. replaceRetryEvent — the mark-ready/dismiss responses are spliced
 *      in place; must be pure, id-targeted, and a no-op on unknown ids;
 *   3. retryStatusBadgeClass — every server status maps to a badge,
 *      unknown statuses stay neutral;
 *   4. ISP helpers — fraction→percent rendering, volume sort, and the
 *      bounce/complaint attention thresholds;
 *   5. campaign-options — the items|results|data envelope fallback and
 *      label preference chain feeding the pickers.
 */

import { describe, expect, it } from "vitest";

import {
  formatWhen,
  replaceRetryEvent,
  retryActionsFor,
  retryStatusBadgeClass,
} from "../../components/deliverability/remediation-helpers";
import {
  formatRate,
  ispRowSeverity,
  parseIspBuckets,
  sortIspBuckets,
} from "../../components/deliverability/isp-breakdown-helpers";
import {
  campaignsFromResponse,
  toCampaignOptions,
} from "../../components/deliverability/campaign-options";
import type { ISPBucket, IntelligentRetryEvent } from "../../lib/api-client";

function event(
  overrides: Partial<IntelligentRetryEvent> = {},
): IntelligentRetryEvent {
  return {
    id: "evt-1",
    tenant_id: "tenant-1",
    campaign_id: "c-1",
    subscriber_email: "a@example.com",
    reason: "frequency_cap",
    status: "pending",
    retry_after: "2026-06-12T00:00:00Z",
    attempts: 0,
    created_at: "2026-06-11T00:00:00Z",
    updated_at: "2026-06-11T00:00:00Z",
    ...overrides,
  };
}

describe("retryActionsFor — server-transition mirror", () => {
  it("pending rows can be marked ready or dismissed", () => {
    expect(retryActionsFor("pending")).toEqual({
      markReady: true,
      dismiss: true,
    });
  });

  it("ready rows can only be dismissed; dismissed only revived", () => {
    expect(retryActionsFor("ready")).toEqual({
      markReady: false,
      dismiss: true,
    });
    expect(retryActionsFor("dismissed")).toEqual({
      markReady: true,
      dismiss: false,
    });
  });

  it("worker-owned states get no operator verdicts", () => {
    for (const s of ["retrying", "retried", "failed", "weird"]) {
      expect(retryActionsFor(s)).toEqual({
        markReady: false,
        dismiss: false,
      });
    }
  });
});

describe("replaceRetryEvent — pure id-targeted splice", () => {
  const rows = [event(), event({ id: "evt-2", status: "ready" })];

  it("replaces only the matching row", () => {
    const updated = event({ status: "dismissed" });
    const next = replaceRetryEvent(rows, updated);
    expect(next).toHaveLength(2);
    expect(next[0]?.status).toBe("dismissed");
    expect(next[1]).toBe(rows[1]); // untouched reference
    expect(rows[0]?.status).toBe("pending"); // input not mutated
  });

  it("returns the same array for unknown ids", () => {
    const next = replaceRetryEvent(rows, event({ id: "nope" }));
    expect(next).toBe(rows);
  });
});

describe("retryStatusBadgeClass", () => {
  it("maps every server status", () => {
    expect(retryStatusBadgeClass("retried")).toBe("badge success");
    expect(retryStatusBadgeClass("ready")).toBe("badge accent");
    expect(retryStatusBadgeClass("retrying")).toBe("badge accent");
    expect(retryStatusBadgeClass("failed")).toBe("badge danger");
    expect(retryStatusBadgeClass("pending")).toBe("badge warning");
    expect(retryStatusBadgeClass("dismissed")).toBe("badge");
  });

  it("keeps unknown statuses neutral (never paint them green)", () => {
    expect(retryStatusBadgeClass("future_state")).toBe("badge");
  });
});

describe("formatWhen", () => {
  it("renders — for empty / invalid timestamps (no fake dates)", () => {
    expect(formatWhen(undefined)).toBe("—");
    expect(formatWhen("")).toBe("—");
    expect(formatWhen("not-a-date")).toBe("—");
  });

  it("renders a locale string for valid timestamps", () => {
    expect(formatWhen("2026-06-11T08:00:00Z")).not.toBe("—");
  });
});

function bucket(overrides: Partial<ISPBucket> = {}): ISPBucket {
  return {
    isp: "gmail.com",
    subscribers: 100,
    sent: 1000,
    opens: 400,
    clicks: 50,
    bounces: 5,
    complaints: 0,
    open_rate: 0.4,
    click_rate: 0.05,
    bounce_rate: 0.005,
    complaint_rate: 0,
    ...overrides,
  };
}

describe("ISP breakdown helpers", () => {
  it("rejects malformed successful bucket payloads before renderer sorting", () => {
    expect(parseIspBuckets(undefined)).toBeNull();
    expect(parseIspBuckets([{ sent: 5 }])).toBeNull();
    expect(
      parseIspBuckets([
        {
          isp: "Gmail",
          subscribers: 10,
          sent: 9,
          opens: 5,
          clicks: 2,
          bounces: 1,
          complaints: 0,
          open_rate: 0.5,
          click_rate: 0.2,
          bounce_rate: 0.1,
          complaint_rate: 0,
        },
      ]),
    ).toHaveLength(1);
  });
  it("formatRate renders fractions as one-decimal percents", () => {
    expect(formatRate(0.4)).toBe("40.0%");
    expect(formatRate(0.1234)).toBe("12.3%");
    expect(formatRate(0)).toBe("0.0%");
  });

  it("formatRate never fabricates a zero for missing data", () => {
    expect(formatRate(null)).toBe("—");
    expect(formatRate(undefined)).toBe("—");
    expect(formatRate(Number.NaN)).toBe("—");
  });

  it("sortIspBuckets orders by sent desc, name asc on ties, purely", () => {
    const a = bucket({ isp: "b.com", sent: 10 });
    const b = bucket({ isp: "a.com", sent: 10 });
    const c = bucket({ isp: "z.com", sent: 999 });
    const input = [a, b, c];
    const out = sortIspBuckets(input);
    expect(out.map((x) => x.isp)).toEqual(["z.com", "a.com", "b.com"]);
    expect(input.map((x) => x.isp)).toEqual(["b.com", "a.com", "z.com"]);
  });

  it("ispRowSeverity flags ESP attention thresholds", () => {
    expect(ispRowSeverity(bucket())).toBe("ok");
    expect(ispRowSeverity(bucket({ bounce_rate: 0.02 }))).toBe("warn");
    expect(ispRowSeverity(bucket({ complaint_rate: 0.001 }))).toBe("warn");
  });
});

describe("campaign-options — envelope fallback + labels", () => {
  it("reads items, then results, then data", () => {
    expect(campaignsFromResponse({ items: [{ id: 1 }] })).toHaveLength(1);
    expect(campaignsFromResponse({ results: [{ id: 1 }] })).toHaveLength(1);
    expect(campaignsFromResponse({ data: [{ id: 1 }] })).toHaveLength(1);
    expect(campaignsFromResponse(null)).toEqual([]);
    expect(campaignsFromResponse({})).toEqual([]);
  });

  it("drops id-less campaigns and prefers name → subject → fallback", () => {
    const opts = toCampaignOptions({
      items: [
        { id: 1, name: "June promo", status: "sent" },
        { id: 2, subject: "Hello" },
        { id: 3 },
        { name: "no id — unqueryable" },
      ],
    });
    expect(opts).toEqual([
      { id: "1", label: "June promo · sent" },
      { id: "2", label: "Hello" },
      { id: "3", label: "Campaign 3" },
    ]);
  });
});
