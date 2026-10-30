/**
 * Moosewave Desktop telemetry — opt-in PostHog wrapper.
 *
 * Wiring is dormant until the operator sets `VITE_POSTHOG_KEY` at build
 * time AND the user explicitly opts in via Settings. Calls into this
 * module are SAFE to make unconditionally — when telemetry is disabled
 * every entry point is a cheap no-op.
 *
 * Boot order:
 *   1. `init()` is called after first paint, but does not even import
 *      PostHog unless consent is already explicitly granted.
 *   2. Granting consent lazily imports and initializes the SDK with
 *      memory-only persistence and PostHog's own opt-out defaults.
 *   3. Revocation and sign-out reset SDK identity and purge legacy SDK
 *      cookies/localStorage/sessionStorage without touching app data.
 *
 * --- PII discipline (HARD RULE) ---
 *
 * The following data must NEVER appear in event properties or user
 * traits. Every callsite is reviewed against this list:
 *
 *   - subscriber email addresses, names, or any list-member PII
 *   - email body content (HTML, MJML, rendered text)
 *   - subject lines (may contain personalization tokens)
 *   - free-form user-typed strings (campaign titles, segment names,
 *     workspace names, etc.) unless explicitly hashed
 *   - error messages from the server (may contain stack traces with
 *     row data); use the `code` and `path` only
 *   - API keys, session tokens, OAuth tokens, signed URLs
 *
 * The following ARE allowed because they're structural:
 *
 *   - event names + status enums (`sent`, `failed`, `bounced`)
 *   - counts (subscribers, opens, clicks)
 *   - durations (request latency, send duration)
 *   - error codes (`E_BUDGET`, `E_RATE_LIMITED`, `E_NETWORK`)
 *   - locally derived one-way identity fingerprints; raw user/workspace IDs
 *     are never sent to the telemetry processor
 *
 * If you're unsure, prefer the structural form. Better to ship less
 * data than to leak a subscriber email by accident.
 *
 * --- Consent gate ---
 *
 * Whether capture is allowed is decided by the SHARED `shouldCapture`
 * decision helper from `@postwave/telemetry`, so web/desktop/mobile all
 * apply the same opt-IN rule (capture only on an explicit `granted`;
 * `unset`/`denied` => off). Desktop persists consent as a localStorage
 * opt-out flag (`postwave_telemetry_optout`); `consentState()` below maps
 * that flag onto the shared ConsentState so the actual go/no-go decision
 * lives in one place.
 */

import {
  type ConsentState,
  redactPath,
  redactUrl,
  shouldCapture,
} from "@postwave/telemetry";

import { readApiAuthority, subscribeApiAuthority } from "./api-authority";
import { canonicalApiBaseUrl } from "./config";
import { opaqueVaultKey } from "./opaque-vault-key";

const LS_OPTOUT = "postwave_telemetry_optout";
const CANONICAL_SESSION_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

interface PostHogModule {
  default: {
    init(key: string, options: PostHogInitOptions): void;
    capture(event: string, properties?: Record<string, unknown>): void;
    identify(distinctId: string, properties?: Record<string, unknown>): void;
    reset(): void;
    opt_in_capturing(options?: { captureEventName?: false }): void;
    opt_out_capturing(): void;
    has_opted_out_capturing(): boolean;
  };
}

interface PostHogInitOptions {
  api_host: string;
  // We default the privacy-aggressive set: no autocapture (we only
  // emit events we explicitly chose), no session recording, no DOM
  // text capture. Operators can flip these in PostHog project
  // settings; defaulting them OFF keeps the consent surface small.
  autocapture?: boolean;
  capture_pageview?: boolean;
  disable_session_recording?: boolean;
  disable_surveys?: boolean;
  disable_conversations?: boolean;
  disable_external_dependency_loading?: boolean;
  advanced_disable_flags?: boolean;
  advanced_disable_feature_flags?: boolean;
  capture_pageleave?: false;
  persistence?: "memory";
  opt_out_capturing_by_default?: boolean;
  opt_out_persistence_by_default?: boolean;
  // PostHog refuses to send when `respect_dnt` and the browser sends
  // Do-Not-Track. Honouring DNT is cheap and the right default.
  respect_dnt?: boolean;
  loaded?: (ph: PostHogModule["default"]) => void;
}

/**
 * `import.meta.env.*` is statically inlined by Vite at build time, so
 * the env-gate compiles down to a const string-literal check after
 * tree-shaking. This means a build done without `VITE_POSTHOG_KEY` set
 * carries zero PostHog code in the bundle (the `init` import below is
 * dynamic).
 */
