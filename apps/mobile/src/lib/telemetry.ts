/**
 * Moosewave mobile telemetry — opt-in PostHog wrapper.
 *
 * Wiring is dormant until the operator sets `EXPO_PUBLIC_POSTHOG_KEY`
 * AND the user has explicitly enabled telemetry via Settings. Calls into this module
 * are SAFE to make unconditionally — when telemetry is disabled every
 * entry point is a cheap no-op.
 *
 * Boot order:
 *   1. `init()` is called from src/hooks/useAppBootstrap.ts (run by
 *      app/_layout.tsx) in parallel with auth hydration, and again by
 *      setOptOut(false) the first time consent is given. If
 *      `EXPO_PUBLIC_POSTHOG_KEY` is unset, init() returns immediately and
 *      `isEnabled()` stays false forever.
 *   2. init() consults the user's SecureStore telemetry preference BEFORE it
 *      builds a client, and builds none without a recorded grant.
 *   3. `track()` and `identify()` flow through to PostHog only when
 *      both gates are satisfied.
 *
 * --- PII discipline (HARD RULE) ---
 *
 *   - subscriber email addresses, names, or any list-member PII
 *   - email body content
 *   - subject lines
 *   - free-form user-typed strings unless explicitly hashed
 *   - server-rendered error messages
 *   - API keys, session tokens, OAuth tokens, signed URLs
 *
 * Allowed (structural):
 *   - event names + status enums
 *   - counts, durations, error codes
 *   - contract-defined route/flow keys (never customer identifiers)
 */
import { isKnownEvent, type EventName } from "@postwave/telemetry";

import { readOptOut, writeOptOut } from "@/lib/telemetryConsentStore";

interface PostHogOptions {
  host?: string;
  // We default the privacy-aggressive set: no autocapture, no session
  // recording.
  captureAppLifecycleEvents?: boolean;
  enableSessionReplay?: boolean;
  // Both suppress network calls the constructor makes on its own initiative;
  // this app uses neither feature flags nor remote config.
  preloadFeatureFlags?: boolean;
  disableRemoteConfig?: boolean;
}

interface PostHogClient {
  capture(event: string, properties?: Record<string, unknown>): Promise<void>;
  identify(
    distinctId: string,
    properties?: Record<string, unknown>,
  ): Promise<void>;
  reset(): Promise<void>;
  optIn(): Promise<void>;
  optOut(): Promise<void>;
}

interface PostHogModule {
  PostHog: new (key: string, options?: PostHogOptions) => PostHogClient;
}

let phClient: PostHogClient | null = null;
let initialized = false;
let initPromise: Promise<void> | null = null;
let cachedOptOut = false;
/** Counts setOptOut calls, so that only the latest one settles the session. */
let decisionSeq = 0;

const SAFE_PROPERTY_KEYS = new Set([
  // Mobile release-health taxonomy.
  "attempt",
  "duration_ms",
  "error_code",
  "method",
  "network_state",
  "outcome",
  "platform",
  "source",
  "status_code",
  "tab",
  // Mobile shell interaction (search / notifications / settings). Structural
  // only: `query_length` is a NUMBER because the query text itself must never
  // leave the device, and `setting` is a fixed key name, never a value that
  // could carry workspace content.
  "query_length",
  "result_count",
  "hit_type",
  "kind",
  "had_deep_link",
  "resolved",
  "setting",
  "enabled",
  // Mobile dashboard interaction. `range` is a fixed window enum (7d/30d/90d)
  // and `metric` is a tile KEY from the grid's own list — never a workspace
  // figure. The counts on the screen are customer data and stay on the device.
  "range",
  "metric",
  // Typed @postwave/onboarding-schema properties.
  "completed",
  "cta",
  "idleDays",
  "index",
  "key",
  "lastStepId",
  "milestone",
  "msOnPrevStep",
  "stepCount",
  "stepId",
  "surfaceId",
  "total",
  "totalMs",
  "tourId",
  "trigger",
  "wizardId",
]);
const SAFE_STRING_VALUE = /^[A-Za-z0-9_. -]{1,64}$/;
const MAX_ABSOLUTE_NUMBER = 1_000_000_000;

