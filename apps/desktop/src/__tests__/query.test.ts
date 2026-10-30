// Tests for the TanStack Query primitive helpers in src/lib/query.ts.
//
// The hooks themselves require a React renderer (jsdom + @testing-library)
// which isn't in the workspace, so these tests pin the pure surface:
//   - QueryError construction preserves all fields.
//   - unwrapApiResult routes ok/err correctly.
//   - isApiResultShape correctly discriminates the envelope from raw T.
//
// Bug-class these tests protect against: regressions in the envelope
// heuristic that would either silently swallow ApiErr.error into the
// success path OR misclassify a raw T as an envelope and drop fields.

import { describe, expect, it } from "vitest";

import {
  QueryError,
  isApiResultShape,
  unwrapApiResult,
} from "../lib/query";

describe("QueryError", () => {
  it("preserves status, code, kind, and details", () => {
    const err = new QueryError("nope", {
      status: 422,
      code: "validation_failed",
      kind: "http",
      details: { field: "email" },
    });
    expect(err.message).toBe("nope");
    expect(err.status).toBe(422);
    expect(err.code).toBe("validation_failed");
    expect(err.kind).toBe("http");
    expect(err.details).toEqual({ field: "email" });
    expect(err.name).toBe("QueryError");
    expect(err).toBeInstanceOf(Error);
  });

  it("defaults all optional fields to undefined", () => {
    const err = new QueryError("oops");
    expect(err.status).toBeUndefined();
    expect(err.code).toBeUndefined();
    expect(err.kind).toBeUndefined();
    expect(err.details).toBeUndefined();
  });
});

describe("unwrapApiResult", () => {
  it("returns data on success", () => {
    expect(unwrapApiResult({ data: 42 })).toBe(42);
  });

  it("throws a QueryError mirroring the server envelope on failure", () => {
    try {
      unwrapApiResult({
        error: {
          message: "rate-limited",
          status: 429,
          code: "throttled",
          kind: "http",
          retryAfterSeconds: 5,
          details: { window: "1h" },
        },
      });
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(QueryError);
      const qe = e as QueryError;
      expect(qe.message).toBe("rate-limited");
      expect(qe.status).toBe(429);
      expect(qe.code).toBe("throttled");
      expect(qe.kind).toBe("http");
      expect(qe.details).toEqual({ window: "1h" });
    }
  });
});

describe("isApiResultShape", () => {
  it("identifies the success envelope shape", () => {
    expect(isApiResultShape({ data: { x: 1 } })).toBe(true);
    expect(isApiResultShape({ data: null })).toBe(true);
  });

  it("identifies the error envelope shape", () => {
    expect(
      isApiResultShape({ error: { message: "boom", status: 500 } }),
    ).toBe(true);
  });

  it("rejects raw T objects that happen to have a data key plus siblings", () => {
    // A real payload like Subscriber { id, email, data: {...} }
    // must NOT be misclassified — that would cause unwrap to drop
    // every field except `data`.
    expect(isApiResultShape({ id: "1", email: "x@y", data: {} })).toBe(false);
  });

  it("rejects malformed error envelopes (missing message)", () => {
    expect(isApiResultShape({ error: {} })).toBe(false);
    expect(isApiResultShape({ error: null })).toBe(false);
  });

  it("rejects primitives, arrays, and null", () => {
    expect(isApiResultShape(null)).toBe(false);
    expect(isApiResultShape(undefined)).toBe(false);
    expect(isApiResultShape(42)).toBe(false);
    expect(isApiResultShape("hi")).toBe(false);
    expect(isApiResultShape([1, 2, 3])).toBe(false);
  });
});

/**
 * Pure-surface coverage for the `useInfiniteList` next-page logic. The
 * hook itself wires React state; we re-implement the bare next-page
 * rule here so the heuristic is pinned by tests without booting a
 * renderer. If you change the rule in query.ts, mirror it here AND
 * update the docstring on `useInfiniteList`.
 *
 * Rule (matches getNextPageParam in query.ts):
 *   1. Explicit `nextPage === null` → end.
 *   2. Explicit `nextPage: number` → use it verbatim.
 *   3. `items.length < perPage`     → end (heuristic).
 *   4. Otherwise                    → lastPageParam + 1.
 */
function nextPageRule<T>(
  lastPage: { items: T[]; nextPage?: number | null },
  lastPageParam: number,
  perPage: number,
): number | null {
  if (lastPage.nextPage === null) return null;
  if (typeof lastPage.nextPage === "number") return lastPage.nextPage;
  if (lastPage.items.length < perPage) return null;
  return lastPageParam + 1;
}

describe("useInfiniteList next-page logic", () => {
  it("honours explicit null from the server (end-of-list)", () => {
    expect(nextPageRule({ items: [1, 2, 3], nextPage: null }, 5, 25)).toBeNull();
  });

  it("honours explicit numeric nextPage from the server (cursor mode)", () => {
    expect(nextPageRule({ items: [1, 2], nextPage: 9 }, 3, 25)).toBe(9);
  });

  it("infers end-of-list from a short final page (length < perPage)", () => {
    expect(nextPageRule({ items: [1, 2, 3] }, 1, 25)).toBeNull();
  });

  it("returns the next sequential page when the current page is full", () => {
    const full = Array.from({ length: 25 }, (_, i) => i);
    expect(nextPageRule({ items: full }, 1, 25)).toBe(2);
    expect(nextPageRule({ items: full }, 4, 25)).toBe(5);
  });

  it("treats empty pages as end-of-list (length 0 < perPage)", () => {
    expect(nextPageRule({ items: [] }, 7, 25)).toBeNull();
  });

  it("never duplicates the current page param when paging forward", () => {
    const full = Array.from({ length: 25 }, (_, i) => i);
    const next = nextPageRule({ items: full }, 1, 25);
    expect(next).not.toBe(1);
    expect(next).toBe(2);
  });
});
