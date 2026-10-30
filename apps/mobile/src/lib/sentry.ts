/**
 * Moosewave mobile Sentry wiring.
 *
 * Dormant until EXPO_PUBLIC_SENTRY_DSN_MOBILE is set at build time.
 * Mirrors the redaction shape used by every other Moosewave surface
 * (see apps/api/internal/observability/sentry.go,
 * apps/desktop/src/lib/sentry.ts, apps/web/sentry.client.config.ts):
 *
 *   - request bodies cleared
 *   - Authorization / Cookie / X-Postwave-Token headers stripped
 *   - secret, OAuth, session, and email-ish query params redacted
 *   - breadcrumb URL fields (fetch/xhr/navigation url/to/from) redacted
 *
 * The scrub rules now live in @postwave/telemetry (re-exported via
 * ./sentryRedact) so every surface shares one source of truth. The
 * 2026-06-21 ecosystem audit found mobile (and web) wired `beforeSend`
 * but were MISSING the `beforeBreadcrumb` URL redaction that desktop
 * already had — fixed below by wiring `redactBreadcrumb`.
 *
 * Unlike every other surface, mobile has a SECOND breadcrumb recorder the
 * JS hooks cannot reach: the native SDK. See
 * `disableNativeNetworkBreadcrumbs` below — without it the scrubbers are a
 * partial defence and unredacted subscriber URLs still reach Sentry.
 *
 * `EXPO_PUBLIC_*` is statically inlined by Expo's Metro bundler at
 * build time, so a build without the DSN set carries the init guard
 * as a const-folded check.
 */
import * as Sentry from "@sentry/react-native";

import {
  redactBreadcrumb,
  redactEvent,
  redactSpan,
  redactTransaction,
  type RedactableBreadcrumb,
  type RedactableEvent,
  type RedactableSpan,
  type RedactableTransaction,
} from "./sentryRedact";

let initialized = false;
let started = false;

/**
 * CONSENT GATES THE SDK ITSELF, not merely what it sends.
 *
 * The security review found crash and session telemetry starting at module
 * load regardless of the Privacy switch, over copy that reads as a complete
 * claim ("No subscriber data, email content, or names are ever sent") about a
 * switch that reached PostHog alone.
 *
 * A `beforeSend` that returns null would NOT have closed this. sentry-cocoa
 * writes a hard crash to disk from its own signal handler and uploads it on
 * the next launch, and that path never enters the JavaScript hooks — so a JS
 * filter is a filter on the envelopes JS can see, which is not the same set.
 * The only lever that covers both is whether `Sentry.init` is called at all.
 *
 * The cost is real and worth naming: an error thrown in the ~10ms before the
 * keychain answers is not captured. `lib/telemetry.ts` made the identical
 * trade for the identical reason ("CONSENT GATES CONSTRUCTION, not merely
 * capture") — building a client for someone who declined discloses their IP
 * and the fact that they run Moosewave before they have agreed to anything.
 *
 * Consent DEFAULTS TO DENIED: the reader passed in resolves true when no
 * record exists and true again when the keychain cannot be read, so an
 * unreadable decision fails towards not sending.
 *
 * `readOptOut` is INJECTED rather than imported. `lib/telemetry` owns the
 * consent record, and importing it here would pull expo-secure-store — and
 * through it react-native — into a module whose tests run under the node
 * environment. The caller (app/_layout.tsx) passes `getOptOut`.
 */
export async function initSentry(
  readOptOut: () => Promise<boolean>,
): Promise<void> {
  if (initialized) return;
  initialized = true;

  const dsn = (process.env.EXPO_PUBLIC_SENTRY_DSN_MOBILE ?? "").trim();
  if (!dsn) {
    console.info("[postwave-sentry] no DSN; running without error tracking");
    return;
  }
  let optedOut = true;
  try {
    optedOut = await readOptOut();
  } catch {
    // Consent that cannot be read is not consent.
    optedOut = true;
  }
  if (!optedOut) startSentry(dsn);
}

/**
 * Called by the Privacy switch when consent is GIVEN, since `initSentry` ran
 * at launch and found none. Without it, turning the switch on would silently
 * do nothing until the next cold start — the same gap `setOptOut` closes for
 * PostHog.
 */
export function startSentryOnConsent(): void {
  const dsn = (process.env.EXPO_PUBLIC_SENTRY_DSN_MOBILE ?? "").trim();
  if (dsn) startSentry(dsn);
}

/**
 * Called when consent is WITHDRAWN. `Sentry.close()` shuts the client down,
 * including the native layer, so a decision to stop takes effect in this
 * session rather than at the next launch.
 */
export function stopSentryOnRevoke(): void {
  if (!started) return;
  started = false;
  void Sentry.close().catch(() => {
    /* already closed, or never fully started */
  });
}