function readEnv(): { key: string; host: string } | null {
  const key = (process.env.EXPO_PUBLIC_POSTHOG_KEY ?? "").trim();
  if (!key) return null;
  const host =
    // EU Cloud is a published commitment, not a preference: the sub-processor
    // register states PostHog's region as "EU (eu.posthog.com)" and that
    // register is part of the DPA per Terms §8. A US fallback here meant an
    // unset env var quietly sent mobile telemetry to a region the DPA does
    // not name.
    (process.env.EXPO_PUBLIC_POSTHOG_HOST ?? "https://eu.posthog.com").trim();
  try {
    const parsed = new URL(host);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
      return null;
    }
    return { key, host: parsed.origin };
  } catch {
    return null;
  }
}

/**
 * Idempotent. Safe to call multiple times. Safe to call when no key is
 * set (becomes a no-op).
 */
export async function init(): Promise<void> {
  if (initialized || initPromise) {
    if (initPromise) await initPromise;
    return;
  }
  const env = readEnv();
  if (!env) {
    initialized = true;
    return;
  }
  initPromise = (async () => {
    // A decision made while this read or the import below is in flight
    // settles the session (see setOptOut), not the record read here: a grant
    // read back just before a quick withdrawal would otherwise switch sending
    // back on, or build a client after the switch went OFF. A later grant
    // builds the client itself once it is recorded, so stopping here never
    // leaves a recorded grant without one, and never builds a second.
    const seq = decisionSeq;
    try {
      const stored = await readOptOut();
      if (seq !== decisionSeq) return;
      cachedOptOut = stored;
      // CONSENT GATES CONSTRUCTION, not merely capture.
      //
      // `optOut()` guards enqueue/sendImmediate only. The CONSTRUCTOR itself
      // persists a stable per-install device id and then phones home: remote
      // config and feature-flag preloads are issued from initAfterStorage,
      // gated by the `disabled` OPTION and never by opt-out. Building the
      // client for someone who declined therefore disclosed their IP, that
      // install id, and the fact that they run Moosewave — every launch, before
      // sign-in. Consent defaults to DENIED here (readOptOut returns true for
      // an absent record), so that was the common path, not an edge case.
      if (cachedOptOut) {
        initialized = true;
        return;
      }
      const mod =
        (await import("posthog-react-native")) as unknown as PostHogModule;
      if (seq !== decisionSeq) return;
      const client = new mod.PostHog(env.key, {
        host: env.host,
        captureAppLifecycleEvents: false,
        enableSessionReplay: false,
        // This app uses neither, and both are network calls the constructor
        // would otherwise make on its own initiative.
        preloadFeatureFlags: false,
        disableRemoteConfig: true,
      });
      await client.optIn();
      phClient = client;
    } catch {
      console.warn("[postwave-telemetry] initialization failed");
    } finally {
      initialized = true;
    }
  })();
  await initPromise;
}

export function isEnabled(): boolean {
  return phClient !== null && !cachedOptOut;
}

export async function getOptOut(): Promise<boolean> {
  return readOptOut();
}

export async function setOptOut(optOut: boolean): Promise<boolean> {
  const seq = ++decisionSeq;
  // A withdrawal takes effect at once, before its write and whatever becomes
  // of it: not sending is the safe side of any mismatch. A grant takes effect
  // only once it is recorded (below).
  if (optOut) cachedOptOut = true;
  // Report whether the preference was durably persisted, so callers can
  // surface a failure and revert their UI instead of leaving a change that
  // silently reverts on relaunch.
  let persisted = true;
  try {
    await writeOptOut(optOut);
  } catch {
    /* not persisted: the false return tells the caller */
    persisted = false;
  }
  // Overtaken by a later decision (switch ON, then straight OFF): that call
  // settles the session, here and in an init() it overtook. Acting on this one
  // now could turn telemetry back on after the user switched it off.
  if (seq !== decisionSeq) return persisted;
  if (!optOut && !persisted) {
    // A grant that cannot be persisted is NOT applied, whether or not a client
    // exists. The false return makes the caller flip its switch back to OFF
    // (settings.tsx), and the record still holds the earlier decision, so
    // sending now would be telemetry under a switch the user can see is off.
    // A client built earlier this session is told again to stay opted out.
    cachedOptOut = true;
    if (phClient) {
      try {
        await phClient.optOut();
      } catch {
        /* ignore */
      }
    }
    return false;
  }
  cachedOptOut = optOut;
  if (phClient) {
    try {
      if (optOut) await phClient.optOut();
      else await phClient.optIn();
    } catch {
      /* ignore */
    }
  } else if (!optOut) {
    // init() deliberately builds no client while consent is denied, so the
    // moment consent is GIVEN is the first chance to build one. Without this,
    // turning the switch on would silently do nothing until the next launch.
    // init() reads the recorded grant back rather than being handed it.
    initialized = false;
    initPromise = null;
    await init();
  }
  return persisted;
}

