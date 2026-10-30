import { EVENTS } from "@postwave/telemetry";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { standInForPostHog } from "../../__tests__/mocks/posthogStandIn";

/** Stand-in for the SecureStoreAccessible enum member the app must ask for. */
const DEVICE_ONLY = "mock-when-unlocked-this-device-only";
const secureStore = vi.hoisted(() => ({
  getItemAsync:
    vi.fn<(key: string, options?: unknown) => Promise<string | null>>(),
  setItemAsync:
    vi.fn<(key: string, value: string, options?: unknown) => Promise<void>>(),
  deleteItemAsync:
    vi.fn<(key: string, options?: unknown) => Promise<void>>(),
}));

vi.mock("expo-secure-store", () => ({
  getItemAsync: secureStore.getItemAsync,
  setItemAsync: secureStore.setItemAsync,
  deleteItemAsync: secureStore.deleteItemAsync,
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: "mock-when-unlocked-this-device-only",
}));

// eslint-disable-next-line import/first
import { sanitizeTelemetryProperties } from "./telemetry";

describe("mobile telemetry property policy", () => {
  it("retains only bounded structural release-health fields", () => {
    expect(
      sanitizeTelemetryProperties({
        outcome: "failure",
        duration_ms: 1250,
        status_code: 503,
        error_code: "network_timeout",
        customer_email: "reader@example.com",
        response: { private: "body" },
      }),
    ).toEqual({
      outcome: "failure",
      duration_ms: 1250,
      status_code: 503,
      error_code: "network_timeout",
    });
  });

  it("drops PII, secrets, unbounded strings, nested values, and huge numbers", () => {
    const serialized = JSON.stringify(
      sanitizeTelemetryProperties({
        method: "reader@example.com",
        source: "x".repeat(65),
        error_code: "token=super-secret",
        unknown: "safe-looking-but-not-contracted",
        duration_ms: Number.POSITIVE_INFINITY,
        status_code: 1_000_000_001,
        platform: ["mobile"],
      }),
    );
    expect(serialized).toBeUndefined();
  });

  it("preserves the typed onboarding scalar contract", () => {
    expect(
      sanitizeTelemetryProperties({
        platform: "mobile",
        tourId: "first_run",
        stepId: "dashboard.welcome",
        index: 2,
        trigger: "manual",
      }),
    ).toEqual({
      platform: "mobile",
      tourId: "first_run",
      stepId: "dashboard.welcome",
      index: 2,
      trigger: "manual",
    });
  });
});

describe("dropped-property developer signal (NATIVE#57)", () => {
  it("names every key it dropped as unknown to the contract", () => {
    const dropped: string[][] = [];
    sanitizeTelemetryProperties(
      { outcome: "success", customer_email: "a@b.c", response: {} },
      (keys) => dropped.push(keys),
    );
    expect(dropped).toEqual([["customer_email", "response"]]);
  });

  it("also names a contracted key whose VALUE was rejected", () => {
    const dropped: string[][] = [];
    sanitizeTelemetryProperties(
      { duration_ms: Number.POSITIVE_INFINITY, source: "x".repeat(65) },
      (keys) => dropped.push(keys),
    );
    expect(dropped).toEqual([["duration_ms", "source"]]);
  });

  it("stays quiet when everything is on the contract", () => {
    const dropped: string[][] = [];
    sanitizeTelemetryProperties(
      { outcome: "success", duration_ms: 12 },
      (keys) => dropped.push(keys),
    );
    expect(dropped).toEqual([]);
  });
});

describe("dashboard event properties survive the allowlist", () => {
  it("keeps the window enum, the tile key and the failure taxonomy", () => {
    // DASHBOARD#82: an event whose properties are silently dropped by the
    // allowlist is worse than no event — it looks instrumented and answers
    // nothing. Every property the dashboard sends is asserted here.
    expect(
      sanitizeTelemetryProperties({ range: "30d", metric: "bounce-rate" }),
    ).toEqual({ range: "30d", metric: "bounce-rate" });
    expect(
      sanitizeTelemetryProperties({ outcome: "blocked", range: "7d" }),
    ).toEqual({ outcome: "blocked", range: "7d" });
    expect(
      sanitizeTelemetryProperties({
        kind: "restricted",
        status_code: 403,
        range: "90d",
      }),
    ).toEqual({ kind: "restricted", status_code: 403, range: "90d" });
  });

  it("still refuses a workspace FIGURE dressed as a dashboard property", () => {
    // The counts on the screen are customer data. Only the shape of the
    // interaction leaves the device.
    expect(
      sanitizeTelemetryProperties({
        range: "30d",
        subscribers_total: 12_480,
        workspace: "Acme Inc",
      }),
    ).toEqual({ range: "30d" });
  });
});

