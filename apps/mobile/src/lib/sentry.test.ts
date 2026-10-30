/**
 * The mobile Sentry wiring has TWO breadcrumb producers, and only one of them
 * is reachable from JavaScript.
 *
 * `beforeBreadcrumb`/`beforeSend` are JS-layer hooks. The native iOS SDK also
 * records its own `http` breadcrumb for every URLSession request it swizzles,
 * on the native scope, and ships them with native crash events without ever
 * calling into the JS bridge. (@sentry/react-native even acknowledges this in
 * ios/RNSentryReplayBreadcrumbConverter.m: "Drop native network breadcrumbs to
 * avoid duplicates".) Moosewave URLs carry subscriber identity in the PATH —
 * /subscribers/<email>, /sms/<phoneE164> — so an unscrubbed native breadcrumb
 * is customer PII in a crash report.
 *
 * These tests pin the option that closes that second path, and pin that
 * closing it did not also switch off crash reporting itself — this is the
 * incident-response surface, so a fix that silences it would be worse than
 * the leak.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RedactableBreadcrumb, RedactableEvent } from "./sentryRedact";

const init = vi.fn();

vi.mock("@sentry/react-native", () => ({
  init,
  wrap: <T,>(component: T): T => component,
  captureException: vi.fn(),
}));

/** The subset of init options these tests assert on, incl. the native passthrough. */
type CapturedOptions = Record<string, unknown> & {
  beforeSend?: (event: unknown) => unknown;
  beforeBreadcrumb?: (crumb: unknown) => unknown;
};

async function initWithDsn(): Promise<CapturedOptions> {
  vi.resetModules();
  init.mockClear();
  process.env.EXPO_PUBLIC_SENTRY_DSN_MOBILE = "https://key@example.invalid/1";
  process.env.EXPO_PUBLIC_POSTWAVE_ENV = "test";
  const { initSentry } = await import("./sentry");
  // Consent is now read before the SDK starts, so init is async and takes the
  // reader; these tests supply a granted decision (optOut === false).
  await initSentry(async () => false);
  expect(init).toHaveBeenCalledTimes(1);
  return init.mock.calls[0]?.[0] as CapturedOptions;
}

const savedDsn = process.env.EXPO_PUBLIC_SENTRY_DSN_MOBILE;
const savedEnv = process.env.EXPO_PUBLIC_POSTWAVE_ENV;

beforeEach(() => {
  (globalThis as { __DEV__?: boolean }).__DEV__ = false;
});

afterEach(() => {
  if (savedDsn === undefined) delete process.env.EXPO_PUBLIC_SENTRY_DSN_MOBILE;
  else process.env.EXPO_PUBLIC_SENTRY_DSN_MOBILE = savedDsn;
  if (savedEnv === undefined) delete process.env.EXPO_PUBLIC_POSTWAVE_ENV;
  else process.env.EXPO_PUBLIC_POSTWAVE_ENV = savedEnv;
});

