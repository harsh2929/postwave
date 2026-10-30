import { describe, expect, it } from "vitest";

import { smsInboxHoldBanner } from "./smsInboxHoldRollup";

const HASH = "a".repeat(64);

describe("smsInboxHoldBanner", () => {
  it("is silent when no hold exists", () => {
    expect(smsInboxHoldBanner({ status: "none" }, null)).toBeNull();
  });

  it("names the visible conversation carrying the hold and offers to open it", () => {
    const banner = smsInboxHoldBanner(
      {
        status: "held",
        state: "reconciliation_required",
        threadHash: HASH,
        createdAt: "2026-08-21T09:00:00Z",
      },
      "+15552345678",
    );
    expect(banner?.tone).toBe("warning");
    expect(banner?.targetPhone).toBe("+15552345678");
    expect(banner?.text).toContain("+15552345678");
    expect(banner?.text).toContain("provider outcome is still uncertain");
  });

  it("stays unnamed for a hold outside the visible page", () => {
    const banner = smsInboxHoldBanner(
      {
        status: "held",
        state: "pending",
        threadHash: HASH,
        createdAt: "2026-08-21T09:00:00Z",
      },
      null,
    );
    expect(banner?.targetPhone).toBeUndefined();
    expect(banner?.text).toContain("not in this view");
    expect(banner?.text).toContain("never confirmed");
  });

  it("reports another identity's hold and a storage failure distinctly", () => {
    expect(
      smsInboxHoldBanner(
        { status: "other_identity", state: "pending" },
        null,
      )?.text,
    ).toContain("Another workspace identity");
    const storage = smsInboxHoldBanner({ status: "storage_unavailable" }, null);
    expect(storage?.tone).toBe("danger");
    expect(storage?.text).toContain("could not be verified");
  });

  it("never suggests retrying a held send", () => {
    for (const banner of [
      smsInboxHoldBanner(
        { status: "held", state: "pending", threadHash: HASH, createdAt: "2026-08-21T09:00:00Z" },
        "+15552345678",
      ),
      smsInboxHoldBanner({ status: "other_identity", state: "pending" }, null),
      smsInboxHoldBanner({ status: "storage_unavailable" }, null),
    ]) {
      expect(banner?.text.toLowerCase()).not.toContain("retry");
      expect(banner?.text.toLowerCase()).not.toContain("resend it");
    }
  });
});
