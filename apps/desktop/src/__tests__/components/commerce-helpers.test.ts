/**
 * Pure-logic tests for the Commerce page helpers (#33).
 * Node environment — no DOM, no React.
 */

import { describe, expect, it } from "vitest";

import type {
  CommerceAnalytics,
  CommerceIntegration,
  CommerceLifecycleReport,
} from "../../lib/api-client";
import {
  analyticsTiles,
  evaluateSummaryMessage,
  eventCounts30d,
  fmtCents,
  hasNextPage,
  importSummaryMessage,
  integrationSyncStateText,
  integrationSyncStateTone,
  integrationTone,
  lifecycleRows,
  ordersByStatusLabel,
  pageWindowLabel,
  parseProductsJson,
  recoveryStatusTone,
  syncSummaryMessage,
} from "../../components/commerce/commerce-helpers";

function integration(
  partial: Partial<CommerceIntegration> = {},
): CommerceIntegration {
  return {
    id: "int_1",
    provider: "shopify",
    status: "active",
    scopes: [],
    settings: {},
    created_at: "2026-06-01T00:00:00Z",
    updated_at: "2026-06-01T00:00:00Z",
    ...partial,
  };
}

describe("paging", () => {
  it("labels the visible window", () => {
    expect(pageWindowLabel({ total: 312, page: 1, per_page: 25 })).toBe(
      "1–25 of 312",
    );
    expect(pageWindowLabel({ total: 312, page: 13, per_page: 25 })).toBe(
      "301–312 of 312",
    );
    expect(pageWindowLabel({ total: 0, page: 1, per_page: 25 })).toBe(
      "0 items",
    );
  });

  it("knows when a next page exists", () => {
    expect(hasNextPage({ total: 26, page: 1, per_page: 25 })).toBe(true);
    expect(hasNextPage({ total: 25, page: 1, per_page: 25 })).toBe(false);
  });
});

describe("badges", () => {
  it("integration status maps to honest tones", () => {
    expect(integrationTone(integration()).tone).toBe("success");
    expect(integrationTone(integration({ status: "pending" })).tone).toBe(
      "warning",
    );
    expect(
      integrationTone(integration({ error_message: "401 from Shopify" })).tone,
    ).toBe("danger");
    expect(integrationTone(integration({ status: "" })).label).toBe("unknown");
  });

  it("recovery statuses map to tones", () => {
    expect(recoveryStatusTone("recovered")).toBe("success");
    expect(recoveryStatusTone("pending")).toBe("warning");
    expect(recoveryStatusTone("expired")).toBe("neutral");
    expect(recoveryStatusTone("whatever")).toBe("neutral");
  });

  it("summarizes Shopify async bulk sync state", () => {
    const item = integration({
      sync_state: {
        cursor_kind: "shopify_bulk",
        mode: "async_bulk_operation",
        object: "products",
        operation_id: "gid://shopify/BulkOperation/1",
        line_offset: 2400,
        attempts: 2,
        next_attempt_at: "2026-06-18T12:30:00Z",
        last_status: "IMPORT_FAILED",
        last_error: "temporary download failure",
        retry_due: false,
        retry_wait_seconds: 1800,
      },
    });

    expect(integrationSyncStateText(item)).toBe(
      "Products bulk retry in 30m · import failed · 2,400 lines",
    );
    expect(integrationSyncStateTone(item)).toBe("danger");
  });

  it("summarizes completed Shopify sync state", () => {
    const item = integration({
      sync_state: {
        cursor_kind: "shopify_complete",
        mode: "complete",
        object: "complete",
        complete: true,
      },
    });

    expect(integrationSyncStateText(item)).toBe("Backfill complete");
    expect(integrationSyncStateTone(item)).toBe("success");
  });

  it("summarizes WooCommerce retry sync state", () => {
    const item = integration({
      provider: "woocommerce",
      sync_state: {
        cursor_kind: "woocommerce_retry",
        mode: "rest_backfill",
        object: "orders",
        attempts: 3,
        next_attempt_at: "2026-06-18T13:00:00Z",
        last_status: "SYNC_FAILED",
        last_error: "temporary database timeout",
        retry_due: false,
        retry_wait_seconds: 3600,
      },
    });

    expect(integrationSyncStateText(item)).toBe(
      "Orders WooCommerce retry in 1h · sync failed",
    );
    expect(integrationSyncStateTone(item)).toBe("danger");
  });

  it("summarizes BigCommerce retry and queued sync state", () => {
    const retrying = integration({
      provider: "bigcommerce",
      sync_state: {
        cursor_kind: "bigcommerce_retry",
        mode: "rest_backfill",
        object: "customers",
        attempts: 2,
        next_attempt_at: "2026-06-18T13:15:00Z",
        last_status: "BACKFILL_FAILED",
        last_error: "BigCommerce rate limited customers page 2",
        retry_due: false,
        retry_wait_seconds: 900,
      },
    });

    expect(integrationSyncStateText(retrying)).toBe(
      "Customers BigCommerce retry in 15m · backfill failed",
    );
    expect(integrationSyncStateTone(retrying)).toBe("danger");

    const queued = integration({
      provider: "bigcommerce",
      sync_state: {
        cursor_kind: "bigcommerce_cursor",
        mode: "rest_backfill",
        object: "orders",
      },
    });

    expect(integrationSyncStateText(queued)).toBe(
      "Orders BigCommerce backfill queued",
    );
    expect(integrationSyncStateTone(queued)).toBe("neutral");
  });
});