describe("initSentry native breadcrumb containment", () => {
  it("turns off the native SDK's own HTTP breadcrumbs", async () => {
    const options = await initWithDsn();

    // sentry-cocoa's SentryOptions.enableNetworkBreadcrumbs defaults to YES,
    // and the RN bridge forwards unrecognised keys straight into
    // SentryOptionsInternal initWithDict, so this key is the only lever the JS
    // layer has over the native recorder.
    expect(options.enableNetworkBreadcrumbs).toBe(false);
  });

  it("keeps crash reporting itself on while doing so", async () => {
    const options = await initWithDsn();

    // Disabling the native layer wholesale (enableNative / enableNativeCrashHandling)
    // would also stop native breadcrumbs — and stop reporting hard crashes,
    // which is the one class of failure only the native SDK can see.
    expect(options.enableNative).not.toBe(false);
    expect(options.enableNativeCrashHandling).not.toBe(false);
    expect(options.enableAutoSessionTracking).toBe(true);
    expect(typeof options.beforeSend).toBe("function");
    expect(typeof options.beforeBreadcrumb).toBe("function");
  });

  it("leaves the JS breadcrumb path intact and scrubbing PATH identity", async () => {
    const options = await initWithDsn();

    const crumb = options.beforeBreadcrumb?.({
      category: "fetch",
      data: {
        method: "GET",
        url: "https://api.postwave.test/api/v1/subscribers/ada@example.com",
      },
    }) as RedactableBreadcrumb;

    expect(crumb.data?.url).toBe(
      "https://api.postwave.test/api/v1/subscribers/[redacted]",
    );
    expect(crumb.data?.method).toBe("GET");
  });

  it("scrubs identity out of a native-origin breadcrumb merged onto an event", async () => {
    const options = await initWithDsn();

    // deviceContextIntegration concatenates the NATIVE scope's breadcrumbs onto
    // JS events before beforeSend runs (dist/js/integrations/devicecontext.js),
    // so event.breadcrumbs is the one place a native `http` crumb is still
    // catchable from JS. beforeSend must scrub there too — it is the backstop
    // for anything enableNetworkBreadcrumbs:false does not already prevent.
    const event = options.beforeSend?.({
      breadcrumbs: [
        {
          category: "http",
          data: {
            method: "POST",
            url: "https://api.postwave.test/api/v1/subscribers/ada@example.com/tags",
          },
        },
      ],
    }) as RedactableEvent;

    expect(event.breadcrumbs?.[0]?.data?.url).toBe(
      "https://api.postwave.test/api/v1/subscribers/[redacted]/tags",
    );
  });
});

/**
 * Crash and session telemetry used to start at module load regardless of the
 * Privacy switch, under copy that reads as a complete claim about what leaves
 * the device. These pin the gate.
 */
describe("consent gates the SDK, not just the payload", () => {
  it("does not start at all when the operator has opted out", async () => {
    vi.resetModules();
    init.mockClear();
    process.env.EXPO_PUBLIC_SENTRY_DSN_MOBILE = "https://key@example.invalid/1";
    const { initSentry } = await import("./sentry");

    await initSentry(async () => true);

    // NOT "init with a filter that drops everything". sentry-cocoa writes a
    // hard crash from its own signal handler and uploads it on the next
    // launch, and that path never reaches the JavaScript hooks — so only
    // never calling init covers both halves.
    expect(init).not.toHaveBeenCalled();
  });

  it("treats an unreadable consent record as a refusal", async () => {
    vi.resetModules();
    init.mockClear();
    process.env.EXPO_PUBLIC_SENTRY_DSN_MOBILE = "https://key@example.invalid/1";
    const { initSentry } = await import("./sentry");

    await initSentry(async () => {
      throw new Error("keychain locked");
    });

    // A locked keychain is "we do not know", and not knowing is not consent.
    expect(init).not.toHaveBeenCalled();
  });

  it("starts when the switch is turned on later in the session", async () => {
    vi.resetModules();
    init.mockClear();
    process.env.EXPO_PUBLIC_SENTRY_DSN_MOBILE = "https://key@example.invalid/1";
    const { initSentry, startSentryOnConsent } = await import("./sentry");

    await initSentry(async () => true);
    expect(init).not.toHaveBeenCalled();

    // Without this the switch would appear to do nothing until a cold start.
    startSentryOnConsent();
    expect(init).toHaveBeenCalledTimes(1);
  });

  it("never starts twice, however the two entry points interleave", async () => {
    vi.resetModules();
    init.mockClear();
    process.env.EXPO_PUBLIC_SENTRY_DSN_MOBILE = "https://key@example.invalid/1";
    const { initSentry, startSentryOnConsent } = await import("./sentry");

    await initSentry(async () => false);
    startSentryOnConsent();
    startSentryOnConsent();

    expect(init).toHaveBeenCalledTimes(1);
  });
});
