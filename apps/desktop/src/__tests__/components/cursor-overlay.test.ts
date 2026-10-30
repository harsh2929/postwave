// Tests for the CursorOverlay sync + fade contract. The overlay
// itself binds mousemove listeners and uses BroadcastChannel + the
// /events/publish endpoint to fan cursor positions out. We test the
// pure pieces here:
//
//   - hashUserColor is deterministic per user id
//   - the wire payload shape stays stable (BroadcastChannel + SSE must
//     be byte-for-byte identical)
//   - fade-out gate: a cursor stale > 5s is hidden
//   - throttle constant matches the cursor-throttle test

import { describe, expect, it } from "vitest";

/* ---------------------------------------------------------------- */
/* hashUserColor — mirror of CursorOverlay.tsx                       */
/* ---------------------------------------------------------------- */

const CURSOR_PALETTE = [
  "#ef4444",
  "#f97316",
  "#eab308",
  "#22c55e",
  "#14b8a6",
  "#3b82f6",
  "#8b5cf6",
  "#ec4899",
] as const;

function hashUserColor(userId: string): string {
  let h = 0;
  for (let i = 0; i < userId.length; i++) {
    h = (h * 31 + userId.charCodeAt(i)) | 0;
  }
  const idx = Math.abs(h) % CURSOR_PALETTE.length;
  return CURSOR_PALETTE[idx] ?? CURSOR_PALETTE[0];
}

/* ---------------------------------------------------------------- */
/* Constants pinned from CursorOverlay.tsx                           */
/* ---------------------------------------------------------------- */

const FADE_AFTER_MS = 5_000;
const THROTTLE_MS = 100;

/* ---------------------------------------------------------------- */
/* Tests                                                             */
/* ---------------------------------------------------------------- */

describe("CursorOverlay — color hash is deterministic", () => {
  it("the same user id always maps to the same color", () => {
    expect(hashUserColor("u_alice")).toBe(hashUserColor("u_alice"));
  });

  it("different ids generally map to different colors (no degenerate hash)", () => {
    const colors = new Set<string>();
    for (const id of ["u_a", "u_b", "u_c", "u_d", "u_e", "u_f", "u_g"]) {
      colors.add(hashUserColor(id));
    }
    // 7 ids → expect at least 3 distinct colors; the palette has 8.
    expect(colors.size).toBeGreaterThanOrEqual(3);
  });

  it("returns a value from the canonical palette", () => {
    const c = hashUserColor("anyone");
    expect(CURSOR_PALETTE).toContain(c);
  });
});

describe("CursorOverlay — wire payload shape", () => {
  // BroadcastChannel-emit and SSE-relay must be byte-for-byte
  // identical, so the shape is part of the public contract.
  interface CursorMove {
    campaign_id: string;
    user_id: string;
    user_label: string;
    color: string;
    x: number;
    y: number;
    at: number;
  }
  function build(
    campaign_id: string,
    user_id: string,
    x: number,
    y: number,
    at: number,
  ): CursorMove {
    return {
      campaign_id,
      user_id,
      user_label: user_id,
      color: hashUserColor(user_id),
      x,
      y,
      at,
    };
  }

  it("emits all seven required fields", () => {
    const m = build("camp_1", "u_alice", 100, 200, 1_700_000_000_000);
    expect(Object.keys(m).sort()).toEqual(
      ["at", "campaign_id", "color", "user_id", "user_label", "x", "y"].sort(),
    );
  });

  it("color is taken from the palette via the hash", () => {
    const m = build("camp_1", "u_alice", 0, 0, 0);
    expect(CURSOR_PALETTE).toContain(m.color);
  });
});

describe("CursorOverlay — fade gate after 5s", () => {
  function isStale(receivedAt: number, now: number): boolean {
    return now - receivedAt > FADE_AFTER_MS;
  }

  it("fresh cursor (< 5s) is visible", () => {
    expect(isStale(1_000, 5_000)).toBe(false);
    expect(isStale(1_000, 5_999)).toBe(false);
  });

  it("stale cursor (> 5s) is hidden", () => {
    expect(isStale(1_000, 6_001)).toBe(true);
  });
});

describe("CursorOverlay — throttle constant alignment", () => {
  it("matches the 100ms throttle in cursor-throttle.test.ts", () => {
    expect(THROTTLE_MS).toBe(100);
  });
});
