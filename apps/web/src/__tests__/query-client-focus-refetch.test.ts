// SPDX-License-Identifier: AGPL-3.0-only
//
// WEB-FETCH-008: pins the two defaults that decide how much traffic a tab
// switch costs. Without them, v5's staleTime of 0 plus an unconditional
// refetchOnWindowFocus refires a page's whole query set on every alt-tab —
// duplicating work the realtime invalidator has already done.

import { describe, expect, it } from "vitest";

import { makeQueryClient } from "@/lib/query-client";

type FocusGate = (query: {
  state: { dataUpdatedAt: number };
}) => boolean | "always";

function queryDefaults(): {
  staleTime?: unknown;
  refetchOnWindowFocus?: unknown;
} {
  const defaults = makeQueryClient().getDefaultOptions().queries;
  if (!defaults) throw new Error("no query defaults registered");
  return defaults as { staleTime?: unknown; refetchOnWindowFocus?: unknown };
}

function fetchedAgo(ms: number): { state: { dataUpdatedAt: number } } {
  return { state: { dataUpdatedAt: Date.now() - ms } };
}

describe("query client refetch defaults", () => {
  it("gives queries that declare no staleTime a freshness floor", () => {
    const staleTime = queryDefaults().staleTime;

    expect(typeof staleTime).toBe("number");
    // Must outlast a plausible tab switch; 0 (the v5 default) means every
    // mount and every focus is a network round trip.
    expect(staleTime as number).toBeGreaterThanOrEqual(30_000);
  });

  it("skips a focus refetch for data fetched seconds ago", () => {
    const gate = queryDefaults().refetchOnWindowFocus;
    expect(typeof gate).toBe("function");

    expect((gate as FocusGate)(fetchedAgo(0))).toBe(false);
    expect((gate as FocusGate)(fetchedAgo(5_000))).toBe(false);
    // STALE.detail is 10s; a 10s-old query must still not refire on focus.
    expect((gate as FocusGate)(fetchedAgo(11_000))).toBe(false);
  });

  it("still refetches on focus after a long absence and for never-fetched data", () => {
    const gate = queryDefaults().refetchOnWindowFocus as FocusGate;

    expect(gate(fetchedAgo(120_000))).toBe(true);
    expect(gate({ state: { dataUpdatedAt: 0 } })).toBe(true);
  });
});
