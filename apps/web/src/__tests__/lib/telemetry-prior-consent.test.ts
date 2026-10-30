// SPDX-License-Identifier: AGPL-3.0-only
//
// ePrivacy Art. 5(3) — PRIOR consent for storage, not just for transmission.
//
// The compliance audit (docs/compliance/us-eu-compliance-audit-2026-09-05.md,
// F-02) found the web app gated PostHog *capture* on consent, carefully and
// correctly, while leaving PostHog *initialisation* ungated. `init()` ran on
// every page load and called `posthog.init(..., { persistence:
// "localStorage+cookie" })` before consulting consent; posthog-js keeps its
// persistence store when opted out (`opt_out_persistence_by_default` defaults
// to false), so a first-time visitor got a `ph_*_posthog` cookie and a
// localStorage entry written before the banner was ever answered.
//
// Art. 5(3) regulates "the storing of information, or the gaining of access to
// information already stored, in the terminal equipment of a subscriber or
// user". The storage IS the regulated act. Whether an event is later
// transmitted is a separate question under a separate regime. Analytics
// identity is not "strictly necessary" for a service the visitor requested, so
// the strictly-necessary carve-out does not reach it.
//
// These tests assert the property the article is about: nothing loads and
// nothing is stored until consent is granted, and a later grant still works
// (the no-consent path must not latch the module as initialised).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CONSENT_STORAGE_KEY } from "@/lib/cookie-consent-record";

/** Calls recorded by the posthog-js mock, shared across a single test. */
interface PostHogSpy {
  initCalls: { key: string; options: Record<string, unknown> }[];
  optIn: number;
  optOut: number;
  optOutArgs: unknown[];
  resetArgs: unknown[];
}

let spy: PostHogSpy;

vi.mock("posthog-js", () => {
  const client = {
    init: (key: string, options: Record<string, unknown>) => {
      spy.initCalls.push({ key, options });
    },
    capture: () => {},
    identify: () => {},
    reset: (...args: unknown[]) => {
      spy.resetArgs.push(args);
    },
    opt_in_capturing: () => {
      spy.optIn += 1;
    },
    opt_out_capturing: (...args: unknown[]) => {
      spy.optOut += 1;
      spy.optOutArgs.push(args);
    },
    has_opted_out_capturing: () => spy.optOut > spy.optIn,
  };
  return { default: client };
});

let store: Record<string, string>;

function fakeWindow(): void {
  (globalThis as { window?: unknown }).window = {
    location: { pathname: "/pricing", search: "" },
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
}

/** A dated, in-window grant — the only shape `readConsent()` accepts. */
function grantAnalytics(): void {
  store[CONSENT_STORAGE_KEY] = JSON.stringify({
    prefs: { essential: true, analytics: true, marketing: false },
    ts: new Date().toISOString(),
  });
}

function refuseAnalytics(): void {
  store[CONSENT_STORAGE_KEY] = JSON.stringify({
    prefs: { essential: true, analytics: false, marketing: false },
    ts: new Date().toISOString(),
  });
}

beforeEach(() => {
  spy = {
    initCalls: [],
    optIn: 0,
    optOut: 0,
    optOutArgs: [],
    resetArgs: [],
  };
  store = {};
  vi.resetModules();
  process.env.NEXT_PUBLIC_POSTHOG_KEY = "phc_test_key";
  fakeWindow();
});

afterEach(() => {
  delete process.env.NEXT_PUBLIC_POSTHOG_KEY;
  delete (globalThis as { window?: unknown }).window;
});

describe("ePrivacy Art. 5(3): no storage before a consent decision", () => {
  it("does not load or initialise PostHog when no decision has been made", async () => {
    const mod = await import("@/lib/telemetry");
    await mod.init();

    // The strong assertion: posthog.init was never called, so no cookie and no
    // localStorage entry can exist. Asserting only `optOut > 0` would pass on
    // the buggy code, which DID opt out — after writing the store.
    expect(spy.initCalls).toHaveLength(0);
    expect(mod.isEnabled()).toBe(false);
  });

  it("does not initialise PostHog when analytics consent is refused", async () => {
    refuseAnalytics();
    const mod = await import("@/lib/telemetry");
    await mod.init();

    expect(spy.initCalls).toHaveLength(0);
    expect(mod.isEnabled()).toBe(false);
  });

  it("initialises and opts in once consent is granted", async () => {
    grantAnalytics();
    const mod = await import("@/lib/telemetry");
    await mod.init();

    expect(spy.initCalls).toHaveLength(1);
    expect(spy.initCalls[0]?.key).toBe("phc_test_key");
    expect(spy.optIn).toBe(1);
    expect(mod.isEnabled()).toBe(true);
  });

  it("still initialises when consent arrives AFTER an ungranted init()", async () => {
    // The regression this guards: an early return that latches `initialized`
    // would make the module permanently inert for any visitor who loaded a
    // page before accepting — i.e. every visitor.
    const mod = await import("@/lib/telemetry");
    await mod.init();
    expect(spy.initCalls).toHaveLength(0);

    grantAnalytics();
    await mod.init();

    expect(spy.initCalls).toHaveLength(1);
    expect(spy.optIn).toBe(1);
    expect(mod.isEnabled()).toBe(true);
  });

  it("clears persistence when consent is withdrawn after a grant", async () => {
    // Withdrawal has to remove what the grant stored. Opting out of *capture*
    // while leaving the identity cookie in place keeps storing information on
    // the visitor's device with no lawful basis.
    grantAnalytics();
    const mod = await import("@/lib/telemetry");
    await mod.init();
    expect(spy.initCalls).toHaveLength(1);

    mod.setOptOut(true);

    expect(spy.optOut).toBeGreaterThan(0);
    expect(spy.optOutArgs.at(-1)).toEqual([{ clear_persistence: true }]);
    expect(mod.isEnabled()).toBe(false);
  });

  it("never initialises on a credential-bearing route even with consent", async () => {
    grantAnalytics();
    (
      globalThis as { window: { location: { pathname: string; search: string } } }
    ).window.location = { pathname: "/magic-link", search: "?token=abc&sig=d" };

    const mod = await import("@/lib/telemetry");
    await mod.init();

    expect(spy.initCalls).toHaveLength(0);
  });
});
