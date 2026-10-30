// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import {
  containsControlCharacter,
  hasDuplicateKey,
  hasOnlyKeys,
  isBoundedMultilineText,
  isBoundedText,
  isCanonicalUUID,
  isCheckID,
  isNonNegativeInteger,
  isRecord,
  isTimestamp,
} from "./viewSchema";

const UUID = "018f4f4c-53de-7c12-ae4d-fbbac8f735b2";

describe("isCheckID", () => {
  it("accepts lowercase registry slugs, single char, symbol tail, and a full 64-char id", () => {
    expect(isCheckID("billing.dlq-depth")).toBe(true);
    expect(isCheckID("a")).toBe(true);
    expect(isCheckID("a1_-.")).toBe(true);
    expect(isCheckID("a".repeat(64))).toBe(true);
  });

  it("rejects empty, uppercase, and a leading char outside [a-z0-9]", () => {
    expect(isCheckID("")).toBe(false);
    expect(isCheckID("Billing")).toBe(false);
    expect(isCheckID("-x")).toBe(false);
    expect(isCheckID(".x")).toBe(false);
  });

  it("rejects over-length, whitespace, path traversal, and non-strings", () => {
    expect(isCheckID("a".repeat(65))).toBe(false);
    expect(isCheckID("a b")).toBe(false);
    expect(isCheckID(" a")).toBe(false);
    expect(isCheckID("../x")).toBe(false);
    expect(isCheckID(123)).toBe(false);
    expect(isCheckID(null)).toBe(false);
    expect(isCheckID(undefined)).toBe(false);
  });
});

describe("isCanonicalUUID", () => {
  it("accepts a lowercase canonical UUID", () => {
    expect(isCanonicalUUID(UUID)).toBe(true);
  });

  it("rejects uppercase, malformed, and the nil all-zeros UUID", () => {
    expect(isCanonicalUUID(UUID.toUpperCase())).toBe(false);
    expect(isCanonicalUUID("018f4f4c-53de-7c12-ae4d")).toBe(false);
    expect(isCanonicalUUID("not-a-uuid")).toBe(false);
    expect(isCanonicalUUID("00000000-0000-0000-0000-000000000000")).toBe(false);
  });

  it("rejects non-strings", () => {
    expect(isCanonicalUUID(123)).toBe(false);
    expect(isCanonicalUUID(null)).toBe(false);
    expect(isCanonicalUUID(undefined)).toBe(false);
  });
});

describe("isBoundedText", () => {
  it("accepts ordinary text within the code-point and byte caps", () => {
    expect(isBoundedText("hello", 10)).toBe(true);
    expect(isBoundedText("abcd", 4)).toBe(true);
  });

  it("enforces the code-point cap independently of the byte cap", () => {
    // 5 code points, 5 bytes — under the default byte cap (4*4=16),
    // so only the code-point cap can reject it.
    expect(isBoundedText("abcde", 4)).toBe(false);
  });

  it("enforces the byte cap where bytes exceed code points (multi-byte char)", () => {
    // "€€" (two euro signs) = 2 code points but 6 UTF-8 bytes.
    expect(isBoundedText("€€", 5, 6)).toBe(true);
    expect(isBoundedText("€€", 5, 5)).toBe(false);
  });

  it("rejects control characters including tab, newline, and NUL", () => {
    expect(isBoundedText("a\tb", 10)).toBe(false);
    expect(isBoundedText("a\nb", 10)).toBe(false);
    expect(isBoundedText("a\u0000b", 10)).toBe(false);
  });

  it("rejects empty, whitespace-only, and non-strings", () => {
    expect(isBoundedText("", 10)).toBe(false);
    expect(isBoundedText("   ", 10)).toBe(false);
    expect(isBoundedText(123, 10)).toBe(false);
    expect(isBoundedText(null, 10)).toBe(false);
  });
});

