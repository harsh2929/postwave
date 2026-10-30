import { describe, expect, it } from "vitest";

import {
  attributedSlice,
  averageOrderCentsOrNull,
  normalizeCommerceOrders,
  orderReference,
  orderStatusClass,
} from "./commerceOrders";

describe("orderStatusClass", () => {
  it("recognises the four words every provider adapter funnels into", () => {
    // shopify.go:285-300, woocommerce.go:758-769, stripe.go:885-896 and the
    // seven other adapters all normalise to exactly these.
    expect(orderStatusClass("paid")).toBe("paid");
    expect(orderStatusClass("pending")).toBe("pending");
    expect(orderStatusClass("refunded")).toBe("refunded");
    expect(orderStatusClass("cancelled")).toBe("cancelled");
    expect(orderStatusClass("PAID")).toBe("paid");
  });

  it("classes anything else as 'other' rather than guessing 'pending'", () => {
    // A record POSTed straight through the sync payload can carry any status.
    // Calling an unknown one "pending" would tell someone money is still
    // coming when nobody knows that.
    expect(orderStatusClass("partially_fulfilled")).toBe("other");
    expect(orderStatusClass("")).toBe("other");
    expect(orderStatusClass(undefined)).toBe("other");
    expect(orderStatusClass(7)).toBe("other");
  });
});

describe("orderReference", () => {
  it("strips the adapter's namespacing and keeps what a merchant recognises", () => {
    expect(orderReference("shopify://order/450789469")).toBe("450789469");
    expect(orderReference("woocommerce://order/1042")).toBe("1042");
    expect(orderReference("stripe://payment_intent/pi_123")).toBe("pi_123");
  });

  it("passes a bare id through and never returns an empty tail", () => {
    expect(orderReference("1042")).toBe("1042");
    expect(orderReference("shopify://order/")).toBe("shopify://order/");
    expect(orderReference("")).toBe("");
    expect(orderReference(null)).toBe("");
  });
});

describe("normalizeCommerceOrders", () => {
  it("reads the {items, next_cursor} page the handler writes", () => {
    const page = normalizeCommerceOrders({
      items: [
        {
          id: "0d9d6f7e-1111-4111-8111-111111111111",
          source_id: "shopify://order/450789469",
          customer_email: "buyer@example.com",
          status: "paid",
          total_cents: 12_900,
          currency: "EUR",
          ordered_at: "2026-07-25T08:00:00Z",
          campaign_id: "camp-1",
        },
      ],
      next_cursor: "eyJ4IjoxfQ",
    });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.reference).toBe("450789469");
    expect(page.items[0]?.totalCents).toBe(12_900);
    expect(page.items[0]?.currency).toBe("EUR");
    expect(page.items[0]?.statusClass).toBe("paid");
    expect(page.nextCursor).toBe("eyJ4IjoxfQ");
  });

  it("keeps the server's own ordering — most recent first, never re-sorted", () => {
    // repo.go:2508 is `ORDER BY ordered_at DESC, id DESC` and the keyset pages
    // on that pair; re-sorting client-side would desync the cursor.
    const page = normalizeCommerceOrders({
      items: [
        { id: "b", ordered_at: "2026-07-25T10:00:00Z" },
        { id: "a", ordered_at: "2026-07-25T09:00:00Z" },
      ],
    });
    expect(page.items.map((o) => o.id)).toEqual(["b", "a"]);
  });

  it("skips rows with no id and never invents a currency per row", () => {
    const page = normalizeCommerceOrders({
      items: [{ source_id: "x://order/1" }, { id: "keep" }],
    });
    expect(page.items.map((o) => o.id)).toEqual(["keep"]);
    // The Go zero value for Currency is "", and every adapter defaults to USD
    // before it reaches the DB, so USD is the honest fallback for a bare row.
    expect(page.items[0]?.currency).toBe("USD");
    // No source_id → fall back to a short slice of the uuid, never "".
    expect(page.items[0]?.reference).toBe("keep");
  });

  it("has no next cursor and no items for junk, rather than throwing", () => {
    for (const junk of [null, undefined, 7, "nope", {}]) {
      const page = normalizeCommerceOrders(junk);
      expect(page.items).toEqual([]);
      expect(page.nextCursor).toBe("");
    }
  });
});

describe("averageOrderCentsOrNull", () => {
  it("is null — not zero — when the store has no orders", () => {
    // repo.go:2588 only assigns AverageOrderCents when Orders > 0, so the
    // field arrives as a plain 0. Rendering "$0.00" would state a measurement
    // that was never taken.
    expect(
      averageOrderCentsOrNull({ orders: 0, averageOrderCents: 0 }),
    ).toBeNull();
  });

  it("passes the server's own integer through once there ARE orders", () => {
    expect(
      averageOrderCentsOrNull({ orders: 8, averageOrderCents: 16_237 }),
    ).toBe(16_237);
    // A genuine zero average over real orders is a real fact and survives.
    expect(averageOrderCentsOrNull({ orders: 3, averageOrderCents: 0 })).toBe(0);
  });
});

describe("attributedSlice", () => {
  const page = normalizeCommerceOrders({
    items: [
      {
        id: "1",
        campaign_id: "camp-1",
        status: "paid",
        total_cents: 10_000,
        currency: "USD",
      },
      {
        id: "2",
        campaign_id: "camp-1",
        status: "refunded",
        total_cents: 50_000,
        currency: "USD",
      },
      { id: "3", status: "paid", total_cents: 99_900, currency: "USD" },
      {
        id: "4",
        campaign_id: "camp-2",
        status: "paid",
        total_cents: 2_500,
        currency: "USD",
      },
    ],
  });

  it("counts attributed orders but only banks revenue that was actually paid", () => {
    const slice = attributedSlice(page.items);
    // Three carry a campaign_id; the refunded one is counted as attributed
    // but its money is NOT revenue — crediting a campaign for money that came
    // back is the classic attribution lie.
    expect(slice.count).toBe(3);
    expect(slice.revenueCents).toBe(12_500);
    expect(slice.currency).toBe("USD");
    // The sample size travels with the number so no caller can present it as
    // a workspace total.
    expect(slice.sampled).toBe(4);
  });

  it("refuses to name a currency when the sample mixes them", () => {
    const mixed = normalizeCommerceOrders({
      items: [
        {
          id: "1",
          campaign_id: "c",
          status: "paid",
          total_cents: 100,
          currency: "USD",
        },
        {
          id: "2",
          campaign_id: "c",
          status: "paid",
          total_cents: 100,
          currency: "EUR",
        },
      ],
    });
    expect(attributedSlice(mixed.items).currency).toBe("");
  });

  it("is all zeroes for an empty sample", () => {
    expect(attributedSlice([])).toEqual({
      count: 0,
      revenueCents: 0,
      currency: "",
      sampled: 0,
    });
  });
});