describe("native + commerce cluster payloads survive the allowlist", () => {
  it("keeps the exact {kind, outcome} shape the new emitters send", () => {
    // NATIVE#56 / COMMERCE#58 added mobile.widget_state,
    // mobile.permission_outcome and mobile.commerce_action. Every one of them
    // carries only these two keys — and the sanitizer drops unknown keys in
    // TOTAL silence in production, so a taxonomy that does not round-trip here
    // would ship as events with no properties at all.
    for (const payload of [
      { kind: "widget", outcome: "published" },
      { kind: "widget", outcome: "write_refused" },
      { kind: "notifications", outcome: "already_granted" },
      { kind: "notifications", outcome: "denied" },
      { kind: "camera", outcome: "granted" },
      { kind: "billing_portal", outcome: "refused" },
      { kind: "integration_manage", outcome: "failure" },
      { kind: "scan_code", outcome: "unrecognized" },
    ]) {
      expect(sanitizeTelemetryProperties(payload)).toEqual(payload);
    }
  });

  it("still refuses a scanned payload or a connector name smuggled in", () => {
    expect(
      sanitizeTelemetryProperties({
        kind: "scan_code",
        outcome: "success",
        // The whole point of the scanner event is that this never leaves.
        payload: "moosewave://subscriber/abc",
        connector: "Acme Slack workspace",
      }),
    ).toEqual({ kind: "scan_code", outcome: "success" });
  });
});

