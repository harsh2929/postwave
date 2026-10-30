/**
 * Pure helpers for the Commerce page (#33).
 *
 * Render-free so it unit-tests under the node vitest environment.
 * Wire notes (WIRING-WRAPPERS.md #33): every list endpoint except
 * integrations returns `{items, total, page, per_page}`; sync/import
 * are 202 + summary; back-in-stock / price-drop creates are nested
 * under /integrations/{id}/products/{product_id}/….
 */

import type {
  CommerceAnalytics,
  CommerceIntegration,
  CommerceLifecycleReport,
  CommercePageInfo,
} from "../../lib/api-client";

/* ---------- money + paging ---------- */

export function fmtCents(
  cents: number | null | undefined,
  currency: string | undefined,
): string {
  if (cents == null) return "—";
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: currency || "USD",
      maximumFractionDigits: 2,
    }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency ?? ""}`.trim();
  }
}

/** "1–25 of 312" — honest window label for the paged tables. */
export function pageWindowLabel(p: CommercePageInfo): string {
  if (p.total <= 0) return "0 items";
  const start = (p.page - 1) * p.per_page + 1;
  const end = Math.min(p.total, p.page * p.per_page);
  return `${start.toLocaleString()}–${end.toLocaleString()} of ${p.total.toLocaleString()}`;
}

export function hasNextPage(p: CommercePageInfo): boolean {
  return p.page * p.per_page < p.total;
}

/* ---------- status badges ---------- */

export type BadgeTone = "success" | "warning" | "danger" | "neutral";

export function integrationTone(i: CommerceIntegration): {
  tone: BadgeTone;
  label: string;
} {
  const s = (i.status || "").toLowerCase();
  if (i.error_message) return { tone: "danger", label: s || "error" };
  if (s === "active" || s === "connected") return { tone: "success", label: s };
  if (s === "pending" || s === "syncing") return { tone: "warning", label: s };
  return { tone: "neutral", label: s || "unknown" };
}

export function integrationSyncStateText(
  i: CommerceIntegration,
): string | null {
  const state = i.sync_state;
  if (!state) return null;
  if (state.cursor_kind === "shopify_complete" || state.complete) {
    return "Backfill complete";
  }
  if (state.cursor_kind === "shopify_bulk") {
    const object = titleCase(state.object || "bulk");
    const status = state.last_status
      ? state.last_status.toLowerCase().replace(/_/g, " ")
      : "running";
    const progress =
      (state.line_offset ?? 0) > 0
        ? ` · ${state.line_offset?.toLocaleString()} lines`
        : "";
    if (state.retry_due) {
      return `${object} bulk retry due · ${status}${progress}`;
    }
    if ((state.retry_wait_seconds ?? 0) > 0) {
      return `${object} bulk retry in ${formatDurationSeconds(state.retry_wait_seconds ?? 0)} · ${status}${progress}`;
    }
    if ((state.attempts ?? 0) > 0) {
      return `${object} bulk retry ${state.attempts} · ${status}${progress}`;
    }
    return `${object} bulk ${status}${progress}`;
  }
  if (state.cursor_kind === "shopify_cursor") {
    return `${titleCase(state.object || "sync")} backfill queued`;
  }
  if (state.cursor_kind === "woocommerce_retry") {
    const object = titleCase(state.object || "sync");
    const status = state.last_status
      ? state.last_status.toLowerCase().replace(/_/g, " ")
      : "failed";
    if (state.retry_due) {
      return `${object} WooCommerce retry due · ${status}`;
    }
    if ((state.retry_wait_seconds ?? 0) > 0) {
      return `${object} WooCommerce retry in ${formatDurationSeconds(state.retry_wait_seconds ?? 0)} · ${status}`;
    }
    return `${object} WooCommerce retry ${state.attempts ?? 1} · ${status}`;
  }
  if (state.cursor_kind === "woocommerce_cursor") {
    return `${titleCase(state.object || "sync")} WooCommerce backfill queued`;
  }
  if (state.cursor_kind === "bigcommerce_retry") {
    const object = titleCase(state.object || "sync");
    const status = state.last_status
      ? state.last_status.toLowerCase().replace(/_/g, " ")
      : "failed";
    if (state.retry_due) {
      return `${object} BigCommerce retry due · ${status}`;
    }
    if ((state.retry_wait_seconds ?? 0) > 0) {
      return `${object} BigCommerce retry in ${formatDurationSeconds(state.retry_wait_seconds ?? 0)} · ${status}`;
    }
    return `${object} BigCommerce retry ${state.attempts ?? 1} · ${status}`;
  }
  if (state.cursor_kind === "bigcommerce_cursor") {
    return `${titleCase(state.object || "sync")} BigCommerce backfill queued`;
  }
  if (state.cursor_kind === "legacy") {
    return "Legacy backfill cursor";
  }
  return null;
}

export function integrationSyncStateTone(i: CommerceIntegration): BadgeTone {
  const state = i.sync_state;
  if (!state) return "neutral";
  if (state.last_error) return "danger";
  if (
    state.cursor_kind === "woocommerce_retry" ||
    state.cursor_kind === "bigcommerce_retry"
  ) {
    return "danger";
  }
  if (state.cursor_kind === "shopify_bulk" && !state.retry_due)
    return "warning";
  if (state.cursor_kind === "shopify_complete" || state.complete)
    return "success";
  return "neutral";
}

function formatDurationSeconds(seconds: number): string {
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  return `${hours}h`;
}

function titleCase(value: string): string {
  return value
    .split(/[_-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function recoveryStatusTone(status: string): BadgeTone {
  const s = (status || "").toLowerCase();
  if (["converted", "recovered", "notified"].includes(s)) return "success";
  if (["active", "waiting", "pending", "eligible", "watching"].includes(s)) {
    return "warning";
  }
  if (["expired", "disabled", "cancelled", "canceled"].includes(s)) {
    return "neutral";
  }
  return "neutral";
}

/* ---------- action toasts (verbatim 202 summaries) ---------- */

export function syncSummaryMessage(s: {
  customers_upserted: number;
  products_upserted: number;
  orders_upserted: number;
}): string {
  return (
    `Sync accepted (202): ${s.customers_upserted.toLocaleString()} customers, ` +
    `${s.products_upserted.toLocaleString()} products, ` +
    `${s.orders_upserted.toLocaleString()} orders upserted.`
  );
}

export function importSummaryMessage(s: {
  products_seen: number;
  products_upserted: number;
  catalog_items_upserted: number;
  products_skipped: number;
}): string {
  return (
    `Import completed: ${s.products_seen.toLocaleString()} seen, ` +
    `${s.products_upserted.toLocaleString()} products upserted, ` +
    `${s.catalog_items_upserted.toLocaleString()} catalog items, ` +
    `${s.products_skipped.toLocaleString()} skipped.`
  );
}

export function evaluateSummaryMessage(s: {
  back_in_stock_eligible: number;
  price_drop_eligible: number;
}): string {
  return (
    `Evaluation finished: ${s.back_in_stock_eligible.toLocaleString()} back-in-stock and ` +
    `${s.price_drop_eligible.toLocaleString()} price-drop subscriptions are now eligible to notify.`
  );
}

/* ---------- lifecycle report flattening ---------- */

export interface LifecycleRow {
  kind: string;
  total: number;
  /** "pending 3 · notified 1" — stable alphabetical order. */
  byStatus: string;
}

export function lifecycleRows(r: CommerceLifecycleReport): LifecycleRow[] {
  const mk = (
    kind: string,
    s: { total: number; by_status: Record<string, number> },
  ): LifecycleRow => ({
    kind,
    total: s.total,
    byStatus:
      Object.entries(s.by_status ?? {})
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${k} ${v.toLocaleString()}`)
        .join(" · ") || "—",
  });
  return [
    mk("Cart recovery", r.cart_recovery),
    mk("Back in stock", r.back_in_stock),
    mk("Price drop", r.price_drop),
  ];
}

