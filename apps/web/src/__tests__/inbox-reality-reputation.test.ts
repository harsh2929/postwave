// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import {
  normalizeReputation,
  normalizeSnapshots,
} from "@/lib/inbox-reality-api";

describe("normalizeReputation", () => {
  it("keeps missing service evidence unavailable instead of fabricating it", () => {
    expect(normalizeReputation({})).toEqual({
      domain: "",
      ip: "",
      google_score: null,
      microsoft_score: null,
      sender_score: null,
      blacklist_hits: [],
      checked_at: "",
      data_available: false,
      sources_succeeded: [],
      sources_failed: [],
    });
  });

  it("rejects malformed scores without replacing them with medium", () => {
    expect(
      normalizeReputation({
        google_score: "unknown" as never,
        microsoft_score: "excellent" as never,
        sender_score: Number.NaN,
      }),
    ).toMatchObject({
      google_score: null,
      microsoft_score: null,
      sender_score: null,
    });
  });
});

describe("normalizeSnapshots (INBOX-031)", () => {
  it("returns [] for non-array / nullish payloads", () => {
    expect(normalizeSnapshots(undefined)).toEqual([]);
    expect(normalizeSnapshots(null)).toEqual([]);
    expect(normalizeSnapshots({})).toEqual([]);
    expect(normalizeSnapshots("nope")).toEqual([]);
  });

  it("drops rows whose checked_at is non-empty but unparseable", () => {
    const out = normalizeSnapshots([
      { sender_score: 80, checked_at: "not-a-date" },
      { sender_score: 82, checked_at: "2026-07-03T00:00:00Z" },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.checked_at).toBe("2026-07-03T00:00:00Z");
  });

  it("drops rows without a checked_at and coerces missing fields", () => {
    const out = normalizeSnapshots([
      { sender_score: 87, checked_at: "2026-07-01T00:00:00Z" },
      { sender_score: 90 }, // no checked_at -> dropped
      null,
      42,
      {
        sender_score: "bad",
        google_score: 5,
        microsoft_score: "high",
        blacklist_hit_count: "x",
        data_available: true,
        checked_at: "2026-07-02T00:00:00Z",
      },
    ]);
    expect(out).toEqual([
      {
        sender_score: 87,
        google_score: "",
        microsoft_score: "",
        blacklist_hit_count: 0,
        data_available: false,
        checked_at: "2026-07-01T00:00:00Z",
      },
      {
        // "bad" score -> -1 (unavailable sentinel); numeric google_score -> "";
        // non-numeric blacklist_hit_count -> 0.
        sender_score: -1,
        google_score: "",
        microsoft_score: "high",
        blacklist_hit_count: 0,
        data_available: true,
        checked_at: "2026-07-02T00:00:00Z",
      },
    ]);
  });
});
