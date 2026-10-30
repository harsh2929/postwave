// SPDX-License-Identifier: AGPL-3.0-only
//
// Ten capability pages publish an AggregateOffer in their JSON-LD, and search
// engines surface that price range directly in results. Every one of them
// carried highPrice "700" — a number matching no tier. The tiers are $0, $349,
// $29 and $79, so the advertised ceiling was roughly double the most expensive
// thing sold, on ten pages at once.
//
// offerCount says these four offers ARE the tier list, so the range has to be
// the tier list's range.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = resolve(process.cwd(), "src");
const MARKETING = join(SRC, "app/(marketing)");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(p)) out.push(p);
  }
  return out;
}

/** Numeric prices from the canonical tier list. */
function tierPrices(): number[] {
  const src = readFileSync(join(SRC, "lib/pricing.ts"), "utf8");
  return [...src.matchAll(/price:\s*"\$([\d,]+)"/g)].map((m) =>
    Number(m[1]!.replace(/,/g, "")),
  );
}

interface Offer {
  file: string;
  low: number;
  high: number;
  count: number;
}

function aggregateOffers(): Offer[] {
  const offers: Offer[] = [];
  for (const file of walk(MARKETING)) {
    const text = readFileSync(file, "utf8");
    const low = /lowPrice:\s*"(\d+)"/.exec(text);
    const high = /highPrice:\s*"(\d+)"/.exec(text);
    const count = /offerCount:\s*"(\d+)"/.exec(text);
    if (!low || !high || !count) continue;
    offers.push({
      file: file.slice(SRC.length + 1),
      low: Number(low[1]),
      high: Number(high[1]),
      count: Number(count[1]),
    });
  }
  return offers;
}

describe("AggregateOffer structured data", () => {
  const prices = tierPrices();
  const offers = aggregateOffers();

  it("finds tiers and offers", () => {
    // Guard the guard: either list coming back empty would pass everything.
    expect(prices.length).toBeGreaterThan(2);
    expect(offers.length).toBeGreaterThan(5);
  });

  it("advertises the real price range", () => {
    const min = Math.min(...prices);
    const max = Math.max(...prices);
    const wrong = offers
      .filter((o) => o.low !== min || o.high !== max)
      .map((o) => `${o.file}: ${o.low}–${o.high}, tiers are ${min}–${max}`);
    expect(wrong).toEqual([]);
  });

  it("counts the offers it actually has", () => {
    const wrong = offers
      .filter((o) => o.count !== prices.length)
      .map((o) => `${o.file}: offerCount ${o.count}, ${prices.length} tiers`);
    expect(wrong).toEqual([]);
  });
});
