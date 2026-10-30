import { describe, expect, it } from "vitest";

import { linkCheckConsequence, readLinkCheck } from "./campaignLinkCheck";

describe("readLinkCheck", () => {
  it("puts broken links first — the point is to see the problem", () => {
    const reading = readLinkCheck([
      { url: "https://a.com", status: 200, ok: true },
      { url: "https://b.com", status: 404, ok: false },
      { url: "https://c.com", status: 200, ok: true },
    ]);
    expect(reading.rows[0]?.url).toBe("https://b.com");
    expect(reading.brokenCount).toBe(1);
    expect(reading.headline).toBe("1 link of 3 didn't resolve.");
  });

  it("distinguishes an unreachable host from an HTTP error", () => {
    // status 0 + error means the request never completed (DNS/TLS/timeout),
    // which is a different — usually worse — fact than a 404.
    const reading = readLinkCheck([
      { url: "https://gone.example", status: 0, ok: false, error: "no such host" },
    ]);
    expect(reading.rows[0]?.statusLabel).toBe("Unreachable");
    expect(reading.rows[0]?.detail).toBe("no such host");
  });

  it("says all clear when everything resolves", () => {
    const reading = readLinkCheck([
      { url: "https://a.com", status: 200, ok: true },
      { url: "https://b.com", status: 301, ok: true },
    ]);
    expect(reading.brokenCount).toBe(0);
    expect(reading.headline).toBe("All 2 links resolved.");
  });

  it("treats a body with no links as a stated fact, not an error", () => {
    const reading = readLinkCheck([]);
    expect(reading.noLinks).toBe(true);
    expect(reading.headline).toContain("No links found");
  });

  it("survives a payload that isn't an array of results", () => {
    expect(readLinkCheck(null).rows).toEqual([]);
    expect(readLinkCheck({ results: [] }).rows).toEqual([]);
    expect(readLinkCheck([null, { status: 200 }]).rows).toEqual([]);
  });
});

describe("linkCheckConsequence", () => {
  it("is null when nothing is broken, so no confirm is escalated", () => {
    expect(
      linkCheckConsequence(readLinkCheck([{ url: "https://a.com", ok: true }])),
    ).toBeNull();
    expect(linkCheckConsequence(null)).toBeNull();
  });

  it("names the broken URLs, bounded to three", () => {
    const reading = readLinkCheck([
      { url: "https://1.com", ok: false },
      { url: "https://2.com", ok: false },
      { url: "https://3.com", ok: false },
      { url: "https://4.com", ok: false },
    ]);
    const line = linkCheckConsequence(reading);
    expect(line).toContain("4 links didn't resolve");
    expect(line).toContain("https://1.com");
    expect(line).not.toContain("https://4.com");
    expect(line?.endsWith("…")).toBe(true);
  });
});
