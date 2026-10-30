import { describe, expect, it } from "vitest";

import {
  commerceEventError,
  commerceSyncStateLabel,
  commerceSyncStateTone,
  type CommerceEventRow,
  type CommerceIntegration,
} from "@/lib/commerce-api";

function integration(
  partial: Partial<CommerceIntegration> = {},
): CommerceIntegration {
  return {
    id: "int_1",
    provider: "shopify",
    status: "connected",
    scopes: [],
    settings: {},
    created_at: "2026-06-18T00:00:00Z",
    updated_at: "2026-06-18T00:00:00Z",
    ...partial,
  };
}

describe("commerce web API helpers", () => {
  it("labels Shopify async bulk retry state with checkpoint progress", () => {
    const item = integration({
      sync_state: {
        cursor_kind: "shopify_bulk",
        mode: "async_bulk_operation",
        object: "orders",
        operation_id: "gid://shopify/BulkOperation/1",
        line_offset: 12500,
        attempts: 3,
        last_status: "IMPORT_FAILED",
        last_error: "download expired",
        retry_due: true,
      },
    });

    expect(commerceSyncStateLabel(item)).toBe(
      "Orders bulk retry due · import failed · 12,500 lines",
    );
    expect(commerceSyncStateTone(item)).toBe("danger");
  });

  it("extracts sync failure messages from commerce events", () => {
    const event: CommerceEventRow = {
      id: 1,
      event_type: "sync_failed",
      metadata: {
        source: "shopify",
        error: "shopify bulk operation failed: TIMEOUT",
      },
      at: "2026-06-18T12:00:00Z",
    };

    expect(commerceEventError(event)).toBe(
      "shopify bulk operation failed: TIMEOUT",
    );
  });

  it("labels WooCommerce retry state", () => {
    const item = integration({
      provider: "woocommerce",
      sync_state: {
        cursor_kind: "woocommerce_retry",
        mode: "rest_backfill",
        object: "products",
        attempts: 2,
        last_status: "BACKFILL_FAILED",
        last_error: "woocommerce REST products page 3 failed 500",
        retry_due: false,
        retry_wait_seconds: 900,
      },
    });

    expect(commerceSyncStateLabel(item)).toBe(
      "Products WooCommerce retry in 15m · backfill failed",
    );
    expect(commerceSyncStateTone(item)).toBe("danger");
  });

  it("labels BigCommerce retry and queued backfill states", () => {
    const retrying = integration({
      provider: "bigcommerce",
      sync_state: {
        cursor_kind: "bigcommerce_retry",
        mode: "rest_backfill",
        object: "orders",
        attempts: 3,
        last_status: "BACKFILL_FAILED",
        last_error: "BigCommerce rate limited orders page 4",
        retry_due: true,
      },
    });

    expect(commerceSyncStateLabel(retrying)).toBe(
      "Orders BigCommerce retry due · backfill failed",
    );
    expect(commerceSyncStateTone(retrying)).toBe("danger");

    const queued = integration({
      provider: "bigcommerce",
      sync_state: {
        cursor_kind: "bigcommerce_cursor",
        mode: "rest_backfill",
        object: "products",
      },
    });

    expect(commerceSyncStateLabel(queued)).toBe(
      "Products BigCommerce backfill queued",
    );
    expect(commerceSyncStateTone(queued)).toBe("neutral");
  });
});