export function eventCounts30d(r: CommerceLifecycleReport): Array<{
  event: string;
  count: number;
}> {
  return Object.entries(r.events_last_30_days ?? {})
    .map(([event, count]) => ({ event, count }))
    .sort((a, b) => b.count - a.count);
}

/* ---------- per-integration analytics strip ---------- */

export interface AnalyticsTile {
  key: string;
  label: string;
  value: string;
  hint?: string;
}

/** "cancelled 1 · paid 12" — stable alphabetical order, em-dash when empty. */
export function ordersByStatusLabel(
  byStatus: Record<string, number> | undefined,
): string {
  return (
    Object.entries(byStatus ?? {})
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k} ${v.toLocaleString()}`)
      .join(" · ") || "—"
  );
}

/**
 * GET /integrations/{id}/analytics → the stat-strip model. Money
 * fields arrive as cents and render via fmtCents in the wire's
 * currency; counts stay verbatim.
 */
export function analyticsTiles(a: CommerceAnalytics): AnalyticsTile[] {
  return [
    {
      key: "customers",
      label: "Customers",
      value: a.customers.toLocaleString(),
    },
    { key: "products", label: "Products", value: a.products.toLocaleString() },
    {
      key: "orders",
      label: "Orders",
      value: a.orders.toLocaleString(),
      hint: ordersByStatusLabel(a.orders_by_status),
    },
    {
      key: "revenue",
      label: "Revenue",
      value: fmtCents(a.revenue_cents, a.currency),
    },
    {
      key: "aov",
      label: "Avg order",
      value: fmtCents(a.average_order_cents, a.currency),
      hint: a.last_order_at
        ? `last order ${fmtCommerceDate(a.last_order_at)}`
        : "no orders yet",
    },
  ];
}

/* ---------- import JSON parsing ---------- */

export interface ParsedProducts {
  products: Array<Record<string, unknown>>;
  error: string | null;
}

/** Parse the catalog-import textarea. Accepts a bare JSON array or a
 *  `{products: [...]}` wrapper. Never throws. */
export function parseProductsJson(text: string): ParsedProducts {
  const trimmed = text.trim();
  if (!trimmed)
    return { products: [], error: "Paste a JSON array of products" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (e) {
    return {
      products: [],
      error: `Not valid JSON: ${e instanceof Error ? e.message : "parse error"}`,
    };
  }
  const arr = Array.isArray(parsed)
    ? parsed
    : parsed &&
        typeof parsed === "object" &&
        Array.isArray((parsed as { products?: unknown }).products)
      ? (parsed as { products: unknown[] }).products
      : null;
  if (!arr) {
    return {
      products: [],
      error: 'Expected a JSON array (or {"products": [...]})',
    };
  }
  const bad = arr.findIndex(
    (p) => !p || typeof p !== "object" || Array.isArray(p),
  );
  if (bad >= 0) {
    return { products: [], error: `Item ${bad + 1} is not an object` };
  }
  if (arr.length === 0) return { products: [], error: "The array is empty" };
  return { products: arr as Array<Record<string, unknown>>, error: null };
}

/* ---------- dates ---------- */

export function fmtCommerceDate(s: string | null | undefined): string {
  if (!s) return "—";
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
