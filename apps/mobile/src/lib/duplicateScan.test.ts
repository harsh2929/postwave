import { describe, expect, it } from "vitest";

import {
  duplicateScanVerdict,
  evidenceLabel,
  mergePairPages,
  normalizeDuplicatePairs,
  normalizeDuplicateScan,
  normalizeDuplicateScanPage,
  pairBlockedReason,
  pairKey,
  reviewBlockedReason,
  scanIsExpired,
  staleLoadedCount,
  type DuplicatePair,
} from "@/lib/duplicateScan";

const SCAN = {
  scan_id: "11111111-1111-4111-8111-111111111111",
  status: "complete",
  subscriber_count: 4210,
  candidate_count: 3,
  created_at: "2026-07-25T09:00:00Z",
  completed_at: "2026-07-25T09:00:04Z",
  expires_at: "2026-07-26T09:00:04Z",
  complete: true,
};

function pair(over: Record<string, unknown> = {}) {
  return {
    primary_id: "aaaaaaaa-1111-4111-8111-111111111111",
    primary_email: "ada@example.com",
    duplicate_id: "bbbbbbbb-2222-4222-8222-222222222222",
    duplicate_email: "Ada@example.com",
    primary_updated_at: "2026-07-20T00:00:00Z",
    duplicate_updated_at: "2026-07-21T00:00:00Z",
    kind: "case_diff",
    confidence: 1,
    evidence: [
      {
        kind: "case_diff",
        confidence: 1,
        reason:
          "The stored email addresses normalize to the same case-insensitive value.",
      },
    ],
    stale: false,
    ...over,
  };
}

describe("normalizeDuplicateScan", () => {
  it("reads the scan envelope the Go struct actually sends", () => {
    const scan = normalizeDuplicateScan(SCAN);
    expect(scan?.id).toBe(SCAN.scan_id);
    expect(scan?.subscriberCount).toBe(4210);
    expect(scan?.candidateCount).toBe(3);
    expect(scan?.complete).toBe(true);
  });

  it("keeps an ABSENT count null rather than calling it zero", () => {
    const scan = normalizeDuplicateScan({
      ...SCAN,
      subscriber_count: undefined,
      candidate_count: null,
    });
    // A missing measurement is unknown. Rendering 0 would tell an operator the
    // workspace is empty when the server simply did not say.
    expect(scan?.subscriberCount).toBeNull();
    expect(scan?.candidateCount).toBeNull();
  });

  it("derives `complete` from the status when the flag is absent", () => {
    expect(
      normalizeDuplicateScan({ ...SCAN, complete: undefined })?.complete,
    ).toBe(true);
    expect(
      normalizeDuplicateScan({ ...SCAN, complete: undefined, status: "running" })
        ?.complete,
    ).toBe(false);
  });

  it("is null without an id — a scan we cannot address is not a scan", () => {
    expect(normalizeDuplicateScan({ ...SCAN, scan_id: "" })).toBeNull();
    expect(normalizeDuplicateScan(null)).toBeNull();
  });
});

describe("normalizeDuplicatePairs", () => {
  it("carries both instants, because the merge route binds to them", () => {
    const [row] = normalizeDuplicatePairs([pair()]);
    expect(row?.primaryUpdatedAt).toBe("2026-07-20T00:00:00Z");
    expect(row?.duplicateUpdatedAt).toBe("2026-07-21T00:00:00Z");
  });

  it("drops a row that cannot be reviewed OR merged", () => {
    expect(normalizeDuplicatePairs([pair({ duplicate_id: "" })])).toEqual([]);
    // primary === duplicate is `same_subscriber` at the API (apply.go:211).
    expect(
      normalizeDuplicatePairs([
        pair({ duplicate_id: "aaaaaaaa-1111-4111-8111-111111111111" }),
      ]),
    ).toEqual([]);
  });

  it("re-derives kind from the evidence when the field is missing", () => {
    const [row] = normalizeDuplicatePairs([pair({ kind: undefined })]);
    expect(row?.kind).toBe("case_diff");
  });

  it("refuses a confidence outside [0,1] instead of rendering it", () => {
    expect(normalizeDuplicatePairs([pair({ confidence: 7 })])[0]?.confidence).toBeNull();
    expect(normalizeDuplicatePairs([pair({ confidence: "1" })])[0]?.confidence).toBeNull();
  });

  it("treats a non-array payload as no pairs, never as a crash", () => {
    expect(normalizeDuplicatePairs(undefined)).toEqual([]);
    expect(normalizeDuplicatePairs({ pairs: [] })).toEqual([]);
  });
});

