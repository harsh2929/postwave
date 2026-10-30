// SPDX-License-Identifier: AGPL-3.0-only
//
// Guards the two telemetry audit fixes the web app adopted from
// @postwave/telemetry:
//
//   1. Consent defaults to DENIED (opt-IN model) — web previously captured
//      by default before the user had decided. We assert the package's
//      default + gate, and that the web telemetry module treats an
//      undecided/empty consent store as "not enabled".
//   2. Breadcrumb redaction exists (web was MISSING beforeBreadcrumb) and
//      scrubs secret/PII query params from breadcrumb URLs.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  redactBreadcrumb,
  shouldCapture,
  TELEMETRY_CONSENT_DEFAULT,
} from "@postwave/telemetry";

describe("telemetry consent — opt-IN default", () => {
  it("the shared default is denied (capture off until granted)", () => {
    expect(TELEMETRY_CONSENT_DEFAULT).toBe("denied");
    expect(shouldCapture(TELEMETRY_CONSENT_DEFAULT)).toBe(false);
    expect(shouldCapture("unset")).toBe(false);
    expect(shouldCapture(null)).toBe(false);
    expect(shouldCapture(undefined)).toBe(false);
    expect(shouldCapture("granted")).toBe(true);
  });
});

describe("telemetry breadcrumb redaction (web fix)", () => {
  it("scrubs sensitive query params on breadcrumb URLs", () => {
    const crumb = redactBreadcrumb({
      data: { url: "https://app.postwave.test/x?api_key=pw_secret&page=2" },
    });
    expect(crumb.data?.url).toContain("api_key=%5Bredacted%5D");
    expect(crumb.data?.url).toContain("page=2");
  });

  it("leaves non-sensitive breadcrumb URLs untouched", () => {
    const crumb = redactBreadcrumb({
      data: { url: "https://app.postwave.test/dashboard?tab=overview" },
    });
    expect(crumb.data?.url).toBe(
      "https://app.postwave.test/dashboard?tab=overview",
    );
  });
});

describe("web telemetry module — capture gated by consent", () => {
  const KEY = "moosewave.cookie.consent.v1";
  let store: Record<string, string>;

  beforeEach(() => {
    store = {};
    (globalThis as { window?: unknown }).window = {
      localStorage: {
        getItem: (k: string) => (k in store ? store[k] : null),
        setItem: (k: string, v: string) => {
          store[k] = v;
        },
        removeItem: (k: string) => {
          delete store[k];
        },
      },
    };
  });

  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  it("isEnabled() is false before any consent decision (no opt-IN-by-default)", async () => {
    const mod = await import("../../lib/telemetry");
    // No PostHog client (no NEXT_PUBLIC_POSTHOG_KEY) AND no consent →
    // capture must not be enabled.
    expect(mod.isEnabled()).toBe(false);
    // getOptOut reflects the opt-IN model: undecided ⇒ opted-out.
    expect(mod.getOptOut()).toBe(true);
  });

  it("getOptOut() is true when analytics consent is explicitly false", async () => {
    store[KEY] = JSON.stringify({
      prefs: { essential: true, analytics: false, marketing: false },
    });
    const mod = await import("../../lib/telemetry");
    expect(mod.getOptOut()).toBe(true);
  });

  it("getOptOut() is false only when analytics consent is granted", async () => {
    // `ts` is required for a grant to count: consent now expires after the
    // 13 months /legal/privacy §7 publishes, and a record we cannot date
    // cannot be shown to be inside that window. The rejection fixture above
    // needs no stamp because an undateable record is denied either way.
    store[KEY] = JSON.stringify({
      prefs: { essential: true, analytics: true, marketing: true },
      ts: new Date().toISOString(),
    });
    const mod = await import("../../lib/telemetry");
    expect(mod.getOptOut()).toBe(false);
  });
});
