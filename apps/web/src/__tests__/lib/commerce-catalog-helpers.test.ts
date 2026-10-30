// SPDX-License-Identifier: AGPL-3.0-only
//
// Pure helpers behind the Commerce workspace (commerce-3, commerce-15).
//
// `verifiedShopifyAuthorizationUrl` is the safety check desktop applies before
// handing a server-minted authorize URL to the browser
// (apps/desktop/src/components/commerce/IntegrationsTab.tsx). Web must refuse
// exactly what desktop refuses: a plaintext downgrade, embedded credentials,
// a look-alike host, another store, and the local-dev relative callback. The
// fixtures below are the shapes a real server or a real attacker produces —
// `https://<shop>/admin/oauth/authorize?…` is what buildShopifyAuthorizeURL
// mints — not strings chosen to fit the implementation.
import { describe, expect, it } from "vitest";

import {
  analyticsTiles,
  formatCommerceRecord,
  importSummaryMessage,
  maskedEmail,
  ordersByStatusLabel,
  safeHttpsOrigin,
  MAX_IMPORT_PRODUCTS,
  normalizeShopifyDomain,
  prepareImportPayload,
  verifiedShopifyAuthorizationUrl,
} from "@/lib/commerce-catalog-helpers";

const SHOP = "brand.myshopify.com";
const AUTHORIZE = `https://${SHOP}/admin/oauth/authorize?client_id=abc&scope=read_products&state=s1`;

describe("verifiedShopifyAuthorizationUrl (desktop-identical safety check)", () => {
  it("accepts the shop's own admin authorize URL and returns it unchanged", () => {
    expect(verifiedShopifyAuthorizationUrl(AUTHORIZE, SHOP)).toBe(AUTHORIZE);
  });

  it("accepts Shopify's own accounts domain", () => {
    const url = "https://accounts.shopify.com/oauth/authorize?state=s1";
    expect(verifiedShopifyAuthorizationUrl(url, SHOP)).toBe(url);
  });

  it("refuses a plaintext downgrade of the same host", () => {
    expect(
      verifiedShopifyAuthorizationUrl(
        `http://${SHOP}/admin/oauth/authorize?state=s1`,
        SHOP,
      ),
    ).toBeNull();
  });

  it("refuses embedded credentials", () => {
    expect(
      verifiedShopifyAuthorizationUrl(
        `https://admin:secret@${SHOP}/admin/oauth/authorize`,
        SHOP,
      ),
    ).toBeNull();
  });

  it("refuses a look-alike host that merely contains the shop", () => {
    expect(
      verifiedShopifyAuthorizationUrl(
        `https://${SHOP}.evil.example/admin/oauth/authorize`,
        SHOP,
      ),
    ).toBeNull();
    expect(
      verifiedShopifyAuthorizationUrl(
        `https://evil.example/redirect?next=https://${SHOP}/admin`,
        SHOP,
      ),
    ).toBeNull();
  });

  it("refuses another store: *.myshopify.com is not Shopify's own domain", () => {
    expect(
      verifiedShopifyAuthorizationUrl(
        "https://other.myshopify.com/admin/oauth/authorize",
        SHOP,
      ),
    ).toBeNull();
  });

  it("refuses the local-dev relative callback, as desktop does", () => {
    expect(
      verifiedShopifyAuthorizationUrl(
        `/api/public/commerce/shopify/oauth/callback?shop=${SHOP}&code=local-dev`,
        SHOP,
      ),
    ).toBeNull();
  });
});

describe("normalizeShopifyDomain", () => {
  it("lower-cases and trims a bare *.myshopify.com host", () => {
    expect(normalizeShopifyDomain("  Brand.MyShopify.com ")).toBe(SHOP);
  });

  it("refuses a scheme, path, non-default port, credentials, or query", () => {
    for (const value of [
      `https://${SHOP}`,
      `${SHOP}/admin`,
      `${SHOP}:8443`,
      `user@${SHOP}`,
      `${SHOP}?x=1`,
      `${SHOP}#frag`,
    ]) {
      expect(normalizeShopifyDomain(value), value).toBeNull();
    }
    // The https default port is not a port to the URL parser: it normalizes
    // away before the check, leaving the bare host (desktop behaves the same).
    expect(normalizeShopifyDomain(`${SHOP}:443`)).toBe(SHOP);
  });

  it("refuses hosts outside myshopify.com and the bare apex", () => {
    expect(normalizeShopifyDomain("brand.example.com")).toBeNull();
    expect(normalizeShopifyDomain("myshopify.com")).toBeNull();
    expect(normalizeShopifyDomain("")).toBeNull();
  });
});

