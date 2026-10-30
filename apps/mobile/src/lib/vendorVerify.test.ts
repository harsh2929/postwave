import { describe, expect, it, vi } from "vitest";

import { WireShapeError } from "./deliverabilityContracts";
import {
  nextVendorVerifyAttempt,
  normalizeVerifyAddress,
  parseVendorVerifyResult,
  vendorVerifyConfirmation,
  vendorVerifyInputError,
  vendorVerifyResultLine,
  vendorVerifySpendLine,
  type VendorVerifyResult,
} from "./vendorVerify";

const result = (extra: Partial<VendorVerifyResult> = {}): VendorVerifyResult =>
  parseVendorVerifyResult({
    email: "a@example.com",
    status: "valid",
    provider: "zerobounce",
    billable: true,
    cached: false,
    ...extra,
    ...(extra.subStatus ? { sub_status: extra.subStatus } : {}),
    ...(extra.didYouMean ? { did_you_mean: extra.didYouMean } : {}),
  });

describe("vendorVerifyInputError", () => {
  it("refuses only what the server refuses, plus a non-address", () => {
    expect(vendorVerifyInputError("  ")).toBe("Enter an email address to check.");
    expect(vendorVerifyInputError(`a@${"b".repeat(400)}.com`)).toContain(
      "at most 320 characters",
    );
    expect(vendorVerifyInputError("no-at-sign")).toBe(
      "That doesn't look like an email address.",
    );
    expect(vendorVerifyInputError("a b@example.com")).toBe(
      "That doesn't look like an email address.",
    );
  });

  it("rejects the control and format runes the server rejects", () => {
    expect(vendorVerifyInputError("a\u0000b@example.com")).toContain(
      "characters an email address cannot have",
    );
    expect(vendorVerifyInputError("a\u200bb@example.com")).toContain(
      "characters an email address cannot have",
    );
  });

  it("accepts an ordinary address", () => {
    expect(vendorVerifyInputError("  Person@Example.COM ")).toBeNull();
    expect(normalizeVerifyAddress("  Person@Example.COM ")).toBe(
      "person@example.com",
    );
  });
});

describe("nextVendorVerifyAttempt", () => {
  it("mints a key on the first attempt", () => {
    const mint = vi.fn(() => "key-1");
    const attempt = nextVendorVerifyAttempt(null, "A@b.com", mint);
    expect(attempt).toEqual({ email: "a@b.com", key: "key-1", settled: false });
    expect(mint).toHaveBeenCalledTimes(1);
  });

  it("REUSES the key when the same address never settled, so a retry replays", () => {
    const mint = vi.fn(() => "key-2");
    const first = { email: "a@b.com", key: "key-1", settled: false };
    const again = nextVendorVerifyAttempt(first, "a@b.com", mint);
    expect(again.key).toBe("key-1");
    expect(mint).not.toHaveBeenCalled();
  });

  it("mints a new key once the previous attempt settled", () => {
    const mint = vi.fn(() => "key-2");
    const settled = { email: "a@b.com", key: "key-1", settled: true };
    expect(nextVendorVerifyAttempt(settled, "a@b.com", mint).key).toBe("key-2");
  });

  it("mints a new key for a different address", () => {
    const mint = vi.fn(() => "key-2");
    const other = { email: "a@b.com", key: "key-1", settled: false };
    expect(nextVendorVerifyAttempt(other, "c@d.com", mint).key).toBe("key-2");
  });
});

describe("vendorVerifyConfirmation", () => {
  it("states that the paid vendor is called before anything is sent", () => {
    const copy = vendorVerifyConfirmation(" Person@Example.com ");
    expect(copy.consequence).toContain("person@example.com");
    expect(copy.consequence).toContain("verification vendor");
    expect(copy.consequence).toContain("charges one provider credit");
  });
});

describe("parseVendorVerifyResult", () => {
  it("rejects a payload with no status rather than inventing 'unknown'", () => {
    expect(() => parseVendorVerifyResult({ email: "a@b.com" })).toThrow(
      WireShapeError,
    );
    expect(() => parseVendorVerifyResult(null)).toThrow(WireShapeError);
    expect(() =>
      parseVendorVerifyResult({ status: "valid", score: "high" }),
    ).toThrow(WireShapeError);
  });

  it("defaults the flags to false rather than to a spend", () => {
    const parsed = parseVendorVerifyResult({ status: "unknown" });
    expect(parsed.billable).toBe(false);
    expect(parsed.cached).toBe(false);
    expect(parsed.score).toBeNull();
  });
});

describe("vendorVerifyResultLine", () => {
  it("uses the server's vocabulary for each verdict", () => {
    expect(vendorVerifyResultLine(result({ status: "spamtrap" }))).toContain(
      "damages sender reputation",
    );
    expect(vendorVerifyResultLine(result({ status: "catch_all" }))).toContain(
      "accepts everything",
    );
  });

  it("attaches the sub-status, score and typo suggestion when present", () => {
    const line = vendorVerifyResultLine(
      result({ subStatus: "mailbox_not_found", didYouMean: "a@example.com" }),
    );
    expect(line).toContain("mailbox not found");
    expect(line).toContain("did you mean a@example.com");
  });
});

describe("vendorVerifySpendLine", () => {
  it("never calls a free answer a purchase", () => {
    expect(vendorVerifySpendLine(result({ cached: true, billable: false }))).toContain(
      "no credit spent",
    );
    expect(
      vendorVerifySpendLine(result({ billable: false, provider: "local" })),
    ).toContain("no credit spent");
  });

  it("names the vendor that was actually charged", () => {
    expect(vendorVerifySpendLine(result())).toBe(
      "One provider credit spent with zerobounce.",
    );
  });

  it("says so when the server reported no credit at all", () => {
    expect(
      vendorVerifySpendLine(result({ billable: false, provider: "" })),
    ).toBe("The server did not report a credit for this check.");
  });
});