describe("where the telemetry consent decision is kept", () => {
  const SS_OPTOUT = "postwave_telemetry_optout";
  /** The class an item gets when the write names none: backup-eligible. */
  const LEGACY_CLASS = "mock-default-backup-eligible";

  /**
   * The keychain outlives the process, so it lives outside the module: a fresh
   * import stands in for a relaunch, and this map for what survives it. It
   * keeps the two native rules the upgrade depends on (expo-secure-store,
   * SecureStoreModule.swift): an item's class is fixed when the item is ADDED,
   * and a write to an item that already exists changes its value alone. Reads
   * do not match on the class.
   */
  const keychain = new Map<string, { value: string; accessible: unknown }>();

  function classNamedBy(options: unknown): unknown {
    const named = (options as { keychainAccessible?: unknown } | undefined)
      ?.keychainAccessible;
    return named ?? LEGACY_CLASS;
  }

  /** A fresh module per case: each import is a new launch of the app. */
  async function freshTelemetry() {
    vi.resetModules();
    return import("./telemetry");
  }

  /** Forget the calls a previous launch made; the keychain itself is kept. */
  function forgetKeychainCalls() {
    secureStore.getItemAsync.mockClear();
    secureStore.setItemAsync.mockClear();
    secureStore.deleteItemAsync.mockClear();
  }

  /**
   * Holds the next keychain write until released: the migration's re-add,
   * caught after its delete has already landed.
   */
  function holdNextWrite() {
    let open: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const write = secureStore.setItemAsync.getMockImplementation();
    const held = { reached: false, release: () => open() };
    secureStore.setItemAsync.mockImplementationOnce(
      async (key, value, options) => {
        held.reached = true;
        await gate;
        await write?.(key, value, options);
      },
    );
    return held;
  }

  /**
   * Holds the next keychain read until released. The value is taken when the
   * read is made, as the serial native queue would run it, and handed back
   * only on release.
   */
  function holdNextRead() {
    let open: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const held = { reached: false, release: () => open() };
    secureStore.getItemAsync.mockImplementationOnce(async (key) => {
      held.reached = true;
      const value = keychain.get(key)?.value ?? null;
      await gate;
      return value;
    });
    return held;
  }

  beforeEach(() => {
    keychain.clear();
    secureStore.getItemAsync
      .mockReset()
      .mockImplementation(async (key) => keychain.get(key)?.value ?? null);
    secureStore.setItemAsync
      .mockReset()
      .mockImplementation(async (key, value, options) => {
        const existing = keychain.get(key);
        keychain.set(key, {
          value,
          accessible: existing ? existing.accessible : classNamedBy(options),
        });
      });
    secureStore.deleteItemAsync
      .mockReset()
      .mockImplementation(async (key) => {
        keychain.delete(key);
      });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("writes the decision under the device-only class, like every other item", async () => {
    // Without this the consent record rides an encrypted backup onto a second
    // handset, applying a decision its owner never made there.
    const telemetry = await freshTelemetry();
    await telemetry.setOptOut(false);
    expect(secureStore.setItemAsync).toHaveBeenCalledWith(SS_OPTOUT, "v2:0", {
      keychainAccessible: DEVICE_ONLY,
    });
    expect(keychain.get(SS_OPTOUT)).toEqual({
      value: "v2:0",
      accessible: DEVICE_ONLY,
    });
  });

  it("reads it back with the same options", async () => {
    keychain.set(SS_OPTOUT, { value: "v2:0", accessible: DEVICE_ONLY });
    const telemetry = await freshTelemetry();
    expect(await telemetry.getOptOut()).toBe(false);
    expect(secureStore.getItemAsync).toHaveBeenCalledWith(SS_OPTOUT, {
      keychainAccessible: DEVICE_ONLY,
    });
  });

  it("does not rewrite an item this build already wrote on a later launch", async () => {
    // SEC-4: the rewrite used to hang off a per-process flag, so every launch
    // with a stored decision paid a delete and a write on the consent read
    // that gates PostHog and Sentry at boot — and reopened the window in which
    // a kill between the two erases a recorded opt-in.
    const firstLaunch = await freshTelemetry();
    expect(await firstLaunch.setOptOut(false)).toBe(true);
    forgetKeychainCalls();

    const nextLaunch = await freshTelemetry();
    expect(await nextLaunch.getOptOut()).toBe(false);
    expect(secureStore.deleteItemAsync).not.toHaveBeenCalled();
    expect(secureStore.setItemAsync).not.toHaveBeenCalled();
    expect(keychain.get(SS_OPTOUT)).toEqual({
      value: "v2:0",
      accessible: DEVICE_ONLY,
    });
  });

  it("upgrades an item a previous build wrote under the old class", async () => {
    // The class is fixed at write time, so an existing opt-in stays
    // backup-eligible until the value is written again. "0" is what a build
    // before the device-only class wrote for a grant.
    keychain.set(SS_OPTOUT, { value: "0", accessible: LEGACY_CLASS });
    const telemetry = await freshTelemetry();

    expect(await telemetry.getOptOut()).toBe(false);
    expect(secureStore.setItemAsync).toHaveBeenCalledWith(SS_OPTOUT, "v2:0", {
      keychainAccessible: DEVICE_ONLY,
    });
    expect(keychain.get(SS_OPTOUT)).toEqual({
      value: "v2:0",
      accessible: DEVICE_ONLY,
    });
    // IT MUST DELETE FIRST, and this assertion is the whole point of the test.
    // expo-secure-store applies kSecAttrAccessible only on the SecItemAdd
    // path; for an item that already exists it falls through to SecItemUpdate
    // with kSecValueData alone, so a bare re-write leaves the OLD class in
    // place. Asserting only that setItemAsync was called passes against that
    // no-op — which is exactly how this shipped looking fixed.
    expect(secureStore.deleteItemAsync).toHaveBeenCalledWith(SS_OPTOUT, {
      keychainAccessible: DEVICE_ONLY,
    });
    const deletedAt = secureStore.deleteItemAsync.mock.invocationCallOrder[0];
    const wroteAt = secureStore.setItemAsync.mock.invocationCallOrder[0];
    expect(deletedAt).toBeDefined();
    expect(wroteAt).toBeDefined();
    expect(deletedAt as number).toBeLessThan(wroteAt as number);

    // A one-time migration: the next launch finds an item this build wrote,
    // under this class, and leaves it alone.
    forgetKeychainCalls();
    const nextLaunch = await freshTelemetry();
    expect(await nextLaunch.getOptOut()).toBe(false);
    expect(secureStore.deleteItemAsync).not.toHaveBeenCalled();
    expect(secureStore.setItemAsync).not.toHaveBeenCalled();
  });

  it("carries a legacy withdrawal across the upgrade as a withdrawal", async () => {
    keychain.set(SS_OPTOUT, { value: "1", accessible: LEGACY_CLASS });
    const telemetry = await freshTelemetry();
    expect(await telemetry.getOptOut()).toBe(true);
    expect(keychain.get(SS_OPTOUT)).toEqual({
      value: "v2:1",
      accessible: DEVICE_ONLY,
    });
  });

  it("brings a legacy item under the device-only class before it records a new decision", async () => {
    // The first thing this launch does is change the decision, with no read
    // before it. A plain write to the existing item takes SecItemUpdate and
    // keeps the OLD class — and a value tagged as this build's would then hide
    // that item from the one-time migration for good.
    keychain.set(SS_OPTOUT, { value: "0", accessible: LEGACY_CLASS });
    const telemetry = await freshTelemetry();

    expect(await telemetry.setOptOut(true)).toBe(true);
    expect(keychain.get(SS_OPTOUT)).toEqual({
      value: "v2:1",
      accessible: DEVICE_ONLY,
    });
    expect(await telemetry.getOptOut()).toBe(true);
  });

  it("leaves a decision a later build wrote where it found it", async () => {
    // Read as a withdrawal, like anything this build cannot parse as a grant,
    // but not rewritten. Only an untagged item is a legacy build's. Replacing a
    // newer build's record after a downgrade would hand the re-upgraded build a
    // decision it never wrote.
    keychain.set(SS_OPTOUT, { value: "v3:0", accessible: DEVICE_ONLY });
    const telemetry = await freshTelemetry();
    expect(await telemetry.getOptOut()).toBe(true);
    expect(secureStore.deleteItemAsync).not.toHaveBeenCalled();
    expect(secureStore.setItemAsync).not.toHaveBeenCalled();
    expect(keychain.get(SS_OPTOUT)).toEqual({
      value: "v3:0",
      accessible: DEVICE_ONLY,
    });
  });

  it("keeps a launch reader off the item while the one-time migration has it deleted", async () => {
    // Two readers run at launch: Sentry's consent check (app/_layout.tsx) and
    // init() (useAppBootstrap). A read that lands between the migration's
    // delete and its re-add finds no record, and that system stays off for the
    // launch although a grant is recorded.
    vi.stubEnv("EXPO_PUBLIC_POSTHOG_KEY", "phc_test_key");
    const posthog = standInForPostHog();
    try {
      keychain.set(SS_OPTOUT, { value: "0", accessible: LEGACY_CLASS });
      const reAdd = holdNextWrite();
      const telemetry = await freshTelemetry();
      const sentryRead = telemetry.getOptOut();
      await vi.waitFor(() => expect(reAdd.reached).toBe(true));
      expect(keychain.has(SS_OPTOUT)).toBe(false); // deleted, not yet re-added

      const posthogInit = telemetry.init();
      await new Promise((resolve) => setTimeout(resolve, 0));
      reAdd.release();

      expect(await sentryRead).toBe(false);
      await posthogInit;
      expect(telemetry.isEnabled()).toBe(true);
      expect(posthog.constructed).toHaveLength(1);
      expect(keychain.get(SS_OPTOUT)).toEqual({
        value: "v2:0",
        accessible: DEVICE_ONLY,
      });
    } finally {
      posthog.release();
    }
  });

  it("migrates once however many launch readers find the legacy item", async () => {
    keychain.set(SS_OPTOUT, { value: "0", accessible: LEGACY_CLASS });
    const telemetry = await freshTelemetry();
    expect(
      await Promise.all([telemetry.getOptOut(), telemetry.getOptOut()]),
    ).toEqual([false, false]);
    expect(secureStore.deleteItemAsync).toHaveBeenCalledTimes(1);
    expect(secureStore.setItemAsync).toHaveBeenCalledTimes(1);
    expect(keychain.get(SS_OPTOUT)).toEqual({
      value: "v2:0",
      accessible: DEVICE_ONLY,
    });
  });

  it("reads only an explicit grant as consent", async () => {
    // Anything but this build's grant or a legacy build's — including a format
    // a LATER build wrote, read after a downgrade — fails towards not sending.
    const cases: [stored: string, optedOut: boolean][] = [
      ["v2:0", false],
      ["0", false],
      ["v2:1", true],
      ["1", true],
      ["v2:", true],
      ["v3:0", true],
      ["", true],
    ];
    const seen: [string, boolean][] = [];
    for (const [stored] of cases) {
      keychain.clear();
      keychain.set(SS_OPTOUT, { value: stored, accessible: DEVICE_ONLY });
      const telemetry = await freshTelemetry();
      seen.push([stored, await telemetry.getOptOut()]);
    }
    expect(seen).toEqual(cases);
  });

  it("treats an item it cannot read as no decision rather than crashing", async () => {
    // A locked keychain surfaces as a throw, not as null. (A different
    // accessibility class does not: reads never match on the class, so an item
    // a previous build wrote reads back normally — see the upgrade cases
    // above.) Consent that cannot be read is not consent.
    const telemetry = await freshTelemetry();
    secureStore.getItemAsync.mockRejectedValue(new Error("item not found"));
    await expect(telemetry.getOptOut()).resolves.toBe(true);
  });

  it("does not apply a consent grant it could not persist", async () => {
    // CQ-15, before any client exists. The switch reverts when setOptOut
    // returns false, so no client may be built either: building one is itself
    // a disclosure (an install id and a phone-home), here under a switch the
    // user can see is OFF.
    vi.stubEnv("EXPO_PUBLIC_POSTHOG_KEY", "phc_test_key");
    const posthog = standInForPostHog();
    try {
      keychain.set(SS_OPTOUT, { value: "v2:1", accessible: DEVICE_ONLY });
      const telemetry = await freshTelemetry();
      await telemetry.init(); // the launch: a recorded decline builds nothing
      secureStore.setItemAsync.mockRejectedValue(new Error("keychain locked"));

      expect(await telemetry.setOptOut(false)).toBe(false);
      expect(telemetry.isEnabled()).toBe(false);
      expect(posthog.constructed).toEqual([]);
      expect(keychain.get(SS_OPTOUT)?.value).toBe("v2:1");
    } finally {
      posthog.release();
    }
  });

  it("does not turn a client built this session back on for a grant it could not persist", async () => {
    // CQ-15 with a client already built, a path the case above never reaches:
    // setOptOut does not call init() when a client exists. Launch with
    // consent, withdraw (recorded), then grant again while the keychain
    // refuses the write. The false return flips the switch back to OFF
    // (settings.tsx), and PostHog has to stay off with it.
    vi.stubEnv("EXPO_PUBLIC_POSTHOG_KEY", "phc_test_key");
    const posthog = standInForPostHog();
    try {
      keychain.set(SS_OPTOUT, { value: "v2:0", accessible: DEVICE_ONLY });
      const telemetry = await freshTelemetry();
      await telemetry.init();
      expect(await telemetry.setOptOut(true)).toBe(true);
      expect(posthog.calls).toEqual(["optIn", "optOut"]);
      secureStore.setItemAsync.mockRejectedValue(new Error("keychain locked"));

      expect(await telemetry.setOptOut(false)).toBe(false);
      telemetry.track(EVENTS.MOBILE_TAB_VIEWED, { tab: "dashboard" });

      expect(telemetry.isEnabled()).toBe(false);
      // No optIn and no capture: the client is left where the withdrawal put
      // it, and told so again.
      expect(posthog.calls).toEqual(["optIn", "optOut", "optOut"]);
      expect(posthog.constructed).toHaveLength(1);
      expect(keychain.get(SS_OPTOUT)?.value).toBe("v2:1");
    } finally {
      posthog.release();
    }
  });

  it("lets the later of two quick decisions settle the session", async () => {
    // Switch ON, then straight OFF: the withdrawal is made before the grant's
    // write has come back. The withdrawal is the user's last word and holds
    // from the moment it is made. The grant it overtook lands first, and must
    // not turn anything back on when it does.
    vi.stubEnv("EXPO_PUBLIC_POSTHOG_KEY", "phc_test_key");
    const posthog = standInForPostHog();
    try {
      keychain.set(SS_OPTOUT, { value: "v2:0", accessible: DEVICE_ONLY });
      const telemetry = await freshTelemetry();
      await telemetry.init();
      expect(await telemetry.setOptOut(true)).toBe(true);
      const write = secureStore.setItemAsync.getMockImplementation();
      if (write) secureStore.setItemAsync.mockImplementationOnce(write);
      const withdrawalWrite = holdNextWrite();

      const grant = telemetry.setOptOut(false);
      const withdrawal = telemetry.setOptOut(true);
      expect(await grant).toBe(true);
      telemetry.track(EVENTS.MOBILE_TAB_VIEWED, { tab: "dashboard" });
      expect(telemetry.isEnabled()).toBe(false);
      withdrawalWrite.release();
      expect(await withdrawal).toBe(true);

      expect(telemetry.isEnabled()).toBe(false);
      expect(posthog.calls).toEqual(["optIn", "optOut", "optOut"]);
      expect(keychain.get(SS_OPTOUT)?.value).toBe("v2:1");
    } finally {
      posthog.release();
    }
  });

  it("lets a withdrawal made while the grant's init() reads the record settle the session", async () => {
    // The same two quick decisions with no client built yet: the grant is
    // recorded and its init() is reading that grant back when the switch goes
    // OFF. The read lands after the withdrawal and must not overwrite it.
    vi.stubEnv("EXPO_PUBLIC_POSTHOG_KEY", "phc_test_key");
    const posthog = standInForPostHog();
    try {
      keychain.set(SS_OPTOUT, { value: "v2:1", accessible: DEVICE_ONLY });
      const telemetry = await freshTelemetry();
      await telemetry.init(); // the launch: a recorded decline builds nothing
      const grantWrite = holdNextWrite();
      const grant = telemetry.setOptOut(false);
      await vi.waitFor(() => expect(grantWrite.reached).toBe(true));
      const initRead = holdNextRead();
      grantWrite.release();
      await vi.waitFor(() => expect(initRead.reached).toBe(true));

      const withdrawalWrite = holdNextWrite();
      const withdrawal = telemetry.setOptOut(true);
      await vi.waitFor(() => expect(withdrawalWrite.reached).toBe(true));
      initRead.release(); // hands back the grant it found: "v2:0"
      expect(await grant).toBe(true);
      telemetry.track(EVENTS.MOBILE_TAB_VIEWED, { tab: "dashboard" });
      expect(telemetry.isEnabled()).toBe(false);
      expect(posthog.constructed).toEqual([]);

      withdrawalWrite.release();
      expect(await withdrawal).toBe(true);
      expect(telemetry.isEnabled()).toBe(false);
      expect(posthog.constructed).toEqual([]);
      expect(posthog.calls).toEqual([]);
      expect(keychain.get(SS_OPTOUT)?.value).toBe("v2:1");
    } finally {
      posthog.release();
    }
  });

  it("builds no client when the withdrawal lands while PostHog is loading", async () => {
    // Past the read, the grant's init() is waiting on the package import when
    // the switch goes OFF. Building the client then is the disclosure that
    // CONSENT GATES CONSTRUCTION exists to prevent.
    vi.stubEnv("EXPO_PUBLIC_POSTHOG_KEY", "phc_test_key");
    const posthog = standInForPostHog({ holdImport: true });
    try {
      keychain.set(SS_OPTOUT, { value: "v2:1", accessible: DEVICE_ONLY });
      const telemetry = await freshTelemetry();
      await telemetry.init();
      const grant = telemetry.setOptOut(false);
      await vi.waitFor(() => expect(posthog.heldImport.reached).toBe(true));

      expect(await telemetry.setOptOut(true)).toBe(true);
      posthog.heldImport.release();
      expect(await grant).toBe(true);
      telemetry.track(EVENTS.MOBILE_TAB_VIEWED, { tab: "dashboard" });

      expect(telemetry.isEnabled()).toBe(false);
      expect(posthog.constructed).toEqual([]);
      expect(posthog.calls).toEqual([]);
      expect(keychain.get(SS_OPTOUT)?.value).toBe("v2:1");
    } finally {
      posthog.release();
    }
  });

  it("builds one client when decisions made while PostHog loads end in a grant", async () => {
    // ON, OFF, ON while the first grant's init() waits on the import. The last
    // grant's own init() builds the client; the first must not build another.
    vi.stubEnv("EXPO_PUBLIC_POSTHOG_KEY", "phc_test_key");
    const posthog = standInForPostHog({ holdImport: true });
    try {
      keychain.set(SS_OPTOUT, { value: "v2:1", accessible: DEVICE_ONLY });
      const telemetry = await freshTelemetry();
      await telemetry.init();
      const firstGrant = telemetry.setOptOut(false);
      await vi.waitFor(() => expect(posthog.heldImport.reached).toBe(true));
      expect(await telemetry.setOptOut(true)).toBe(true);
      // The last grant is recorded and its init() is reading it back when the
      // first import lands. (Its own import waits until then: two concurrent
      // imports of a doMock'd module hand the second the real package.)
      const lastGrantWrite = holdNextWrite();
      const lastGrant = telemetry.setOptOut(false);
      await vi.waitFor(() => expect(lastGrantWrite.reached).toBe(true));
      const lastInitRead = holdNextRead();
      lastGrantWrite.release();
      await vi.waitFor(() => expect(lastInitRead.reached).toBe(true));

      posthog.heldImport.release();
      expect(await firstGrant).toBe(true);
      lastInitRead.release();
      expect(await lastGrant).toBe(true);
      expect(posthog.constructed).toHaveLength(1);
      expect(telemetry.isEnabled()).toBe(true);
    } finally {
      posthog.release();
    }
  });

  it("keeps a launch read that lands late from undoing a later withdrawal", async () => {
    // The launch's own read can outlast decisions made after it began: here a
    // grant built the client and a withdrawal switched it off again before
    // that read came back. The grant it found must not switch sending back on.
    vi.stubEnv("EXPO_PUBLIC_POSTHOG_KEY", "phc_test_key");
    const posthog = standInForPostHog();
    try {
      keychain.set(SS_OPTOUT, { value: "v2:0", accessible: DEVICE_ONLY });
      const telemetry = await freshTelemetry();
      const launchRead = holdNextRead();
      const launch = telemetry.init();
      await vi.waitFor(() => expect(launchRead.reached).toBe(true));
      expect(await telemetry.setOptOut(true)).toBe(true);
      expect(await telemetry.setOptOut(false)).toBe(true); // builds the client
      const withdrawalWrite = holdNextWrite();
      const withdrawal = telemetry.setOptOut(true);
      await vi.waitFor(() => expect(withdrawalWrite.reached).toBe(true));

      launchRead.release(); // hands back the grant it found: "v2:0"
      await launch;
      telemetry.track(EVENTS.MOBILE_TAB_VIEWED, { tab: "dashboard" });
      expect(telemetry.isEnabled()).toBe(false);
      withdrawalWrite.release();
      expect(await withdrawal).toBe(true);
      expect(posthog.constructed).toHaveLength(1);
      expect(posthog.calls).toEqual(["optIn", "optOut"]);
    } finally {
      posthog.release();
    }
  });

  it("does not act on a grant before it is recorded", async () => {
    // Until its write comes back a grant can still fail, and a failed grant
    // flips the switch back to OFF. Nothing may be sent in between.
    vi.stubEnv("EXPO_PUBLIC_POSTHOG_KEY", "phc_test_key");
    const posthog = standInForPostHog();
    try {
      keychain.set(SS_OPTOUT, { value: "v2:0", accessible: DEVICE_ONLY });
      const telemetry = await freshTelemetry();
      await telemetry.init();
      expect(await telemetry.setOptOut(true)).toBe(true);
      const grantWrite = holdNextWrite();

      const grant = telemetry.setOptOut(false);
      await vi.waitFor(() => expect(grantWrite.reached).toBe(true));
      telemetry.track(EVENTS.MOBILE_TAB_VIEWED, { tab: "dashboard" });
      expect(telemetry.isEnabled()).toBe(false);
      grantWrite.release();
      expect(await grant).toBe(true);

      expect(telemetry.isEnabled()).toBe(true);
      expect(posthog.calls).toEqual(["optIn", "optOut", "optIn"]);
    } finally {
      posthog.release();
    }
  });

  it("builds the client the moment a grant is persisted", async () => {
    // The control for the case above: the stand-in is reachable, so an empty
    // construction list there means init() declined, not that nothing was
    // wired.
    vi.stubEnv("EXPO_PUBLIC_POSTHOG_KEY", "phc_test_key");
    const posthog = standInForPostHog();
    try {
      keychain.set(SS_OPTOUT, { value: "v2:1", accessible: DEVICE_ONLY });
      const telemetry = await freshTelemetry();
      await telemetry.init();
      expect(posthog.constructed).toEqual([]);

      expect(await telemetry.setOptOut(false)).toBe(true);
      expect(telemetry.isEnabled()).toBe(true);
      expect(posthog.constructed.map((c) => c.key)).toEqual(["phc_test_key"]);
    } finally {
      posthog.release();
    }
  });

  it("never re-writes an item that was never set", async () => {
    const telemetry = await freshTelemetry();
    expect(await telemetry.getOptOut()).toBe(true);
    expect(secureStore.setItemAsync).not.toHaveBeenCalled();
  });
});
