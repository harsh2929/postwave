// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import {
  conversionsToCsv,
  csvCell,
  payoutsToCsv,
  toCsv,
} from "@/lib/affiliate-csv";
import type {
  AffiliateConversion,
  AffiliatePayout,
} from "@/lib/affiliates-types";

describe("csvCell", () => {
  it("passes simple values through and escapes special chars", () => {
    expect(csvCell("plain")).toBe("plain");
    expect(csvCell(12)).toBe("12");
    expect(csvCell(null)).toBe("");
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('has "quote"')).toBe('"has ""quote"""');
    expect(csvCell("line\nbreak")).toBe('"line\nbreak"');
  });
});

describe("toCsv", () => {
  it("joins with CRLF and a header row", () => {
    expect(toCsv(["a", "b"], [[1, 2], [3, 4]])).toBe("a,b\r\n1,2\r\n3,4");
  });
});

describe("conversionsToCsv", () => {
  it("emits decimal currency units and stable columns", () => {
    const rows: AffiliateConversion[] = [
      {
        id: 1,
        affiliateId: "aff_1",
        cookieId: "c1",
        kind: "ltd_purchase",
        amountCents: 34_900,
        commissionCents: 5000,
        commissionRatePct: 14.33,
        status: "approved",
        stripePaymentIntentId: "pi_123",
        createdAt: "2026-04-01T00:00:00Z",
      },
    ];
    const csv = conversionsToCsv(rows);
    const [header, first] = csv.split("\r\n");
    expect(header).toBe(
      "id,created_at,kind,status,sale_amount,commission,commission_rate_pct,stripe_payment_intent_id",
    );
    expect(first).toContain("349.00");
    expect(first).toContain("50.00");
    expect(first).toContain("pi_123");
  });
});

describe("payoutsToCsv", () => {
  it("renders amount in dollars and blanks missing optional fields", () => {
    const rows: AffiliatePayout[] = [
      {
        id: "po_1",
        affiliateId: "aff_1",
        amountCents: 12_000,
        currency: "USD",
        status: "pending",
        createdAt: "2026-04-01T00:00:00Z",
      },
    ];
    const csv = payoutsToCsv(rows);
    const [, first] = csv.split("\r\n");
    expect(first.startsWith("po_1,2026-04-01T00:00:00Z,120.00,USD,,,pending,")).toBe(
      true,
    );
  });
});
