// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Pure helpers for the Commerce workspace (catalogs, product feeds, Shopify
 * authorization). Render-free so they unit-test under the node environment.
 *
 * The client-side import bounds mirror the desktop workspace: the server caps
 * a batch at 1000 products and a 1 MiB body, and rejecting oversize input
 * before the request means the user learns the limit from a sentence, not
 * from a 413 after a 60-second upload.
 */

import type {
  CommerceAnalytics,
  CommerceCatalogImportSummary,
} from "@/lib/commerce-api";

export const MAX_IMPORT_PRODUCTS = 1_000;
export const MAX_IMPORT_BODY_BYTES = 1_000_000;
export const MAX_IMPORT_TEXT_LENGTH = 900_000;
export const MAX_FEED_ITEMS = 50;

export interface ParsedProducts {
  products: Array<Record<string, unknown>>;
  error: string | null;
}

/** Parse the import textarea. Accepts a bare JSON array or a
 *  `{products: [...]}` wrapper. Never throws. */
export function parseProductsJson(text: string): ParsedProducts {
  const trimmed = text.trim();
  if (!trimmed) {
    return { products: [], error: "Paste a JSON array of products." };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    return {
      products: [],
      error: `Not valid JSON: ${error instanceof Error ? error.message : "parse error"}`,
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
      error: 'Expected a JSON array (or {"products": [...]}).',
    };
  }
  const bad = arr.findIndex(
    (p) => !p || typeof p !== "object" || Array.isArray(p),
  );
  if (bad >= 0) {
    return { products: [], error: `Item ${bad + 1} is not an object.` };
  }
  if (arr.length === 0) return { products: [], error: "The array is empty." };
  return { products: arr as Array<Record<string, unknown>>, error: null };
}

/**
 * Validate a pasted batch against the client bounds and return the request
 * body, or the sentence that explains why no request will be made.
 */
export function prepareImportPayload(
  text: string,
  replace: boolean,
):
  | { ok: true; payload: { products: Array<Record<string, unknown>>; replace?: boolean } }
  | { ok: false; error: string } {
  if (text.length > MAX_IMPORT_TEXT_LENGTH) {
    return {
      ok: false,
      error: `The import exceeds the ${MAX_IMPORT_TEXT_LENGTH.toLocaleString()}-character safety limit. Split it into smaller batches.`,
    };
  }
  const parsed = parseProductsJson(text);
  if (parsed.error) return { ok: false, error: parsed.error };
  if (parsed.products.length > MAX_IMPORT_PRODUCTS) {
    return {
      ok: false,
      error: `This batch contains ${parsed.products.length.toLocaleString()} products. Split it into batches of ${MAX_IMPORT_PRODUCTS.toLocaleString()} or fewer.`,
    };
  }
  const payload = {
    products: parsed.products,
    ...(replace ? { replace: true } : {}),
  };
  const payloadBytes = new TextEncoder().encode(
    JSON.stringify(payload),
  ).byteLength;
  if (payloadBytes > MAX_IMPORT_BODY_BYTES) {
    return {
      ok: false,
      error: `The encoded request is ${payloadBytes.toLocaleString()} bytes. Split it into batches below the server's ${MAX_IMPORT_BODY_BYTES.toLocaleString()}-byte limit.`,
    };
  }
  return { ok: true, payload };
}

/** The 202 summary, verbatim. */
export function importSummaryMessage(
  s: CommerceCatalogImportSummary,
): string {
  return (
    `Import completed: ${s.products_seen.toLocaleString()} seen, ` +
    `${s.products_upserted.toLocaleString()} products upserted, ` +
    `${s.catalog_items_upserted.toLocaleString()} catalog items, ` +
    `${s.products_skipped.toLocaleString()} skipped.`
  );
}

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

/** Number of configured keys, as the feed table reports criteria/fallback. */
export function configuredFieldsLabel(
  value: Record<string, unknown> | null | undefined,
): string {
  const count = value ? Object.keys(value).length : 0;
  return count > 0
    ? `${count.toLocaleString()} configured field${count === 1 ? "" : "s"}`
    : "none";
}