function readEnv(): { key: string; host: string } | null {
  const key = (import.meta.env.VITE_POSTHOG_KEY ?? "").trim();
  if (!key) return null;
  // EU Cloud is a published commitment, not a preference: the sub-processor
  // register states PostHog's region as "EU (eu.posthog.com)" and that register
  // is part of the DPA per Terms §8. A US fallback here meant an unset env var
  // quietly sent desktop telemetry to a region the DPA does not name.
  const host = (
    import.meta.env.VITE_POSTHOG_HOST ?? "https://eu.posthog.com"
  ).trim();
  return { key, host };
}

// Keep the dynamic edge itself behind Vite's compile-time environment value.
// A no-key build can therefore remove both this loader and the SDK chunk.
const loadPostHogModule = import.meta.env.VITE_POSTHOG_KEY
  ? async (): Promise<PostHogModule> =>
      (await import("posthog-js/dist/module.slim.js")) as PostHogModule
  : null;

let phClient: PostHogModule["default"] | null = null;
let initPromise: Promise<void> | null = null;
let consentRevision = 0;
let identityRevision = 0;
let installedIdentityScope: string | null = null;
let installedIdentityApiBaseUrl: string | null = null;

function clearInstalledIdentityPreservingConsent(): void {
  installedIdentityScope = null;
  installedIdentityApiBaseUrl = null;
  const client = phClient;
  if (!client) return;
  safelyOptOut(client);
  safelyReset(client);
  if (captureAllowed() && client === phClient) safelyOptIn(client);
}

subscribeApiAuthority((nextAuthority) => {
  // Cancel pending hashes on every authority transition. If an identity is
  // already installed, clear it synchronously before any later event can be
  // attributed to a cloned deployment with matching UUIDs.
  identityRevision += 1;
  if (
    installedIdentityScope !== null &&
    installedIdentityApiBaseUrl !== nextAuthority
  ) {
    clearInstalledIdentityPreservingConsent();
  }
});

const POSTHOG_ARTIFACT_PATTERNS = [
  /^ph_.{1,512}_posthog$/u,
  /^ph_.{1,512}_(?:window_id|primary_window_exists)$/u,
  /^ph_(?:last_seen_tour_date|product_tour_(?:shown|completed|dismissed))_.{1,512}$/u,
  /^__ph_opt_in_out_.{1,512}$/u,
  /^ph_conv_.{1,512}$/u,
  /^(?:seenSurvey|inProgressSurvey|abandonedSurvey)_.{1,512}$/u,
] as const;

const POSTHOG_EXACT_ARTIFACTS = new Set([
  "_postHogToolbarParams",
  "lastSeenSurveyDate",
  "ph_active_product_tour",
  "ph_authorize",
  "ph_conv_restore",
  "ph_debug",
  "ph_key",
  "ph_keyword",
  "ph_load_editor",
  "ph_load_toolbar",
  "ph_product_tours",
  "ph_toolbar_internal",
  "ph_toolbar_state",
]);

function isPostHogArtifact(name: string): boolean {
  return (
    POSTHOG_EXACT_ARTIFACTS.has(name) ||
    POSTHOG_ARTIFACT_PATTERNS.some((pattern) => pattern.test(name))
  );
}

function purgeStorage(storage: Storage | undefined): void {
  if (!storage) return;
  try {
    const keys = Array.from({ length: storage.length }, (_, index) =>
      storage.key(index),
    ).filter((key): key is string => key !== null);
    for (const key of keys) {
      if (isPostHogArtifact(key)) storage.removeItem(key);
    }
  } catch {
    /* denied or partially implemented storage */
  }
}

function cookieDomainCandidates(): string[] {
  if (typeof window === "undefined") return [];
  const hostname = window.location?.hostname?.trim().toLowerCase() ?? "";
  if (
    !hostname ||
    hostname === "localhost" ||
    /^\d{1,3}(?:\.\d{1,3}){3}$/u.test(hostname)
  ) {
    return [];
  }
  const labels = hostname.split(".").filter(Boolean);
  const domains: string[] = [];
  for (let index = 0; index <= labels.length - 2; index += 1) {
    domains.push(`.${labels.slice(index).join(".")}`);
  }
  return domains;
}

function expireCookie(name: string, domain?: string): void {
  const domainAttribute = domain ? `; Domain=${domain}` : "";
  document.cookie = `${name}=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/${domainAttribute}; SameSite=Lax`;
}

function purgePostHogCookies(): void {
  if (typeof document === "undefined") return;
  try {
    const names = document.cookie
      .split(";")
      .map((part) => part.trim().split("=", 1)[0] ?? "")
      .filter((name) => name && isPostHogArtifact(name));
    const domains = cookieDomainCandidates();
    for (const name of names) {
      expireCookie(name);
      for (const domain of domains) expireCookie(name, domain);
    }
  } catch {
    /* cookie access denied */
  }
}

