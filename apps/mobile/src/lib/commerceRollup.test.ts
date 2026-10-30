import { describe, expect, it } from "vitest";

import {
  centsToMajor,
  commerceSyncErrorMessage,
  isCommerceScopeDenied,
  normalizeCommerceAnalytics,
  normalizeCommerceStores,
  storesNeedingAttention,
  syncHealthOf,
} from "./commerceRollup";

describe("syncHealthOf", () => {
  it("reads a completed backfill as complete even when a stale error is present", () => {
    // The cursor keeps the error from the attempt BEFORE the one that
    // succeeded. Reporting a finished backfill as failing is how someone
    // re-runs a sync that did not need re-running.
    const health = syncHealthOf({
      complete: true,
      last_error: "429 from Shopify",
      attempts: 4,
    });
    expect(health.tone).toBe("ok");
    expect(health.lastError).toBe("");
    expect(health.label).toBe("Backfill complete");
  });

  it("prefers 'retrying' over 'failed' when the platform already rescheduled", () => {
    const health = syncHealthOf({
      retry_due: true,
      attempts: 2,
      last_error: "timeout",
      next_attempt_at: "2026-07-26T12:00:00Z",
    });
    expect(health.tone).toBe("retrying");
    expect(health.label).toBe("Retrying after 2 failed attempts");
    expect(health.nextAttemptAt).toBe("2026-07-26T12:00:00Z");
  });

  it("singularises a single failed attempt", () => {
    expect(syncHealthOf({ retry_due: true, attempts: 1 }).label).toBe(
      "Retrying after 1 failed attempt",
    );
  });

  it("says 'retry scheduled' when the attempt count is not known", () => {
    expect(syncHealthOf({ retry_due: true }).label).toBe("Retry scheduled");
  });

  it("reports a bare error as stopped", () => {
    const health = syncHealthOf({ last_error: "401 unauthorized" });
    expect(health.tone).toBe("failed");
    expect(health.lastError).toBe("401 unauthorized");
  });

  it("is idle — not ok — when there is no cursor at all", () => {
    for (const junk of [undefined, null, {}, "nope", 7]) {
      const health = syncHealthOf(junk);
      expect(health.tone).toBe("idle");
      expect(health.label).toBe("No backfill in progress");
      expect(health.attempts).toBe(0);
    }
  });
});

describe("normalizeCommerceStores", () => {
  it("accepts the bare array the handler actually writes", () => {
    const stores = normalizeCommerceStores([
      {
        id: "int-1",
        provider: "shopify",
        shop_domain: "acme.myshopify.com",
        status: "active",
        last_sync_at: "2026-07-25T09:00:00Z",
        sync_state: { complete: true },
      },
    ]);
    expect(stores).toHaveLength(1);
    expect(stores[0]?.shopDomain).toBe("acme.myshopify.com");
    expect(stores[0]?.sync.tone).toBe("ok");
  });

  it("accepts an {items} envelope and skips rows with no id", () => {
    const stores = normalizeCommerceStores({
      items: [{ provider: "stripe" }, { id: "int-2", provider: "stripe" }],
    });
    expect(stores.map((s) => s.id)).toEqual(["int-2"]);
  });

  it("never invents a provider or status", () => {
    const stores = normalizeCommerceStores([{ id: "int-3" }]);
    expect(stores[0]?.provider).toBe("store");
    expect(stores[0]?.status).toBe("unknown");
  });

  it("returns an empty list rather than throwing on junk", () => {
    for (const junk of [null, undefined, 42, "nope", {}]) {
      expect(normalizeCommerceStores(junk)).toEqual([]);
    }
  });
});

describe("normalizeCommerceAnalytics", () => {
  it("keeps revenue in cents and carries the integration's own currency", () => {
    const a = normalizeCommerceAnalytics({
      customers: 12,
      products: 40,
      orders: 8,
      revenue_cents: 129_900,
      average_order_cents: 16_237,
      currency: "EUR",
      orders_by_status: { paid: 6, refunded: 1, pending: 1 },
      last_order_at: "2026-07-25T08:00:00Z",
    });
    expect(a.revenueCents).toBe(129_900);
    expect(centsToMajor(a.revenueCents)).toBe(1299);
    expect(a.currency).toBe("EUR");
    expect(a.lastOrderAt).toBe("2026-07-25T08:00:00Z");
  });

  it("orders the status strip by count, then alphabetically, and drops zeroes", () => {
    const a = normalizeCommerceAnalytics({
      orders_by_status: { refunded: 2, paid: 9, zeroed: 0, cancelled: 2 },
    });
    expect(a.ordersByStatus).toEqual([
      { status: "paid", count: 9 },
      { status: "cancelled", count: 2 },
      { status: "refunded", count: 2 },
    ]);
  });

  it("defaults the currency to USD only when the server sent none", () => {
    expect(normalizeCommerceAnalytics({}).currency).toBe("USD");
  });

  it("survives junk without throwing", () => {
    for (const junk of [null, undefined, "nope", 7, []]) {
      const a = normalizeCommerceAnalytics(junk);
      expect(a.orders).toBe(0);
      expect(a.ordersByStatus).toEqual([]);
    }
  });
});

describe("commerceSyncErrorMessage", () => {
  it("translates every status the handler can return", () => {
    expect(commerceSyncErrorMessage({ status: 403 })).toBe(
      "Resuming a sync needs an owner or admin session.",
    );
    expect(commerceSyncErrorMessage({ status: 409 })).toBe(
      "This store is disconnected. Reconnect it on the web admin first.",
    );
    expect(commerceSyncErrorMessage({ status: 422 })).toBe(
      "This provider can't be resumed from the app — it needs a sync run from the web admin.",
    );
    expect(commerceSyncErrorMessage({ status: 404 })).toBe(
      "That store no longer exists. Pull to refresh.",
    );
  });

  it("falls back to the error's own message, then to a plain sentence", () => {
    expect(commerceSyncErrorMessage(new Error("network down"))).toBe(
      "network down",
    );
    expect(commerceSyncErrorMessage(undefined)).toBe(
      "Couldn't start the sync.",
    );
  });
});

describe("isCommerceScopeDenied", () => {
  it("is true only for a 403", () => {
    expect(isCommerceScopeDenied({ status: 403 })).toBe(true);
    expect(isCommerceScopeDenied({ status: 500 })).toBe(false);
    expect(isCommerceScopeDenied(new Error("nope"))).toBe(false);
    expect(isCommerceScopeDenied(null)).toBe(false);
  });
});

describe("storesNeedingAttention", () => {
  it("counts stopped syncs, integration errors and disconnected stores once each", () => {
    const stores = normalizeCommerceStores([
      { id: "a", status: "active", sync_state: { complete: true } },
      { id: "b", status: "active", sync_state: { last_error: "401" } },
      { id: "c", status: "disconnected" },
      { id: "d", status: "active", error_message: "token expired" },
      { id: "e", status: "active", sync_state: { retry_due: true } },
    ]);
    // b (failed), c (disconnected), d (integration error). `e` is retrying —
    // the platform is handling it — and `a` is done.
    expect(storesNeedingAttention(stores)).toBe(3);
  });
});