/** Origin of a feed URL when it is https; the path and query stay hidden. */
export function safeHttpsOrigin(value: string): string | null {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" && parsed.hostname
      ? parsed.origin
      : null;
  } catch {
    return null;
  }
}

/**
 * A Shopify shop domain the OAuth start endpoint will accept: a bare
 * `*.myshopify.com` host — no scheme, path, port, credentials, or query.
 */
export function normalizeShopifyDomain(value: string): string | null {
  const candidate = value.trim().toLowerCase();
  if (!candidate || /[/?#@]/u.test(candidate)) return null;
  try {
    const parsed = new URL(`https://${candidate}`);
    if (
      parsed.port ||
      parsed.username ||
      parsed.password ||
      !parsed.hostname.endsWith(".myshopify.com") ||
      parsed.hostname === "myshopify.com"
    ) {
      return null;
    }
    return parsed.hostname;
  } catch {
    return null;
  }
}

/**
 * The safety check desktop applies before handing an authorize URL to the
 * browser: https only, no embedded credentials, and a host that is either the
 * shop itself or Shopify's own accounts domain. Anything else — a downgraded
 * scheme, a look-alike host, a redirector — is refused and no tab is opened.
 */
export function verifiedShopifyAuthorizationUrl(
  value: string,
  shopDomain: string,
): string | null {
  try {
    const parsed = new URL(value);
    const approvedHost =
      parsed.hostname === shopDomain ||
      parsed.hostname === "accounts.shopify.com" ||
      parsed.hostname.endsWith(".shopify.com");
    if (
      parsed.protocol !== "https:" ||
      parsed.username ||
      parsed.password ||
      !approvedHost
    ) {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

export function formatCommerceTime(value?: string | null): string {
  if (!value) return "not recorded";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/* ---------- store data (desktop IntegrationBrowsePanel parity) ---------- */

/** Desktop's customer-table masking: first character of the local part, then
 *  the domain. A malformed address is acknowledged without being echoed. */
export function maskedEmail(value?: string | null): string {
  if (!value) return "Email not recorded";
  const [local, domain, ...rest] = value.trim().split("@");
  if (!local || !domain || rest.length > 0) return "Email recorded · masked";
  return `${local.slice(0, 1) || "•"}•••@${domain}`;
}

/** "color: red · size: M" — stable key order, "none" when empty. Nested
 *  values are summarized rather than dumped. */
export function formatCommerceRecord(
  value: Record<string, unknown> | null | undefined,
): string {
  const entries = Object.entries(value ?? {}).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  if (entries.length === 0) return "none";
  return entries
    .map(([key, raw]) => {
      const rendered =
        raw === null || raw === undefined
          ? "not recorded"
          : typeof raw === "object"
            ? Array.isArray(raw)
              ? `${raw.length.toLocaleString()} values`
              : "nested record"
            : String(raw);
      return `${key}: ${rendered}`;
    })
    .join(" · ");
}

export interface AnalyticsTile {
  key: string;
  label: string;
  value: string;
  hint?: string;
}

/** "cancelled 1 · paid 12" — stable alphabetical order, em-dash when empty. */
export function ordersByStatusLabel(
  byStatus: Record<string, number> | null | undefined,
): string {
  return (
    Object.entries(byStatus ?? {})
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([status, count]) => `${status} ${count.toLocaleString()}`)
      .join(" · ") || "—"
  );
}

/**
 * GET /integrations/{id}/analytics → the stat-strip model. Money fields
 * arrive as cents and render via fmtCents in the wire's currency; counts stay
 * verbatim. Same five tiles, in the same order, as desktop.
 */
export function analyticsTiles(a: CommerceAnalytics): AnalyticsTile[] {
  return [
    { key: "customers", label: "Customers", value: a.customers.toLocaleString() },
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
        ? `last order ${formatCommerceTime(a.last_order_at)}`
        : "no orders yet",
    },
  ];
}