describe("isBoundedMultilineText", () => {
  it("permits newlines, tabs, and carriage returns where the single-line variant does not", () => {
    expect(isBoundedMultilineText("line1\nline2", 100)).toBe(true);
    expect(isBoundedMultilineText("a\tb\r\nc", 100)).toBe(true);
    expect(isBoundedText("line1\nline2", 100)).toBe(false);
  });

  it("still rejects non-whitespace control characters", () => {
    expect(isBoundedMultilineText("a\u0000b", 100)).toBe(false);
    expect(isBoundedMultilineText("a\u001fb", 100)).toBe(false);
  });

  it("still enforces the code-point and byte caps", () => {
    expect(isBoundedMultilineText("abcde", 4)).toBe(false);
    expect(isBoundedMultilineText("€€", 5, 5)).toBe(false);
    expect(isBoundedMultilineText("€€", 5, 6)).toBe(true);
  });

  it("rejects non-strings", () => {
    expect(isBoundedMultilineText(123, 100)).toBe(false);
    expect(isBoundedMultilineText(null, 100)).toBe(false);
  });
});

describe("isTimestamp", () => {
  it("accepts a valid RFC3339 instant", () => {
    expect(isTimestamp("2026-07-15T10:00:00Z")).toBe(true);
  });

  it("rejects an impossible calendar date", () => {
    // Date.parse rolls Feb 31 over, so only the daysInMonth guard rejects it.
    expect(isTimestamp("2026-02-31T10:00:00Z")).toBe(false);
  });

  it("rejects a non-ISO string and non-strings", () => {
    expect(isTimestamp("2026-07-15 10:00:00Z")).toBe(false);
    expect(isTimestamp("July 15, 2026")).toBe(false);
    expect(isTimestamp(123)).toBe(false);
    expect(isTimestamp(null)).toBe(false);
  });
});

describe("isNonNegativeInteger", () => {
  it("accepts zero and positive integers", () => {
    expect(isNonNegativeInteger(0)).toBe(true);
    expect(isNonNegativeInteger(42)).toBe(true);
  });

  it("rejects negatives, floats, NaN, and non-numbers", () => {
    expect(isNonNegativeInteger(-1)).toBe(false);
    expect(isNonNegativeInteger(1.5)).toBe(false);
    expect(isNonNegativeInteger(Number.NaN)).toBe(false);
    expect(isNonNegativeInteger("5")).toBe(false);
    expect(isNonNegativeInteger(null)).toBe(false);
  });
});

describe("isRecord", () => {
  it("accepts a plain object", () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord({ a: 1 })).toBe(true);
  });

  it("rejects null, arrays, and primitives", () => {
    expect(isRecord(null)).toBe(false);
    expect(isRecord([])).toBe(false);
    expect(isRecord("x")).toBe(false);
    expect(isRecord(1)).toBe(false);
    expect(isRecord(undefined)).toBe(false);
  });
});

describe("hasOnlyKeys", () => {
  it("accepts required-only and required plus allowed-optional keys", () => {
    expect(hasOnlyKeys({ a: 1, b: 2 }, ["a", "b"])).toBe(true);
    expect(hasOnlyKeys({ a: 1, b: 2, c: 3 }, ["a", "b"], ["c"])).toBe(true);
  });

  it("rejects unknown keys and missing required keys", () => {
    expect(hasOnlyKeys({ a: 1, b: 2, z: 9 }, ["a", "b"])).toBe(false);
    expect(hasOnlyKeys({ a: 1 }, ["a", "b"])).toBe(false);
  });
});

describe("hasDuplicateKey", () => {
  it("is true when the key-mapper collides", () => {
    expect(
      hasDuplicateKey([{ id: "a" }, { id: "b" }, { id: "a" }], (row) => row.id),
    ).toBe(true);
  });

  it("is false when every mapped key is unique", () => {
    expect(
      hasDuplicateKey([{ id: "a" }, { id: "b" }], (row) => row.id),
    ).toBe(false);
    expect(hasDuplicateKey([], (row: { id: string }) => row.id)).toBe(false);
  });
});

describe("containsControlCharacter", () => {
  it("is true for strings containing control characters (NUL, unit separator, DEL)", () => {
    expect(containsControlCharacter("a\u0000b")).toBe(true);
    expect(containsControlCharacter("a\u001fb")).toBe(true);
    expect(containsControlCharacter("a\u007fb")).toBe(true);
  });

  it("flags newline as a control character and clears ordinary text", () => {
    // The source caps at code <= 31, so newline (10) counts as a control char.
    expect(containsControlCharacter("line1\nline2")).toBe(true);
    expect(containsControlCharacter("hello world")).toBe(false);
  });
});