describe("202 toasts are verbatim about queueing", () => {
  it("sync summary carries the 202 + counts", () => {
    const m = syncSummaryMessage({
      customers_upserted: 1200,
      products_upserted: 34,
      orders_upserted: 0,
    });
    expect(m).toContain("202");
    expect(m).toContain("1,200 customers");
    expect(m).toContain("0 orders");
  });

  it("import summary lists every counter", () => {
    const m = importSummaryMessage({
      products_seen: 10,
      products_upserted: 8,
      catalog_items_upserted: 8,
      products_skipped: 2,
    });
    expect(m).toContain("10 seen");
    expect(m).toContain("2 skipped");
  });

  it("evaluate summary reports both eligibility counters", () => {
    const m = evaluateSummaryMessage({
      back_in_stock_eligible: 3,
      price_drop_eligible: 0,
    });
    expect(m).toContain("3 back-in-stock");
    expect(m).toContain("0 price-drop");
  });
});

describe("lifecycle report flattening", () => {
  const report: CommerceLifecycleReport = {
    integration_id: "int_1",
    generated_at: "2026-06-11T00:00:00Z",
    cart_recovery: { total: 4, by_status: { pending: 3, recovered: 1 } },
    back_in_stock: { total: 0, by_status: {} },
    price_drop: { total: 2, by_status: { watching: 2 } },
    events_last_30_days: { checkout_started: 9, order_paid: 4 },
    eligible_last_30_days: 1,
    notified_pending: 2,
  };

  it("produces one row per lifecycle kind with stable status text", () => {
    const rows = lifecycleRows(report);
    expect(rows.map((r) => r.kind)).toEqual([
      "Cart recovery",
      "Back in stock",
      "Price drop",
    ]);
    expect(rows[0]?.byStatus).toBe("pending 3 · recovered 1");
    expect(rows[1]?.byStatus).toBe("—");
  });

  it("sorts 30d events by count descending", () => {
    expect(eventCounts30d(report)).toEqual([
      { event: "checkout_started", count: 9 },
      { event: "order_paid", count: 4 },
    ]);
  });
});

describe("parseProductsJson", () => {
  it("accepts a bare array", () => {
    const p = parseProductsJson('[{"source_id":"p1","title":"Mug"}]');
    expect(p.error).toBeNull();
    expect(p.products).toHaveLength(1);
  });

  it("accepts a {products:[...]} wrapper", () => {
    const p = parseProductsJson('{"products":[{"source_id":"p1"}]}');
    expect(p.error).toBeNull();
    expect(p.products).toHaveLength(1);
  });

  it("rejects junk with a position-bearing message", () => {
    expect(parseProductsJson("").error).toContain("Paste a JSON array");
    expect(parseProductsJson("not json").error).toContain("Not valid JSON");
    expect(parseProductsJson('{"x":1}').error).toContain(
      "Expected a JSON array",
    );
    expect(parseProductsJson('[{"ok":1}, 7]').error).toBe(
      "Item 2 is not an object",
    );
    expect(parseProductsJson("[]").error).toBe("The array is empty");
  });
});

describe("fmtCents", () => {
  it("formats and dashes missing values", () => {
    expect(fmtCents(4900, "USD")).toMatch(/49/);
    expect(fmtCents(null, "USD")).toBe("—");
    expect(fmtCents(1250, "FAKE")).toBe("12.50 FAKE");
  });
});

/* ---------- #33b per-integration analytics strip ---------- */

describe("analyticsTiles", () => {
  const analytics: CommerceAnalytics = {
    customers: 1200,
    products: 45,
    orders: 310,
    revenue_cents: 1234500,
    average_order_cents: 3982,
    currency: "USD",
    orders_by_status: { paid: 300, refunded: 10 },
    last_order_at: "2026-06-10T12:00:00Z",
  };

  it("renders money fields as currency, never raw cents", () => {
    const tiles = analyticsTiles(analytics);
    const revenue = tiles.find((t) => t.key === "revenue");
    const aov = tiles.find((t) => t.key === "aov");
    expect(revenue?.value).toMatch(/12,345/);
    expect(aov?.value).toMatch(/39\.82/);
    for (const t of tiles) {
      expect(t.value).not.toBe("1234500");
    }
  });

  it("carries the per-status order split as the orders hint", () => {
    const orders = analyticsTiles(analytics).find((t) => t.key === "orders");
    expect(orders?.value).toBe("310");
    expect(orders?.hint).toBe("paid 300 · refunded 10");
  });

  it("is honest about a store with no orders", () => {
    const empty = analyticsTiles({
      ...analytics,
      orders: 0,
      orders_by_status: {},
      last_order_at: null,
    });
    expect(empty.find((t) => t.key === "orders")?.hint).toBe("—");
    expect(empty.find((t) => t.key === "aov")?.hint).toBe("no orders yet");
  });
});

describe("ordersByStatusLabel", () => {
  it("sorts statuses alphabetically for a stable label", () => {
    expect(ordersByStatusLabel({ refunded: 1, paid: 12, cancelled: 2 })).toBe(
      "cancelled 2 · paid 12 · refunded 1",
    );
  });
  it("em-dashes empty/missing maps", () => {
    expect(ordersByStatusLabel({})).toBe("—");
    expect(ordersByStatusLabel(undefined)).toBe("—");
  });
});
