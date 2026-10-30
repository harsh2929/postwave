/**
 * Pure helpers for the Track page's "Conversions" section (#32).
 *
 * Render-free so it unit-tests under the node vitest environment.
 * Wire notes (WIRING-WRAPPERS.md #32):
 *   - GET /conversions is a BARE ARRAY, 50/page, cursor = the last
 *     row's (occurred_at, id) passed back as ?before=&before_id=
 *   - tracking keys list is a bare array; createKey returns plaintext
 *     in the creation response while the ordinary register never does
 *   - ingestion is the PUBLIC endpoint POST /api/public/track/conversion
 *     authenticated by the tracking key (verified in
 *     apps/api/internal/conversions/conversions.go)
 */

import type {
  ConversionListCursor,
  ConversionRow,
  ConversionTrackingKey,
} from "../lib/api-client";

/** Server page size for GET /conversions — a shorter page means EOF. */
export const CONVERSIONS_PAGE_SIZE = 50;

export const CONVERSION_TRACKING_KEY_LABEL_MAX_CODE_POINTS = 120;

const CONVERSION_TRACKING_KEY_LABEL_REQUIRED =
  "Give the key a label so you can tell keys apart later.";
const CONVERSION_TRACKING_KEY_LABEL_INVALID =
  "Use a label without control characters (120 characters maximum).";

/** Mirrors the server's Unicode-code-point and Unicode Cc boundaries. */
export function conversionTrackingKeyLabelError(
  rawLabel: string,
): string | null {
  const label = rawLabel.trim();
  if (!label) return CONVERSION_TRACKING_KEY_LABEL_REQUIRED;
  if (
    Array.from(label).length > CONVERSION_TRACKING_KEY_LABEL_MAX_CODE_POINTS ||
    /\p{Cc}/u.test(label)
  ) {
    return CONVERSION_TRACKING_KEY_LABEL_INVALID;
  }
  return null;
}

/** Cursor for the next page: the oldest row's timestamp plus ID (rows
 *  come newest-first). Null when the page wasn't full or the boundary
 *  cannot form a safe deterministic cursor. */
export function nextConversionsCursor(
  page: ConversionRow[] | undefined | null,
): ConversionListCursor | null {
  // The feed wire is a bare array; a missing/non-array body means "no
  // more pages" rather than a crash.
  if (!Array.isArray(page) || page.length < CONVERSIONS_PAGE_SIZE) return null;
  const last = page[page.length - 1];
  if (
    !last ||
    typeof last.occurred_at !== "string" ||
    last.occurred_at.length === 0 ||
    !Number.isSafeInteger(last.id) ||
    last.id <= 0
  ) {
    return null;
  }
  return { before: last.occurred_at, beforeId: last.id };
}

/** Format amount_cents honestly: "—" when the event carried no
 *  amount (not $0.00, which would imply a measured zero). */
export function fmtConversionAmount(
  amountCents: number | null | undefined,
  currency: string | undefined,
): string {
  if (amountCents == null) return "—";
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: currency || "USD",
      maximumFractionDigits: 2,
    }).format(amountCents / 100);
  } catch {
    // Unknown ISO code from the wire — show the raw value rather
    // than crashing the row.
    return `${(amountCents / 100).toFixed(2)} ${currency ?? ""}`.trim();
  }
}

export interface KeyState {
  label: string;
  tone: "success" | "neutral";
}

export function trackingKeyState(k: ConversionTrackingKey): KeyState {
  return k.revoked_at
    ? { label: "Revoked", tone: "neutral" }
    : { label: "Active", tone: "success" };
}

/**
 * curl snippet for the public ingestion endpoint. `apiBase` comes from
 * getApiUrl() at render time so the snippet matches the connected
 * server. The route is /api/public/track/conversion (NOT /api/v1) and
 * auth is the tracking key, not the dashboard API key.
 */
export function conversionCurlSnippet(
  apiBase: string,
  keyHint?: string,
): string {
  let base = "https://api.example.invalid";
  let baseVerified = false;
  try {
    const parsed = new URL(apiBase);
    if (
      ["http:", "https:"].includes(parsed.protocol) &&
      !parsed.username &&
      !parsed.password &&
      !parsed.search &&
      !parsed.hash
    ) {
      base = parsed.href.replace(/\/+$/, "");
      baseVerified = true;
    }
  } catch {
    // Keep the non-routable example.invalid placeholder below.
  }
  const endpoint = `${base}/api/public/track/conversion`;
  const shellQuote = (value: string): string =>
    `'${value.replace(/'/g, `'"'"'`)}'`;
  const safeHint =
    keyHint && /^[A-Za-z0-9._:-]{1,128}…?$/.test(keyHint) ? keyHint : null;
  return [
    "# Publishable telemetry example — not signed ingest. Browser JSON requires an API-allowed CORS origin.",
    ...(baseVerified
      ? []
      : ["# API base was not verified; replace the non-routable host below."]),
    ...(safeHint
      ? [`# Active key prefix (not a credential): ${safeHint}`]
      : []),
    `curl -X POST ${shellQuote(endpoint)} \\`,
    `  -H 'Authorization: Bearer <tracking-key>' \\`,
    `  -H 'Content-Type: application/json' \\`,
    `  -d '{`,
    `    "event_name": "purchase",`,
    `    "amount_cents": 4900,`,
    `    "currency": "USD",`,
    `    "properties": {"sku": "PW-001"}`,
    `  }'`,
  ].join("\n");
}

/** Short label for a key row — "pwk_ab12…" style prefix display. */
export function keyPrefixDisplay(k: ConversionTrackingKey): string {
  return k.prefix ? `${k.prefix}…` : "—";
}
