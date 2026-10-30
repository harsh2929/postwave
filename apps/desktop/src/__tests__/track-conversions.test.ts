/**
 * Pure-logic tests for the Track page's Conversions section (#32).
 * Node environment — no DOM, no React.
 */

import { describe, expect, it } from "vitest";

import type { ConversionRow, ConversionTrackingKey } from "../lib/api-client";
import {
  CONVERSIONS_PAGE_SIZE,
  CONVERSION_TRACKING_KEY_LABEL_MAX_CODE_POINTS,
  conversionCurlSnippet,
  conversionTrackingKeyLabelError,
  fmtConversionAmount,
  keyPrefixDisplay,
  nextConversionsCursor,
  trackingKeyState,
} from "../pages/track-conversions";

function row(partial: Partial<ConversionRow> = {}): ConversionRow {
  return {
    id: 1,
    tenant_id: "t1",
    event_name: "purchase",
    properties: {},
    occurred_at: "2026-06-10T12:00:00Z",
    ...partial,
  };
}

function key(
  partial: Partial<ConversionTrackingKey> = {},
): ConversionTrackingKey {
  return {
    id: "k1",
    tenant_id: "t1",
    label: "Site",
    prefix: "pwck_ab12",
    created_at: "2026-06-01T00:00:00Z",
    ...partial,
  };
}

describe("nextConversionsCursor", () => {
  it("returns the oldest row's occurred_at and ID on a full page", () => {
    const page = Array.from({ length: CONVERSIONS_PAGE_SIZE }, (_, i) =>
      row({
        id: i + 1,
        occurred_at: `2026-06-${String(10 - (i % 9)).padStart(2, "0")}T00:00:00Z`,
      }),
    );
    page[page.length - 1] = row({
      id: 17,
      occurred_at: "2026-05-01T00:00:00Z",
    });
    expect(nextConversionsCursor(page)).toEqual({
      before: "2026-05-01T00:00:00Z",
      beforeId: 17,
    });
  });

  it("returns null when the page is short (no more pages)", () => {
    expect(nextConversionsCursor([row()])).toBeNull();
    expect(nextConversionsCursor([])).toBeNull();
  });

  it("returns null for a non-array body without throwing (defensive)", () => {
    // The section normalises the bare-array wire to [] before calling
    // this, but a non-array slipping through must degrade to "no cursor"
    // rather than crash the feed.
    expect(
      nextConversionsCursor(
        {} as unknown as Parameters<typeof nextConversionsCursor>[0],
      ),
    ).toBeNull();
    expect(
      nextConversionsCursor(
        undefined as unknown as Parameters<typeof nextConversionsCursor>[0],
      ),
    ).toBeNull();
  });

  it("fails closed when a full page has no safe positive ID boundary", () => {
    const page = Array.from({ length: CONVERSIONS_PAGE_SIZE }, (_, index) =>
      row({ id: index + 1 }),
    );
    page[page.length - 1] = row({ id: 0 });
    expect(nextConversionsCursor(page)).toBeNull();
  });
});

describe("conversionTrackingKeyLabelError", () => {
  it("counts Unicode code points rather than UTF-16 code units", () => {
    const boundary = "🛰️".repeat(
      Math.floor(CONVERSION_TRACKING_KEY_LABEL_MAX_CODE_POINTS / 2),
    );
    expect(Array.from(boundary)).toHaveLength(
      CONVERSION_TRACKING_KEY_LABEL_MAX_CODE_POINTS,
    );
    expect(conversionTrackingKeyLabelError(`  ${boundary}  `)).toBeNull();
    expect(conversionTrackingKeyLabelError(`${boundary}a`)).toContain(
      "120 characters maximum",
    );
  });

  it("rejects C0, C1, and DEL Unicode control characters", () => {
    for (const label of [
      "checkout\u0000backend",
      "checkout\u0085backend",
      "checkout\u007fbackend",
    ]) {
      expect(conversionTrackingKeyLabelError(label)).toContain(
        "without control characters",
      );
    }
  });
});

describe("fmtConversionAmount", () => {
  it("formats cents in the row currency", () => {
    expect(fmtConversionAmount(4900, "USD")).toMatch(/49/);
  });

  it("renders em-dash for missing amounts, not $0.00", () => {
    expect(fmtConversionAmount(null, "USD")).toBe("—");
    expect(fmtConversionAmount(undefined, "USD")).toBe("—");
  });

  it("falls back to a raw render for unknown currency codes", () => {
    expect(fmtConversionAmount(1250, "NOTREAL")).toBe("12.50 NOTREAL");
  });
});

describe("trackingKeyState / keyPrefixDisplay", () => {
  it("flags active vs revoked", () => {
    expect(trackingKeyState(key())).toEqual({
      label: "Active",
      tone: "success",
    });
    expect(
      trackingKeyState(key({ revoked_at: "2026-06-09T00:00:00Z" })),
    ).toEqual({
      label: "Revoked",
      tone: "neutral",
    });
  });

  it("shows the stored prefix with ellipsis", () => {
    expect(keyPrefixDisplay(key())).toBe("pwck_ab12…");
    expect(keyPrefixDisplay(key({ prefix: "" }))).toBe("—");
  });
});

describe("conversionCurlSnippet", () => {
  it("targets the PUBLIC ingest route with tracking-key auth", () => {
    const s = conversionCurlSnippet("https://api.example.com/");
    expect(s).toContain("https://api.example.com/api/public/track/conversion");
    expect(s).not.toContain("/api/v1/conversions"); // read API ≠ ingest API
    expect(s).toContain("Authorization: Bearer <tracking-key>");
    expect(s).toContain('"event_name"');
    expect(s).toContain('"amount_cents"');
    expect(s).toContain("Publishable telemetry example — not signed ingest");
    expect(s).not.toContain('"email"');
    expect(s).toContain("Browser JSON requires an API-allowed CORS origin.");
  });

  it("substitutes a real key prefix hint when given", () => {
    const s = conversionCurlSnippet("https://api.example.com", "pwck_ab12…");
    expect(s).toContain("Active key prefix (not a credential): pwck_ab12…");
    expect(s).toContain("Bearer <tracking-key>");
    expect(s).not.toContain("Bearer pwck_ab12…");
  });

  it("does not interpolate untrusted shell fragments", () => {
    const s = conversionCurlSnippet(
      "https://api.example.com/'$(touch injected)",
      "bad\n$(touch injected)",
    );
    expect(s).not.toContain("Active key prefix");
    expect(s).not.toContain("'$(touch injected)");
    expect(s).toContain("'\"'\"'");
  });
});
