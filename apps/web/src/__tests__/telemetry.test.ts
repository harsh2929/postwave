import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getOptOut, locationIsSensitive, setOptOut } from "../lib/telemetry";

describe("web telemetry consent parsing", () => {
  const storage = new Map<string, string>();

  beforeEach(() => {
    storage.clear();
    const localStorage = {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
      clear: () => storage.clear(),
      key: (index: number) => Array.from(storage.keys())[index] ?? null,
      get length() {
        return storage.size;
      },
    };
    vi.stubGlobal("window", { localStorage });
  });

  afterEach(() => {
    storage.clear();
    vi.unstubAllGlobals();
  });

  it("honors explicit telemetry opt-out", () => {
    setOptOut(true);

    expect(getOptOut()).toBe(true);
  });

  it("honors cookie-banner analytics rejection", () => {
    storage.set(
      "moosewave.cookie.consent.v1",
      JSON.stringify({
        prefs: { essential: true, analytics: false, marketing: false },
      }),
    );

    expect(getOptOut()).toBe(true);
  });

  it("fails closed and removes oversized cookie preference blobs", () => {
    storage.set("moosewave.cookie.consent.v1", "x".repeat(5 * 1024));

    expect(getOptOut()).toBe(true);
    expect(storage.has("moosewave.cookie.consent.v1")).toBe(false);
  });
});

// web-telemetry-gate-path-only: the signed email auth-link contract
// (src/lib/auth-link.ts) puts token/sig/aud/flow in the QUERY string, and
// redactPath only ever inspects path segments. Without a query check,
// posthog-js is initialized — and persists $initial_current_url — while
// window.location.href still holds a bearer token.
describe("telemetry sensitivity gate", () => {
  it("treats an auth-link query as sensitive even on an ordinary path", () => {
    expect(locationIsSensitive("/accept-invite")).toBe(false);
    expect(locationIsSensitive("/accept-invite", "?token=abc123")).toBe(true);
    expect(
      locationIsSensitive("/magic-link", "?token=abc&v=1&flow=login&sig=xyz"),
    ).toBe(true);
    expect(locationIsSensitive("/reset-password", "?sig=xyz")).toBe(true);
    expect(locationIsSensitive("/en/login", "?aud=web")).toBe(true);
  });

  it("still honors the path redaction table", () => {
    // A path the shared redactor rewrites stays sensitive with no query.
    expect(
      locationIsSensitive(
        "/app/subscribers/00000000-0000-4000-8000-000000000000",
      ),
    ).toBe(true);
  });

  it("leaves ordinary navigation capturable", () => {
    expect(locationIsSensitive("/pricing")).toBe(false);
    expect(locationIsSensitive("/docs/getting-started", "?q=send")).toBe(false);
    expect(locationIsSensitive("", "")).toBe(false);
  });
});
