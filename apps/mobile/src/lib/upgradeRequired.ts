/**
 * lib/upgradeRequired.ts — handling for HTTP 426 Upgrade Required.
 *
 * The gateway enforces a per-client minimum version
 * (apps/api/internal/middleware/client_version.go): a build below the floor
 * gets a `problem+json` body with `code: "upgrade_required"` plus
 * `min_version` / `current_version` / `client` / `request_id`. Mobile already
 * sends `X-Postwave-Client` + `X-Postwave-Version` (api/nativeClient.ts) — and
 * then had ZERO handling for the response, so a below-floor build showed the
 * raw SDK error string on every screen with no way out (NATIVE#3).
 *
 * This module is deliberately transport-agnostic and free of React Native
 * imports: the parser and the store are unit-tested in the node environment,
 * `api/sdkClient.ts` feeds it, and `components/UpgradeRequiredScreen.tsx`
 * renders it.
 */

export interface UpgradeRequirement {
  /** Minimum version the server will accept (semver, as reported). */
  minVersion: string | null;
  /** The version this build sent, echoed back by the gateway. */
  currentVersion: string | null;
  /** Server-normalised client id ("mobile"). */
  client: string | null;
  /** Correlation id for support. */
  requestId: string | null;
  detail: string | null;
}

const MAX_FIELD_CHARS = 64;
const MAX_DETAIL_CHARS = 240;
/** Semver-ish, plus the pre-release/build suffixes EAS emits. */
const VERSION_RE = /^[0-9]+(\.[0-9]+){0,3}([-+][A-Za-z0-9.-]{1,32})?$/;
const CLIENT_RE = /^[a-z0-9_-]{1,32}$/;
const REQUEST_ID_RE = /^[A-Za-z0-9/_.-]{1,64}$/;

function boundedString(
  value: unknown,
  pattern: RegExp | null,
  max: number,
): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max) return null;
  if (pattern && !pattern.test(trimmed)) return null;
  return trimmed;
}

/**
 * Parse a 426 body into a requirement. Returns null when the body is not an
 * `upgrade_required` problem document, so an unrelated 426 (a proxy, a captive
 * portal) can never lock the user out of the app.
 *
 * Accepts the already-parsed object or the raw JSON text.
 */
export function parseUpgradeRequired(body: unknown): UpgradeRequirement | null {
  let value = body;
  if (typeof value === "string") {
    if (value.length > 8 * 1024) return null;
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== "object") return null;
  const doc = value as Record<string, unknown>;
  if (doc.code !== "upgrade_required") return null;
  return {
    minVersion: boundedString(doc.min_version, VERSION_RE, MAX_FIELD_CHARS),
    currentVersion: boundedString(
      doc.current_version,
      VERSION_RE,
      MAX_FIELD_CHARS,
    ),
    client: boundedString(doc.client, CLIENT_RE, MAX_FIELD_CHARS),
    requestId: boundedString(doc.request_id, REQUEST_ID_RE, MAX_FIELD_CHARS),
    detail: boundedString(doc.detail, null, MAX_DETAIL_CHARS),
  };
}

/**
 * The store listing to send the user to. Custom schemes (`itms-apps:` /
 * `market:`) open the store app directly; the https forms are the fallback the
 * OS always resolves, so the button can never dead-end.
 */
export function storeUrlsForPlatform(
  platform: string,
  ids: { iosAppStoreId?: string | undefined; androidPackage?: string | undefined } = {},
): string[] {
  if (platform === "android") {
    const pkg = boundedString(
      ids.androidPackage,
      /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/,
      128,
    );
    if (!pkg) return ["https://play.google.com/store/search?q=Moosewave&c=apps"];
    return [
      `market://details?id=${pkg}`,
      `https://play.google.com/store/apps/details?id=${pkg}`,
    ];
  }
  const appStoreId = boundedString(ids.iosAppStoreId, /^[0-9]{6,12}$/, 16);
  if (!appStoreId) return ["https://apps.apple.com/search?term=Moosewave"];
  return [
    `itms-apps://apps.apple.com/app/id${appStoreId}`,
    `https://apps.apple.com/app/id${appStoreId}`,
  ];
}

// --- store -----------------------------------------------------------------

let requirement: UpgradeRequirement | null = null;
const listeners = new Set<() => void>();

function commit(next: UpgradeRequirement | null): void {
  requirement = next;
  for (const listener of [...listeners]) listener();
}

export function getUpgradeRequirement(): UpgradeRequirement | null {
  return requirement;
}

export function subscribeUpgradeRequirement(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Record a discovered requirement. First one wins: later 426s from parallel
 * requests must not thrash the blocking screen's copy.
 */
export function reportUpgradeRequired(next: UpgradeRequirement): void {
  if (requirement) return;
  commit(next);
}

/** Cleared on sign-out and by tests; a new session may reach a newer gateway. */
export function clearUpgradeRequirement(): void {
  if (!requirement) return;
  commit(null);
}
