// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  init: vi.fn(),
  capture: vi.fn(),
  identify: vi.fn(),
  reset: vi.fn(),
  optIn: vi.fn(),
  optOut: vi.fn(),
  hasOptedOut: vi.fn(() => false),
}));

vi.mock("posthog-js", () => ({
  default: {
    init: mocks.init,
    capture: mocks.capture,
    identify: mocks.identify,
    reset: mocks.reset,
    opt_in_capturing: mocks.optIn,
    opt_out_capturing: mocks.optOut,
    has_opted_out_capturing: mocks.hasOptedOut,
  },
}));

const consentKey = "moosewave.cookie.consent.v1";

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.stubEnv("NEXT_PUBLIC_POSTHOG_KEY", "phc_test");
  window.localStorage.clear();
  window.localStorage.setItem(
    consentKey,
    JSON.stringify({
      prefs: { essential: true, analytics: true, marketing: false },
      ts: new Date().toISOString(),
    }),
  );
});

afterEach(() => {
  vi.unstubAllEnvs();
  window.localStorage.clear();
});

describe("PostHog sensitive-path containment", () => {
  it("does not initialize or capture on a hosted preference capability path", async () => {
    const token =
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    window.history.replaceState({}, "", `/en/preferences/${token}`);
    const telemetry = await import("@/lib/telemetry");

    await telemetry.init();
    telemetry.track("page_viewed", { path: "/redacted" });
    telemetry.identify("opaque-user");

    expect(mocks.init).not.toHaveBeenCalled();
    expect(mocks.optIn).not.toHaveBeenCalled();
    expect(mocks.capture).not.toHaveBeenCalled();
    expect(mocks.identify).not.toHaveBeenCalled();
  });

  it("still initializes and captures on a normal consented route", async () => {
    window.history.replaceState({}, "", "/pricing");
    const telemetry = await import("@/lib/telemetry");

    await telemetry.init();
    telemetry.track("page_viewed", { path: "/pricing" });

    expect(mocks.init).toHaveBeenCalledTimes(1);
    expect(mocks.optIn).toHaveBeenCalledTimes(1);
    expect(mocks.capture).toHaveBeenCalledWith("page_viewed", {
      path: "/pricing",
    });
  });

  it("drops SDK-originated events after an SPA navigation onto a capability route", async () => {
    window.history.replaceState({}, "", "/pricing");
    const telemetry = await import("@/lib/telemetry");
    await telemetry.init();

    const options = mocks.init.mock.calls[0]?.[1] as
      | {
          before_send?: (event: unknown) => unknown | null;
          capture_exceptions?: boolean;
          disable_surveys?: boolean;
          disable_surveys_automatic_display?: boolean;
          disable_external_dependency_loading?: boolean;
        }
      | undefined;
    expect(options?.capture_exceptions).toBe(false);
    expect(options?.disable_surveys).toBe(true);
    expect(options?.disable_surveys_automatic_display).toBe(true);
    expect(options?.disable_external_dependency_loading).toBe(true);
    expect(options?.before_send?.({ event: "normal" })).toEqual({
      event: "normal",
    });

    const token =
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    window.history.replaceState({}, "", `/en/preferences/${token}`);
    expect(
      options?.before_send?.({
        event: "sdk-originated",
        properties: { $current_url: window.location.href },
      }),
    ).toBeNull();
  });
});
