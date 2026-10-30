// SPDX-License-Identifier: AGPL-3.0-only
//
// /commerce publishes unusually precise facts — a literal byte count for the
// tracking pixel, exact scoring weights for the recommendation ranker, a
// default and maximum look-back for the attribution timeseries, and a
// ten-provider enumeration. Every one of them was accurate when this was
// written; none of them had anything holding them there.
//
// The pixel check counts the bytes in the array rather than reading the "43
// bytes, GIF89a" comment sitting above it. The page and that comment are two
// claims, not a claim and a verification — a guard that compared them would
// pass forever while both drifted away from the array they describe.
//
// Not re-tested here: the 7-day last-touch window and the attribution keying,
// which attribution-claims.test.ts already pins.
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = resolve(process.cwd(), "src");
const REPO = resolve(process.cwd(), "../..");

const PAGE = readFileSync(
  join(SRC, "app/(marketing)/commerce/page.tsx"),
  "utf8",
).replace(/\s+/g, " ");

function go(rel: string): string {
  return readFileSync(join(REPO, "apps/api/internal", rel), "utf8");
}

describe("commerce published facts match the code", () => {
  it("states the tracking pixel's real size", () => {
    const src = go("conversions/conversions.go");
    const arr = /var transparentPixel = \[\]byte\{([\s\S]*?)\}/.exec(src);
    expect(arr, "transparentPixel array not found").not.toBeNull();
    const bytes = (arr![1]!.match(/0x[0-9a-fA-F]{2}/g) ?? []).length;
    expect(bytes).toBeGreaterThan(20); // guard the guard
    expect(PAGE).toContain(`${bytes}-byte transparent GIF89a pixel`);
  });

  it("states the attribution window default and ceiling", () => {
    const src = go("conversions/attribution.go");
    const def = /attributionDefaultDays\s*=\s*(\d+)/.exec(src);
    const max = /attributionMaxDays\s*=\s*(\d+)/.exec(src);
    expect(def).not.toBeNull();
    expect(max).not.toBeNull();
    expect(Number(max![1])).toBeGreaterThan(Number(def![1]));
    expect(PAGE).toContain(`default ${def![1]} days, max ${max![1]}`);
    // The handler's own rejection message has to agree with the constant.
    expect(src).toContain(`between 1 and ${max![1]}`);
  });

  it("states the ranker's real weights and price band", () => {
    const src = go("commerce/recommendations.go");
    const ordered = /score \+= (1\.\d+)\s*$/m.exec(src);
    const tier = /score \+= (0\.\d+)\s*$/m.exec(src);
    expect(ordered, "ordered-product weight not found").not.toBeNull();
    expect(tier, "price-tier weight not found").not.toBeNull();
    expect(PAGE).toContain(`+${ordered![1]} if the subscriber has ordered`);
    expect(PAGE).toContain(`+${tier![1]} for price-tier similarity`);

    // "within ±30%" is the ratio band, which is written as bounds, not a
    // percentage — the published figure has to be derived from them.
    const band = /ratio >= (0\.\d+) && ratio <= (1\.\d+)/.exec(src);
    expect(band, "price ratio band not found").not.toBeNull();
    const lo = Math.round((1 - Number(band![1])) * 100);
    const hi = Math.round((Number(band![2]) - 1) * 100);
    expect(lo, "asymmetric band cannot be published as ±N%").toBe(hi);
    expect(PAGE).toContain(`±${hi}%`);
  });

  it("names only commerce providers that exist", () => {
    // The page enumerates ten. An enumeration beside an implementation is the
    // shape that has drifted most often across this codebase.
    // Catalog slug ↔ the name the page prints. They differ: the Go package is
    // internal/commerce/adobe_commerce.go, the catalog slug is
    // "adobe-commerce", and the page writes "Adobe Commerce". Asserting one
    // spelling against another is how a guard ends up testing a guess.
    const claimed: [slug: string, printed: string][] = [
      ["shopify", "Shopify"],
      ["bigcommerce", "BigCommerce"],
      ["adobe-commerce", "Adobe Commerce"],
      ["paypal", "PayPal"],
      ["razorpay", "Razorpay"],
      ["stripe", "Stripe"],
      ["square", "Square"],
      ["woocommerce", "WooCommerce"],
      ["wix", "Wix"],
      ["squarespace", "Squarespace"],
    ];
    const catalog = readFileSync(
      join(REPO, "apps/api/internal/integrations/catalog.go"),
      "utf8",
    );
    // item("<slug>", …) is the catalog's registration form — a bare substring
    // would match any prose mentioning the word.
    const registered = new Set(
      [...catalog.matchAll(/\bitem\("([a-z0-9-]+)"/g)].map((m) => m[1]!),
    );
    expect(registered.size).toBeGreaterThan(50); // guard the guard
    expect(claimed.filter(([slug]) => !registered.has(slug))).toEqual([]);
    expect(claimed.filter(([, printed]) => !PAGE.includes(printed))).toEqual([]);
  });
});