/** Remove only recognizable PostHog-owned browser artifacts. */
function purgePostHogArtifacts(): void {
  if (typeof window !== "undefined") {
    try {
      purgeStorage(window.localStorage);
      purgeStorage(window.sessionStorage);
    } catch {
      /* storage getters can also be denied */
    }
  }
  purgePostHogCookies();
}

function readOptOut(): boolean {
  if (typeof window === "undefined") return true;
  try {
    const value = window.localStorage.getItem(LS_OPTOUT);
    return value !== "0";
  } catch {
    return true;
  }
}

/**
 * Map the persisted opt-out flag onto the shared ConsentState. The user
 * has affirmatively `granted` capture only when they explicitly cleared
 * the opt-out ("0"); every other state (unset, or any non-"0" value)
 * stays `denied` — matching the shared opt-IN default.
 */
function consentState(): ConsentState {
  return readOptOut() ? "denied" : "granted";
}

/** Single go/no-go gate, delegated to the shared decision helper. */
function captureAllowed(): boolean {
  return shouldCapture(consentState());
}

/** PostHog attaches the current URL/pathname to manual events. Suppress the
 * complete SDK action whenever the shared redactor would alter either value;
 * sending a redacted property bag does not prevent the SDK auto-property. */
export function telemetryLocationIsSensitive(
  pathname: string,
  search = "",
  href = "",
): boolean {
  const path = pathname || "";
  const query = search ? (search.startsWith("?") ? search : `?${search}`) : "";
  const relative = `${path}${query}`;
  return (
    (path !== "" && redactPath(path) !== path) ||
    (relative !== "" && redactUrl(relative) !== relative) ||
    (href !== "" && redactUrl(href) !== href)
  );
}

function currentTelemetryLocationIsSensitive(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return telemetryLocationIsSensitive(
      window.location?.pathname ?? "",
      window.location?.search ?? "",
      window.location?.href ?? "",
    );
  } catch {
    return true;
  }
}

function postHogOptions(host: string): PostHogInitOptions {
  return {
    api_host: host,
    autocapture: false,
    capture_pageview: false,
    capture_pageleave: false,
    disable_session_recording: true,
    disable_surveys: true,
    disable_conversations: true,
    disable_external_dependency_loading: true,
    advanced_disable_flags: true,
    advanced_disable_feature_flags: true,
    persistence: "memory",
    opt_out_capturing_by_default: true,
    opt_out_persistence_by_default: true,
    respect_dnt: true,
  };
}

function safelyOptOut(client: PostHogModule["default"]): void {
  try {
    client.opt_out_capturing();
  } catch {
    /* SDK teardown is best-effort; the wrapper gate is authoritative. */
  }
}

function safelyReset(client: PostHogModule["default"]): void {
  try {
    client.reset();
  } catch {
    /* purge still runs below */
  }
}

function safelyOptIn(client: PostHogModule["default"]): boolean {
  try {
    client.opt_in_capturing({ captureEventName: false });
    return true;
  } catch {
    return false;
  }
}

async function initializeForGrantedConsent(): Promise<void> {
  if (!captureAllowed() || currentTelemetryLocationIsSensitive()) return;
  if (phClient) {
    safelyOptIn(phClient);
    return;
  }
  if (initPromise) {
    const active = initPromise;
    await active;
    if (!phClient && captureAllowed() && initPromise === null) {
      await initializeForGrantedConsent();
    }
    return;
  }
  const env = readEnv();
  if (!env || !loadPostHogModule) return;
  const revision = consentRevision;
  const pending = (async (): Promise<void> => {
    try {
      // The SDK module itself can touch browser globals, so both import and
      // init stay behind the explicit-grant check.
      const mod = await loadPostHogModule();
      if (revision !== consentRevision || !captureAllowed()) return;
      const client = mod.default;
      client.init(env.key, postHogOptions(env.host));
      phClient = client;
      if (!safelyOptIn(client)) {
        safelyOptOut(client);
        safelyReset(client);
        installedIdentityScope = null;
        phClient = null;
        purgePostHogArtifacts();
      }
    } catch {
      // Network / CSP / missing-package: telemetry is best-effort.
      // eslint-disable-next-line no-console
      console.warn("[postwave-telemetry] init failed");
    }
  })();
  initPromise = pending;
  try {
    await pending;
  } finally {
    if (initPromise === pending) initPromise = null;
  }
}

/**
 * Idempotent boot hook. Denied/unset consent performs cleanup only; the
 * PostHog chunk is neither imported nor initialized until explicit grant.
 */
export async function init(): Promise<void> {
  purgePostHogArtifacts();
  await initializeForGrantedConsent();
}

export function isEnabled(): boolean {
  if (!phClient || !captureAllowed()) return false;
  try {
    return !phClient.has_opted_out_capturing();
  } catch {
    return false;
  }
}

