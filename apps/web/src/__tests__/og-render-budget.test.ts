// SPDX-License-Identifier: AGPL-3.0-only
//
// /og is a public, unauthenticated, CPU-bound renderer linked from every
// marketing page's og:image. Without a budget, a loop over random titles is a
// cache miss every time and each miss runs a satori layout plus a resvg raster
// in the process that also serves the public pages.
import { beforeEach, describe, expect, it } from "vitest";

import {
  RENDER_REQUESTS_PER_INSTANCE,
  RENDER_REQUESTS_PER_PEER,
  consumeOgRenderAllowance,
  ogPeerKey,
  resetOgRenderBudget,
} from "@/lib/og-render-budget";

function headers(values: Record<string, string>): Pick<Headers, "get"> {
  return new Headers(values);
}

describe("og render budget", () => {
  beforeEach(() => {
    resetOgRenderBudget();
  });

  it("stops a single peer at its window allowance and reopens after it", () => {
    const start = 1_000_000;
    for (let index = 0; index < RENDER_REQUESTS_PER_PEER; index += 1) {
      expect(consumeOgRenderAllowance("peer:203.0.113.9", start)).toBeNull();
    }
    const retryAfter = consumeOgRenderAllowance("peer:203.0.113.9", start);
    expect(retryAfter).not.toBeNull();
    expect(retryAfter).toBeGreaterThan(0);
    // A different peer is unaffected.
    expect(consumeOgRenderAllowance("peer:198.51.100.4", start)).toBeNull();
    // …and the original peer is served again in the next window.
    expect(
      consumeOgRenderAllowance("peer:203.0.113.9", start + 60_001),
    ).toBeNull();
  });

  it("bounds the instance even when every request claims a new peer", () => {
    const start = 2_000_000;
    let served = 0;
    for (let index = 0; index < RENDER_REQUESTS_PER_INSTANCE * 2; index += 1) {
      if (consumeOgRenderAllowance(`peer:203.0.113.${index}`, start) === null) {
        served += 1;
      }
    }
    expect(served).toBe(RENDER_REQUESTS_PER_INSTANCE);
  });

  it("attributes a proxied request to the hop the proxy appended", () => {
    // A caller can prepend anything before the request reaches the proxy, so
    // the leftmost entry is attacker-chosen; the rightmost is not.
    expect(
      ogPeerKey(headers({ "x-forwarded-for": "10.0.0.1, 203.0.113.9" })),
    ).toBe("peer:203.0.113.9");
    expect(
      ogPeerKey(headers({ "x-forwarded-for": "spoofed, 203.0.113.9" })),
    ).toBe("peer:203.0.113.9");
    expect(ogPeerKey(headers({ "x-real-ip": "203.0.113.9" }))).toBe(
      "peer:203.0.113.9",
    );
  });

  it("pools requests it cannot attribute into one bucket", () => {
    expect(ogPeerKey(headers({}))).toBe("peer:unattributed");
    expect(ogPeerKey(headers({ "x-forwarded-for": "not an ip" }))).toBe(
      "peer:unattributed",
    );
    expect(
      ogPeerKey(headers({ "x-forwarded-for": `1.1.1.${"1".repeat(80)}` })),
    ).toBe("peer:unattributed");
  });
});