export function track(event: EventName, props?: Record<string, unknown>): void {
  if (!isEnabled() || !phClient) return;
  if (!isKnownEvent(event)) return;
  const safeProperties = sanitizeTelemetryProperties(props);
  // capture() returns a promise; we deliberately fire-and-forget so
  // mobile UI threads never block on a telemetry round-trip.
  void phClient.capture(event, safeProperties).catch(() => {
    console.warn("[postwave-telemetry] capture failed");
  });
}

export function identify(
  userId: string,
  props?: Record<string, unknown>,
): void {
  if (!isEnabled() || !phClient) return;
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(userId)) return;
  void phClient
    .identify(userId, sanitizeTelemetryProperties(props))
    .catch(() => {
      console.warn("[postwave-telemetry] identify failed");
    });
}

/**
 * Drop every non-contract property and every free-form/nested value before it
 * reaches PostHog. This is an allowlist, not a secret-pattern denylist.
 *
 * The allowlist is the right privacy posture, but it used to drop keys in
 * TOTAL silence (NATIVE#57): a developer adding `stall_ms` to a new event saw
 * the event arrive with empty properties and no clue why. Dropped keys are now
 * reported in __DEV__ only — never in production, where the console line would
 * itself be a place customer content could surface.
 *
 * `onDropped` is an injectable seam so the behaviour is testable without
 * asserting on console noise.
 */
export function sanitizeTelemetryProperties(
  props?: Record<string, unknown>,
  onDropped: (keys: string[]) => void = warnDroppedTelemetryKeys,
): Record<string, string | number | boolean> | undefined {
  if (!props) return undefined;
  const safe: Record<string, string | number | boolean> = {};
  const dropped: string[] = [];
  for (const [key, value] of Object.entries(props)) {
    if (!SAFE_PROPERTY_KEYS.has(key)) {
      dropped.push(key);
      continue;
    }
    if (typeof value === "boolean") {
      safe[key] = value;
    } else if (
      typeof value === "number" &&
      Number.isFinite(value) &&
      Math.abs(value) <= MAX_ABSOLUTE_NUMBER
    ) {
      safe[key] = value;
    } else if (typeof value === "string" && SAFE_STRING_VALUE.test(value)) {
      safe[key] = value;
    } else {
      // The key is on the contract but the VALUE was rejected — a different
      // and equally confusing failure, so it is reported too. Only the key
      // name is ever named; the value is exactly what must not be logged.
      dropped.push(key);
    }
  }
  if (dropped.length > 0) onDropped(dropped);
  return Object.keys(safe).length > 0 ? safe : undefined;
}

function warnDroppedTelemetryKeys(keys: string[]): void {
  // `__DEV__` is a Metro global; guard its existence so the sanitizer stays
  // importable from the node test environment.
  if (typeof __DEV__ === "undefined" || !__DEV__) return;
  console.warn(
    `[postwave-telemetry] dropped ${keys.length} propert${
      keys.length === 1 ? "y" : "ies"
    } not on the contract allowlist: ${keys.join(", ")}`,
  );
}

export function reset(): void {
  if (!phClient) return;
  void phClient.reset().catch(() => {
    /* ignore */
  });
}