/**
 * Read-only view of the user's current opt-out preference. Used by
 * the Settings UI to render the toggle.
 */
export function getOptOut(): boolean {
  return readOptOut();
}

/**
 * Persist + apply the user's opt-out preference. Calling
 * `setOptOut(true)` is sufficient to stop all subsequent PostHog
 * traffic for this device, even if the user never reloads the app.
 */
export async function setOptOut(optOut: boolean): Promise<void> {
  if (typeof window === "undefined") return;
  const wasOptedOut = readOptOut();
  let persisted = false;
  try {
    window.localStorage.setItem(LS_OPTOUT, optOut ? "1" : "0");
    persisted = window.localStorage.getItem(LS_OPTOUT) === (optOut ? "1" : "0");
  } catch {
    /* A grant that cannot be recorded fails closed. */
    try {
      window.localStorage.removeItem(LS_OPTOUT);
    } catch {
      /* denied storage remains denied through readOptOut() */
    }
  }
  if (wasOptedOut !== optOut || !persisted) consentRevision += 1;
  if (optOut || !persisted) {
    if (phClient) {
      safelyOptOut(phClient);
      safelyReset(phClient);
      installedIdentityScope = null;
      installedIdentityApiBaseUrl = null;
      // reset() clears PostHog's consent marker, so re-assert denial before
      // deleting the marker and every other legacy SDK artifact.
      safelyOptOut(phClient);
    }
    purgePostHogArtifacts();
    return;
  }
  purgePostHogArtifacts();
  await initializeForGrantedConsent();
}

export function track(event: string, props?: Record<string, unknown>): void {
  if (currentTelemetryLocationIsSensitive() || !isEnabled() || !phClient)
    return;
  try {
    phClient.capture(event, props);
  } catch {
    // eslint-disable-next-line no-console
    console.warn("[postwave-telemetry] capture failed");
  }
}

export async function identifyWorkspace(
  userId: string | null | undefined,
  tenantId: string | null | undefined,
  apiBaseUrl: string | null | undefined,
): Promise<void> {
  const identityAtStart = ++identityRevision;
  const normalizedUser = typeof userId === "string" ? userId.trim() : "";
  const normalizedTenant = typeof tenantId === "string" ? tenantId.trim() : "";
  const normalizedApiBaseUrl = canonicalApiBaseUrl(apiBaseUrl);
  const requestedScope =
    CANONICAL_SESSION_UUID_RE.test(normalizedUser) &&
    CANONICAL_SESSION_UUID_RE.test(normalizedTenant) &&
    normalizedApiBaseUrl !== null &&
    normalizedApiBaseUrl === readApiAuthority()
      ? JSON.stringify([normalizedApiBaseUrl, normalizedUser, normalizedTenant])
      : null;
  const client = phClient;
  if (
    client &&
    installedIdentityScope !== null &&
    requestedScope !== installedIdentityScope
  ) {
    clearInstalledIdentityPreservingConsent();
  }
  if (
    requestedScope === null ||
    requestedScope === installedIdentityScope ||
    currentTelemetryLocationIsSensitive() ||
    !isEnabled() ||
    !phClient
  ) {
    return;
  }
  const consentAtStart = consentRevision;
  const activeClient = phClient;
  const distinctId = await opaqueVaultKey(
    "telemetry-identity",
    JSON.stringify([3, normalizedApiBaseUrl, normalizedUser, normalizedTenant]),
  );
  if (
    !distinctId ||
    consentAtStart !== consentRevision ||
    identityAtStart !== identityRevision ||
    activeClient !== phClient ||
    installedIdentityScope !== null ||
    normalizedApiBaseUrl !== readApiAuthority() ||
    currentTelemetryLocationIsSensitive() ||
    !isEnabled()
  ) {
    return;
  }
  try {
    activeClient.identify(distinctId);
    installedIdentityScope = requestedScope;
    installedIdentityApiBaseUrl = normalizedApiBaseUrl;
  } catch {
    // eslint-disable-next-line no-console
    console.warn("[postwave-telemetry] identify failed");
  }
}

/**
 * Clear any in-memory user identity. Call from sign-out paths so the
 * next user on this device doesn't get conflated with the previous
 * session.
 */
export function reset(): void {
  consentRevision += 1;
  identityRevision += 1;
  const client = phClient;
  installedIdentityScope = null;
  installedIdentityApiBaseUrl = null;
  if (client) {
    safelyOptOut(client);
    safelyReset(client);
  }
  purgePostHogArtifacts();
  // Consent is a device preference, not an account preference. Keep an
  // explicitly granted device enabled after clearing the signed-in identity.
  if (client && captureAllowed()) safelyOptIn(client);
}