function startSentry(dsn: string): void {
  if (started) return;
  started = true;

  // Build options imperatively so we can omit fields when they're
  // unset — TS strictNullChecks + exactOptionalPropertyTypes (the
  // mobile tsconfig sets both) refuses `release: string | undefined`
  // when the param type is `string`.
  const options: Sentry.ReactNativeOptions = {
    dsn,
    environment:
      process.env.EXPO_PUBLIC_POSTWAVE_ENV ??
      (__DEV__ ? "development" : "production"),
    tracesSampleRate: 0.1,
    sendDefaultPii: false,
    enableAutoSessionTracking: true,
    // redactEvent scrubs PII/secrets in place; the cast bridges Sentry's
    // ErrorEvent to our SDK-free structural shape. Return the same (now
    // scrubbed) event object so the SDK keeps its concrete type.
    beforeSend: (event) => {
      redactEvent(event as unknown as RedactableEvent);
      return event;
    },
    // redactBreadcrumb scrubs URL fields (url/to/from) on fetch/xhr/
    // navigation breadcrumbs in place. Desktop already did this; mobile
    // was missing it, so request URLs with secret/email-ish query params
    // could be stored verbatim. Cast bridges Sentry's Breadcrumb to our
    // SDK-free structural shape; return the same (scrubbed) object.
    beforeBreadcrumb: (breadcrumb) => {
      redactBreadcrumb(breadcrumb as unknown as RedactableBreadcrumb);
      return breadcrumb;
    },
    // `tracesSampleRate` above is set, so the SDK is CONFIGURED to send a
    // second envelope kind — transactions — that `beforeSend` never sees. No
    // tracing integration is registered today, so nothing is produced; these
    // two hooks exist so that stays true of the DATA and not merely of the
    // volume. A transaction carries its own copy of the route name, and each
    // http span carries the request URL in `description` and in `data`, which
    // is where this app puts subscriber identity. Adding
    // `reactNavigationIntegration()` later must not be the change that starts
    // shipping unredacted paths.
    beforeSendTransaction: (event) => {
      redactTransaction(event as unknown as RedactableTransaction);
      return event;
    },
    beforeSendSpan: (span) => {
      redactSpan(span as unknown as RedactableSpan);
      return span;
    },
  };
  if (process.env.EXPO_PUBLIC_POSTWAVE_RELEASE) {
    options.release = process.env.EXPO_PUBLIC_POSTWAVE_RELEASE;
  }
  disableNativeNetworkBreadcrumbs(options);
  Sentry.init(options);
}

/**
 * The scrubbers above only see breadcrumbs that JavaScript creates.
 *
 * sentry-cocoa swizzles NSURLSession and records its OWN `http` breadcrumb —
 * full request URL included — directly onto the native scope. Those never
 * cross the bridge, so `beforeBreadcrumb` cannot touch them, and they ride
 * out with native crash events. @sentry/react-native knows this path exists:
 * ios/RNSentryReplayBreadcrumbConverter.m drops category `http` crumbs
 * "to avoid duplicates" with the JS ones. Moosewave puts subscriber identity
 * in the PATH (/subscribers/<email>, /sms/<phoneE164>), so those duplicates
 * are the unredacted copy of a URL the JS layer took care to redact.
 *
 * `enableNetworkBreadcrumbs` (SentryOptions.h:141, default YES) is the switch.
 * The JS bridge does not model it — `initNativeSdk` strips only the callback
 * options and forwards every remaining key verbatim (wrapper.js), and
 * sentry-cocoa reads exactly this name off the dictionary
 * (SentyOptionsInternal.m:162) — hence the cast: the key is real to the native
 * SDK but absent from ReactNativeOptions' TypeScript surface.
 *
 * Deliberately NOT `enableNative`/`enableNativeCrashHandling`/`enableSwizzling`:
 * each would also take out hard-crash reporting or view-controller tracing,
 * and crash reporting is the incident-response path. Network breadcrumbs are
 * the only capability given up, and the JS `fetch`/`xhr` crumbs — which the
 * whole app's traffic goes through — survive, scrubbed.
 *
 * Android needs no counterpart: sentry-android only records HTTP breadcrumbs
 * via the OkHttp integration, which the Gradle plugin has to install, and
 * RNSentryModuleImpl.getSentryAndroidOptions reads a fixed allowlist of keys
 * anyway — an extra key there would be silently ignored, not honoured.
 */
function disableNativeNetworkBreadcrumbs(
  options: Sentry.ReactNativeOptions,
): void {
  (options as Record<string, unknown>).enableNetworkBreadcrumbs = false;
}

/**
 * `Sentry.wrap` wraps the root component to attach React's error
 * boundary + touch event tracking. Re-exported so callers don't
 * have to import @sentry/react-native directly. When Sentry is
 * dormant (no DSN) this still wraps but the underlying tracking
 * is inert.
 */
export const wrap = Sentry.wrap;

/** Capture a root render failure; beforeSend removes its arbitrary message. */
export function captureRootError(error: unknown): void {
  Sentry.captureException(error, {
    tags: { boundary: "root", handled: true },
  });
}

// Redaction logic lives in @postwave/telemetry (re-exported by the SDK-free,
// unit-tested ./sentryRedact module). `beforeSend` receives Sentry's
// ErrorEvent and `beforeBreadcrumb` its Breadcrumb; redactEvent/redactBreadcrumb
// are generic + structurally compatible, so they scrub in place and return the
// same type.
