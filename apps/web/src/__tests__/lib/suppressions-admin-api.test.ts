// SPDX-License-Identifier: AGPL-3.0-only
//
// Pure-logic tests for the suppression-admin client helpers (node env).

import { describe, it, expect, vi } from "vitest";

const request = vi.hoisted(() => ({ post: vi.fn() }));
vi.mock("@/lib/api", () => ({ api: { post: request.post } }));

import {
  normalizeSuppressionAudit,
  normalizeAddInput,
  parseEmailList,
  suppressionExportFilename,
  bulkImportSuppressions,
} from "@/lib/suppressions-admin-api";

describe("bulk import outcome", () => {
  it("counts server error rows so partial failures cannot look successful", async () => {
    request.post.mockResolvedValueOnce({
      imported: 1,
      skipped: 1,
      errors: ["a@example.invalid: refused", "b@example.invalid: refused"],
    });
    expect(await bulkImportSuppressions(["a@example.invalid"])).toEqual({
      imported: 1,
      skipped: 1,
      errors: 2,
    });
  });
});

describe("normalizeSuppressionAudit", () => {
  it("accepts complete rows and drops malformed optional fields", () => {
    expect(
      normalizeSuppressionAudit({
        items: [
          {
            id: "audit_1",
            action: "expiry_updated",
            actor: "operator@example.com",
            reason: 42,
            metadata: { prior: null },
            created_at: "2026-08-26T00:00:00.000Z",
          },
        ],
      }),
    ).toEqual([
      {
        id: "audit_1",
        action: "expiry_updated",
        actor: "operator@example.com",
        metadata: { prior: null },
        created_at: "2026-08-26T00:00:00.000Z",
      },
    ]);
  });

  it.each([
    {},
    { items: null },
    { items: {} },
    { items: [null] },
    { items: [{ action: "", created_at: "2026-08-26T00:00:00Z" }] },
    { items: [{ action: "added", created_at: "" }] },
  ])(
    "rejects malformed history instead of presenting it as empty (%j)",
    (wire) => {
      expect(() => normalizeSuppressionAudit(wire)).toThrow(/malformed/i);
    },
  );
});

describe("normalizeAddInput", () => {
  it("lower-cases + trims email and drops empty optionals", () => {
    const out = normalizeAddInput({
      email: "  USER@Example.COM ",
      reason: " ",
    });
    expect(out.email).toBe("user@example.com");
    expect(out.reason).toBeUndefined();
  });

  it("keeps non-empty reason/source/expiry", () => {
    const out = normalizeAddInput({
      email: "a@b.co",
      reason: "spam",
      source: "manual",
      expires_at: "2030-01-01T00:00:00Z",
    });
    expect(out).toEqual({
      email: "a@b.co",
      reason: "spam",
      source: "manual",
      expires_at: "2030-01-01T00:00:00Z",
    });
  });

  it("throws for an empty email", () => {
    expect(() => normalizeAddInput({ email: "   " })).toThrow(/email/i);
  });
});

describe("parseEmailList", () => {
  it("splits, validates, dedupes, lower-cases", () => {
    const { valid, invalid } = parseEmailList(
      "Foo@Bar.com, foo@bar.com\n nope\nbaz@qux.io;  ",
    );
    expect(valid).toEqual(["foo@bar.com", "baz@qux.io"]);
    expect(invalid).toEqual(["nope"]);
  });

  it("returns empty arrays for blank input", () => {
    expect(parseEmailList("   \n  ")).toEqual({ valid: [], invalid: [] });
  });
});

describe("suppressionExportFilename", () => {
  it("is a dated .csv name", () => {
    expect(suppressionExportFilename()).toMatch(
      /^postwave-suppressions-\d{4}-\d{2}-\d{2}\.csv$/,
    );
  });
  it("includes the reason scope when filtering", () => {
    expect(suppressionExportFilename("hard_bounce")).toMatch(
      /^postwave-suppressions-hard_bounce-\d{4}-\d{2}-\d{2}\.csv$/,
    );
  });
});
