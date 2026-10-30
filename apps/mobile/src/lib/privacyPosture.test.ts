import { describe, expect, it } from "vitest";

import {
  parsePrivacyPosture,
  privacyPostureLine,
  resolvedPrivacyCounts,
} from "./privacyPosture";

describe("parsePrivacyPosture", () => {
  it("sums the per-request-type DSAR breakdown", () => {
    const posture = parsePrivacyPosture({
      dsar_requests: [
        { request_type: "export", open: 4, overdue: 1, closed: 20 },
        { request_type: "delete", open: 2, overdue: 2, closed: 9 },
      ],
      gpc_signaled_count: 17,
      do_not_sell_count: 3,
      double_optin_pending: 5,
      generated_at: "2026-07-25T09:00:00Z",
    });
    expect(posture).toEqual({
      open: 6,
      overdue: 3,
      gpcSignaled: 17,
      doNotSell: 3,
      doubleOptInPending: 5,
      generatedAt: "2026-07-25T09:00:00Z",
    });
  });

  it("treats an EMPTY breakdown as a real zero", () => {
    const posture = parsePrivacyPosture({ dsar_requests: [] });
    expect(posture?.open).toBe(0);
    expect(posture?.overdue).toBe(0);
  });

  it("returns null when there is no DSAR block at all — absence is not zero", () => {
    expect(parsePrivacyPosture({})).toBeNull();
    expect(parsePrivacyPosture(null)).toBeNull();
    expect(parsePrivacyPosture({ dsar_requests: "nope" })).toBeNull();
    // Rows present but unreadable: refuse rather than claim "0 overdue".
    expect(
      parsePrivacyPosture({ dsar_requests: [{ request_type: "export" }] }),
    ).toBeNull();
  });

  it("keeps unreadable side counts as null rather than 0", () => {
    const posture = parsePrivacyPosture({
      dsar_requests: [{ open: 1, overdue: 0 }],
    });
    expect(posture?.gpcSignaled).toBeNull();
    expect(posture?.generatedAt).toBeNull();
  });
});

describe("resolvedPrivacyCounts", () => {
  it("prefers the SERVER aggregate — the page count is only a floor", () => {
    expect(
      resolvedPrivacyCounts({
        posture: {
          open: 140,
          overdue: 12,
          gpcSignaled: null,
          doNotSell: null,
          doubleOptInPending: null,
          generatedAt: null,
        },
        pageOpen: 40,
        pageOverdue: 3,
        pageTruncated: true,
      }),
    ).toEqual({ open: 140, overdue: 12, scope: "tenant" });
  });

  it("falls back to the page count and flags a TRUNCATED scope", () => {
    expect(
      resolvedPrivacyCounts({
        posture: null,
        pageOpen: 40,
        pageOverdue: 3,
        pageTruncated: true,
      }),
    ).toEqual({ open: 40, overdue: 3, scope: "loaded" });
  });

  it("treats an untruncated page as the whole tenant", () => {
    expect(
      resolvedPrivacyCounts({
        posture: null,
        pageOpen: 4,
        pageOverdue: 0,
        pageTruncated: false,
      }).scope,
    ).toBe("tenant");
  });
});

describe("privacyPostureLine", () => {
  it("leads with the statutory breach", () => {
    expect(
      privacyPostureLine({ open: 9, overdue: 3, scope: "tenant" }),
    ).toBe("3 requests are past the statutory deadline · 9 open");
    expect(
      privacyPostureLine({ open: 1, overdue: 1, scope: "tenant" }),
    ).toBe("1 request is past the statutory deadline · 1 open");
  });

  it("says 'none overdue' rather than staying silent", () => {
    expect(privacyPostureLine({ open: 4, overdue: 0, scope: "tenant" })).toBe(
      "4 open requests, none overdue",
    );
    expect(privacyPostureLine({ open: 0, overdue: 0, scope: "tenant" })).toBe(
      "No open privacy requests.",
    );
  });

  it("names its own SCOPE when the number cannot speak for the tenant", () => {
    const line = privacyPostureLine({ open: 40, overdue: 3, scope: "loaded" });
    expect(line).toContain("not the whole queue");
  });
});
