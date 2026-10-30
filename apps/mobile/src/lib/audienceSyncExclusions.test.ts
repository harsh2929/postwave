/**
 * The activation firewall's two read surfaces, in their pure half.
 *
 * The assertion that matters most is the -1 sentinel: the server answers -1 for
 * every count when it could not resolve the source, and rendering that as 0
 * would tell an operator "nobody is withheld" when the truth is "we do not
 * know". Everything else here guards the receipt: an injection-safe re-emit and
 * a cap that is stated rather than silent.
 */
import { describe, expect, it } from "vitest";

import {
  EXCLUSION_RECEIPT_MAX_ROWS,
  exclusionPreviewErrorMessage,
  exclusionPreviewLines,
  exclusionReceiptErrorMessage,
  exclusionReceiptShare,
  parseSyncExclusionPreview,
  receiptRunForHistory,
} from "./audienceSyncExclusions";

const WIRE = {
  audience_count: 1200,
  excluded_consent: 40,
  excluded_suppression: 8,
  excluded_total: 48,
  purpose: "marketing",
  computed_at: "2026-09-01T10:00:00Z",
};

describe("parseSyncExclusionPreview", () => {
  it("keeps real counts", () => {
    const preview = parseSyncExclusionPreview(WIRE);
    expect(preview).toMatchObject({
      audienceCount: 1200,
      excludedConsent: 40,
      excludedSuppression: 8,
      excludedTotal: 48,
      purpose: "marketing",
      unavailable: false,
    });
    expect(preview.computedAt).toBe("2026-09-01T10:00:00Z");
  });

  it("turns the -1 unavailable sentinel into null, never 0", () => {
    const preview = parseSyncExclusionPreview({
      audience_count: -1,
      excluded_consent: -1,
      excluded_suppression: -1,
      excluded_total: -1,
      purpose: "marketing",
      computed_at: "2026-09-01T10:00:00Z",
    });
    expect(preview.audienceCount).toBeNull();
    expect(preview.excludedTotal).toBeNull();
    expect(preview.unavailable).toBe(true);
  });

  it("does not call a genuine zero unavailable", () => {
    const preview = parseSyncExclusionPreview({
      ...WIRE,
      excluded_consent: 0,
      excluded_suppression: 0,
      excluded_total: 0,
    });
    expect(preview.excludedTotal).toBe(0);
    expect(preview.unavailable).toBe(false);
  });

  it("survives a shape it did not expect", () => {
    const preview = parseSyncExclusionPreview("nope");
    expect(preview.unavailable).toBe(true);
    expect(preview.purpose).toBe("");
    expect(preview.computedAt).toBeNull();
  });
});

describe("exclusionPreviewLines", () => {
  it("says 'could not resolve' instead of showing zeroes", () => {
    const lines = exclusionPreviewLines(
      parseSyncExclusionPreview({ ...WIRE, audience_count: -1, excluded_consent: -1, excluded_suppression: -1, excluded_total: -1 }),
    );
    expect(lines.join(" ")).toContain("could not resolve");
    expect(lines.join(" ")).not.toMatch(/\b0 withheld/);
  });

  it("labels the answer a forecast, never history", () => {
    const lines = exclusionPreviewLines(parseSyncExclusionPreview(WIRE));
    expect(lines.join(" ")).toContain("forecast for the next run");
    expect(lines.join(" ")).toContain("nothing was sent");
  });

  it("names the two exclusion classes the server actually splits", () => {
    const lines = exclusionPreviewLines(parseSyncExclusionPreview(WIRE));
    expect(lines[1]).toContain("40 withheld for consent");
    expect(lines[2]).toContain("8 withheld because they are suppressed");
    expect(lines[3]).toContain("48 withheld in total");
  });

  it("renders a missing count as 'not reported' rather than a number", () => {
    const lines = exclusionPreviewLines(
      parseSyncExclusionPreview({ ...WIRE, excluded_suppression: null }),
    );
    expect(lines[2]).toContain("not reported");
  });
});

describe("exclusionReceiptShare", () => {
  const header =
    "subscriber_email,rule_class,rule_reason,purpose,consent_event_id,excluded_at,signature";

  it("strips the server's header and re-emits its own", () => {
    const out = exclusionReceiptShare(
      `${header}\na@example.test,consent,no_consent,marketing,7,2026-09-01T10:00:00Z,sig1`,
      { syncName: "Warehouse mirror" },
    );
    expect(out.included).toBe(1);
    expect(out.body.split("\n")[0]).toBe(header);
    expect(out.body).toContain("a@example.test");
    expect(out.title).toBe("Warehouse mirror — exclusion receipt (1 withheld)");
    expect(out.truncated).toBe(false);
  });

  it("neutralises a spreadsheet formula the server did not escape", () => {
    const out = exclusionReceiptShare(
      `${header}\n=cmd|'/c calc'!A1,consent,no_consent,marketing,,2026-09-01T10:00:00Z,sig`,
      { syncName: "s" },
    );
    expect(out.body).toContain("'=cmd");
  });

  it("caps, and says so in the title", () => {
    const rows = Array.from(
      { length: 5 },
      (_, index) =>
        `${index}@example.test,suppression,bounced,marketing,,2026-09-01T10:00:00Z,sig`,
    ).join("\n");
    const out = exclusionReceiptShare(`${header}\n${rows}`, {
      syncName: "s",
      cap: 2,
    });
    expect(out.included).toBe(2);
    expect(out.truncated).toBe(true);
    expect(out.title).toContain("first 2 of more");
  });

  it("treats an exactly-full response as truncated — it may be a slice", () => {
    const out = exclusionReceiptShare(
      `${header}\na@example.test,consent,no_consent,marketing,,2026-09-01T10:00:00Z,sig`,
      { syncName: "s", cap: 1 },
    );
    expect(out.truncated).toBe(true);
  });

  it("reports an empty receipt as zero rows rather than throwing", () => {
    const out = exclusionReceiptShare("", { syncName: "s" });
    expect(out.included).toBe(0);
    expect(out.body).toBe(header);
  });

  it("has a cap worth having", () => {
    expect(EXCLUSION_RECEIPT_MAX_ROWS).toBeGreaterThan(0);
  });
});

describe("receiptRunForHistory", () => {
  const run = (id: string, excludedCount: number | null) => ({
    id,
    status: "success",
    excludedCount,
    finishedAt: null,
  });

  it("picks the newest run that actually withheld someone", () => {
    // Server order is started_at DESC, and this preserves it.
    expect(
      receiptRunForHistory([run("r3", 0), run("r2", 5), run("r1", 9)])?.id,
    ).toBe("r2");
  });

  it("offers nothing when no run withheld anyone", () => {
    expect(receiptRunForHistory([run("r1", 0), run("r2", null)])).toBeNull();
    expect(receiptRunForHistory([])).toBeNull();
  });
});

describe("error copy", () => {
  it("explains WHY the receipt needs an admin", () => {
    expect(exclusionReceiptErrorMessage({ status: 403 })).toContain(
      "subscriber emails",
    );
  });

  it("keeps the preview's 403 about the reader's role", () => {
    expect(exclusionPreviewErrorMessage({ status: 403 })).toContain(
      "Your role cannot preview",
    );
  });

  it("only claims the network when a status of 0 is present", () => {
    expect(exclusionPreviewErrorMessage({ status: 0 })).toContain(
      "never reached the server",
    );
    expect(exclusionPreviewErrorMessage({ message: "boom" })).toBe("boom");
    expect(exclusionReceiptErrorMessage(undefined)).toBe(
      "The exclusion receipt could not be downloaded.",
    );
  });
});