describe("normalizeDuplicateScanPage", () => {
  it("falls back to the scan's candidate_count when `count` is absent", () => {
    const page = normalizeDuplicateScanPage({ scan: SCAN, pairs: [pair()] });
    expect(page.count).toBe(3);
    expect(page.pairs).toHaveLength(1);
    expect(page.nextCursor).toBe("");
  });

  it("keeps the cursor verbatim so paging cannot drift", () => {
    const page = normalizeDuplicateScanPage({
      scan: SCAN,
      pairs: [pair()],
      count: 3,
      next_cursor: "25",
      complete: true,
    });
    expect(page.nextCursor).toBe("25");
  });
});

describe("mergePairPages", () => {
  it("keeps first-seen order and drops a repeated key", () => {
    const first = normalizeDuplicatePairs([pair()]);
    const second = normalizeDuplicatePairs([
      pair(),
      pair({
        duplicate_id: "cccccccc-3333-4333-8333-333333333333",
        duplicate_email: "ada+news@example.com",
      }),
    ]);
    const merged = mergePairPages([first, second]);
    expect(merged).toHaveLength(2);
    expect(merged.map((row) => pairKey(row))).toEqual([
      "aaaaaaaa-1111-4111-8111-111111111111:bbbbbbbb-2222-4222-8222-222222222222",
      "aaaaaaaa-1111-4111-8111-111111111111:cccccccc-3333-4333-8333-333333333333",
    ]);
  });
});

describe("pairBlockedReason", () => {
  const base = normalizeDuplicatePairs([pair()])[0] as DuplicatePair;

  it("is empty for a fresh pair", () => {
    expect(pairBlockedReason(base)).toBe("");
  });

  it("names the stale case, which the server refuses with 409", () => {
    expect(pairBlockedReason({ ...base, stale: true })).toContain(
      "changed after the scan",
    );
  });

  it("blocks a pair the scan gave no instants for", () => {
    expect(pairBlockedReason({ ...base, duplicateUpdatedAt: "" })).toContain(
      "did not record a version",
    );
  });

  it("blocks EVERY pair under an expired manifest, and says whose fault it is", () => {
    // apply.go requires `scan.expires_at > now()` inside the transaction, so a
    // pair that is individually fine still cannot be merged.
    expect(reviewBlockedReason(base, false)).toBe("");
    const expired = reviewBlockedReason(base, true);
    expect(expired).toContain("This scan has expired");
    expect(expired).toContain("scan again");
  });

  it("prefers the scan-level reason over the per-pair one", () => {
    expect(reviewBlockedReason({ ...base, stale: true }, true)).toContain(
      "This scan has expired",
    );
  });
});

describe("duplicateScanVerdict", () => {
  it("states zero as a WORKSPACE total, because candidate_count is one", () => {
    const scan = normalizeDuplicateScan({ ...SCAN, candidate_count: 0 });
    const verdict = duplicateScanVerdict(scan);
    expect(verdict).toContain("No duplicate candidates");
    expect(verdict).toContain("across 4,210 people");
    expect(verdict).toContain("whole workspace, not a sample");
  });

  it("does not claim a total the server never sent", () => {
    const scan = normalizeDuplicateScan({ ...SCAN, candidate_count: null });
    expect(duplicateScanVerdict(scan)).toContain("did not report a candidate total");
  });

  it("says a running scan is still running rather than reporting its numbers", () => {
    const scan = normalizeDuplicateScan({
      ...SCAN,
      status: "running",
      complete: false,
    });
    expect(duplicateScanVerdict(scan)).toContain("still being materialized");
  });

  it("has an answer for no scan at all", () => {
    expect(duplicateScanVerdict(null)).toBe("No scan has run yet.");
  });
});

describe("scanIsExpired", () => {
  const scan = normalizeDuplicateScan(SCAN);
  it("matches the server's `expires_at > now()` precondition", () => {
    expect(scanIsExpired(scan, Date.parse("2026-07-26T08:59:00Z"))).toBe(false);
    expect(scanIsExpired(scan, Date.parse("2026-07-26T09:00:05Z"))).toBe(true);
  });
  it("never guesses when the server sent no expiry", () => {
    expect(
      scanIsExpired(normalizeDuplicateScan({ ...SCAN, expires_at: "" }), Date.now()),
    ).toBe(false);
  });
});

describe("evidenceLabel + staleLoadedCount", () => {
  it("labels the seven server rules and keeps an unknown one verbatim", () => {
    expect(evidenceLabel("case_diff")).toBe("Same address, different case");
    expect(evidenceLabel("external_id_collision")).toBe(
      "Same upstream profile id",
    );
    // A rule that ships server-side before the app updates must still name
    // itself rather than collapsing into "Other".
    expect(evidenceLabel("shipping_address_match")).toBe(
      "shipping_address_match",
    );
    expect(evidenceLabel("")).toBe("Unlabelled match");
  });

  it("counts only the pairs the device is actually holding", () => {
    const rows = normalizeDuplicatePairs([pair(), pair({ stale: true, duplicate_id: "cccccccc-3333-4333-8333-333333333333" })]);
    expect(staleLoadedCount(rows)).toBe(1);
  });
});