describe("prepareImportPayload (client-side bounds mirror desktop)", () => {
  const product = (i: number) => ({
    source_id: `p${i}`,
    title: `Item ${i}`,
    price_cents: 100 + i,
    currency: "USD",
  });

  it("accepts a bare array and omits `replace` when merging", () => {
    const result = prepareImportPayload(
      JSON.stringify([product(1), product(2)]),
      false,
    );
    expect(result).toEqual({
      ok: true,
      payload: { products: [product(1), product(2)] },
    });
    expect(result.ok && "replace" in result.payload).toBe(false);
  });

  it("accepts the {products: […]} wrapper and sets `replace: true` when replacing", () => {
    expect(
      prepareImportPayload(JSON.stringify({ products: [product(1)] }), true),
    ).toEqual({ ok: true, payload: { products: [product(1)], replace: true } });
  });

  it("refuses more than MAX_IMPORT_PRODUCTS products with the batch sentence", () => {
    const many = Array.from({ length: MAX_IMPORT_PRODUCTS + 1 }, (_, i) => ({
      source_id: `p${i}`,
    }));
    const result = prepareImportPayload(JSON.stringify(many), false);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error).toMatch(/^This batch contains 1[,.  ]?001 products\./u);
    expect(result.error).toContain("or fewer");
  });

  it("refuses malformed input with a reason and never throws", () => {
    expect(prepareImportPayload("", false)).toEqual({
      ok: false,
      error: "Paste a JSON array of products.",
    });
    expect(prepareImportPayload("[", false)).toMatchObject({ ok: false });
    expect(prepareImportPayload('{"nope": 1}', false)).toEqual({
      ok: false,
      error: 'Expected a JSON array (or {"products": [...]}).',
    });
    expect(prepareImportPayload("[]", false)).toEqual({
      ok: false,
      error: "The array is empty.",
    });
    expect(prepareImportPayload('[{"a":1}, 7]', false)).toEqual({
      ok: false,
      error: "Item 2 is not an object.",
    });
  });

  it("refuses an encoded body over the server's byte limit even when the text is under the character limit", () => {
    // 600k two-byte characters: under the 900k-character guard, over the
    // 1,000,000-byte body guard once UTF-8 encoded.
    const wide = "é".repeat(600_000);
    const result = prepareImportPayload(
      JSON.stringify([{ source_id: "p1", title: wide }]),
      false,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error).toMatch(/^The encoded request is /u);
    expect(result.error).toContain("byte limit");
  });
});

describe("importSummaryMessage", () => {
  it("renders the 202 summary's counts verbatim", () => {
    expect(
      importSummaryMessage({
        catalog_id: "cat_1",
        integration_id: "int_1",
        products_seen: 3,
        products_upserted: 2,
        catalog_items_upserted: 2,
        products_skipped: 1,
        imported_at: "2026-09-01T00:00:00Z",
      }),
    ).toBe(
      "Import completed: 3 seen, 2 products upserted, 2 catalog items, 1 skipped.",
    );
  });
});

describe("safeHttpsOrigin", () => {
  // The catalog row shows only the origin of a feed URL: a plaintext feed is
  // not shown at all, and the path/query never reach the DOM.
  it("returns only the origin of an https feed URL", () => {
    expect(safeHttpsOrigin("https://feeds.example.com/spring.xml?token=abc")).toBe(
      "https://feeds.example.com",
    );
  });
  it("refuses plaintext and unparsable values", () => {
    expect(safeHttpsOrigin("http://feeds.example.com/spring.xml")).toBeNull();
    expect(safeHttpsOrigin("not a url")).toBeNull();
    expect(safeHttpsOrigin("")).toBeNull();
  });
});

/* ---------- store data (commerce-7/8): desktop IntegrationBrowsePanel parity ---------- */

describe("analyticsTiles (GET /integrations/{id}/analytics → stat strip)", () => {
  const analytics = {
    customers: 1204,
    products: 7,
    orders: 12,
    revenue_cents: 123456,
    average_order_cents: 10288,
    currency: "USD",
    orders_by_status: { paid: 11, cancelled: 1 },
    last_order_at: "2026-09-01T10:00:00Z",
  };

  it("renders desktop's five tiles in order: counts verbatim, money in the wire currency", () => {
    const tiles = analyticsTiles(analytics);
    expect(tiles.map((t) => [t.key, t.label])).toEqual([
      ["customers", "Customers"],
      ["products", "Products"],
      ["orders", "Orders"],
      ["revenue", "Revenue"],
      ["aov", "Avg order"],
    ]);
    expect(tiles[0]!.value).toBe((1204).toLocaleString());
    expect(tiles[1]!.value).toBe("7");
    expect(tiles[2]!.value).toBe("12");
    expect(tiles[2]!.hint).toBe("cancelled 1 · paid 11");
    expect(tiles[3]!.value).toMatch(/1[,.]234[.,]56/u);
    expect(tiles[4]!.value).toMatch(/102[.,]88/u);
    expect(tiles[4]!.hint).toMatch(/^last order /u);
  });

  it("says 'no orders yet' rather than inventing a last-order time, and em-dashes a missing status map", () => {
    const tiles = analyticsTiles({
      ...analytics,
      orders: 0,
      orders_by_status: null,
      last_order_at: null,
    });
    expect(tiles[2]!.hint).toBe("—");
    expect(tiles[4]!.hint).toBe("no orders yet");
  });

  it("ordersByStatusLabel sorts statuses alphabetically", () => {
    expect(ordersByStatusLabel({ refunded: 2, paid: 30, cancelled: 1 })).toBe(
      "cancelled 1 · paid 30 · refunded 2",
    );
    expect(ordersByStatusLabel(undefined)).toBe("—");
  });
});

describe("maskedEmail (desktop customer-table masking)", () => {
  it("keeps one character of the local part and the whole domain", () => {
    expect(maskedEmail("jane@example.com")).toBe("j•••@example.com");
    expect(maskedEmail("  J@shop.example ")).toBe("J•••@shop.example");
  });

  it("acknowledges an absent or malformed address without echoing it", () => {
    expect(maskedEmail(undefined)).toBe("Email not recorded");
    expect(maskedEmail("")).toBe("Email not recorded");
    expect(maskedEmail("not-an-address")).toBe("Email recorded · masked");
    expect(maskedEmail("a@b@c")).toBe("Email recorded · masked");
  });
});

describe("formatCommerceRecord (variant option values)", () => {
  it("lists keys in stable order and summarizes nested values instead of dumping them", () => {
    expect(
      formatCommerceRecord({ size: "12oz", color: "red", extras: ["lid", "sleeve"], meta: { a: 1 }, empty: null }),
    ).toBe("color: red · empty: not recorded · extras: 2 values · meta: nested record · size: 12oz");
    expect(formatCommerceRecord({})).toBe("none");
    expect(formatCommerceRecord(null)).toBe("none");
  });
});
