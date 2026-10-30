// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import {
  parseVerificationJobReceipt,
  VerificationReceiptUncertainError,
} from "@/lib/data-operations-api";

const ID = "018f47f2-9f25-7f73-8ec6-3fd483eb51dd";

describe("durable verification receipts", () => {
  it.each(["pending", "running", "completed", "failed", "canceled"] as const)(
    "accepts the closed %s lifecycle status after the creation race",
    (status) => {
      expect(
        parseVerificationJobReceipt(
          { id: ID, status, source: "inline", total: 2 },
          ["a@example.com", "b@example.com"],
        ),
      ).toEqual({ id: ID, status, source: "inline", total: 2 });
    },
  );

  it.each([
    { id: "not-a-uuid", status: "pending", source: "inline", total: 2 },
    { id: ID, status: "queued", source: "inline", total: 2 },
    { id: ID, status: "pending", source: "tag", total: 2 },
    { id: ID, status: "pending", source: "inline", total: 1 },
  ])("rejects an unproven creation receipt %#", (receipt) => {
    expect(() =>
      parseVerificationJobReceipt(receipt, ["a@example.com", "b@example.com"]),
    ).toThrow(VerificationReceiptUncertainError);
  });
});
