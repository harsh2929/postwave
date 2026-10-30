import { isMigrationSourceId } from "./migration-deep-link";

/**
 * Resolves the URL of the hosted Moosewave admin that the desktop shell
 * redirects into, and translates `moosewave://` deep-links into in-app paths.
 *
 * Resolution order (first reachable wins):
 *   1. `localStorage.postwave_dashboard_url`  — QA / staging override.
 *   2. `import.meta.env.VITE_DASHBOARD_URL`   — bake-time override.
 *   3. dev fallback:  `http://localhost:3000` (or `:3001` if 3000 is busy)
 *   4. prod fallback: `https://app.moosewave.com`.
 *
 * Why probe before redirect:
 *   The webview's network stack hangs on DNS for ~30s when a host doesn't
 *   resolve (e.g. `app.moosewave.com` in pre-launch). That makes the desktop
 *   app feel broken on cold start. The probe gives up after 2s and surfaces
 *   a configure screen letting the operator point at a working URL — which
 *   is then persisted to localStorage so subsequent launches are instant.
 */

const LOCAL_STORAGE_KEY = "postwave_dashboard_url";
const DEFAULT_PROD_URL = "https://app.moosewave.com";
// Order: 3001 first, then 3000. Next.js auto-falls back to :3001 when :3000
// is busy (a frequent dev situation when something else is on :3000), so we
// probe 3001 first to skip a wasted round-trip in that common case.
const DEFAULT_DEV_URLS = ["http://localhost:3001", "http://localhost:3000"];
const PROBE_TIMEOUT_MS = 2000;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const MAX_DEEP_LINK_BYTES = 8 * 1024;
const MAX_DEEP_LINK_STATE_CHARS = 256;
const RESOURCE_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const OPAQUE_DEEP_LINK_VALUE_RE = /^[A-Za-z0-9._~-]+$/;
const SUBSCRIBER_TARGET_RE = /^[A-Za-z0-9._+@-]{1,254}$/;

// VITE_DASHBOARD_URL is statically substituted by Vite at build time —
// the access has to be a literal `import.meta.env.VITE_*` for the
// substitution to fire. Read it ONCE at module load and treat it as a
// plain constant.
const BAKED_VITE_DASHBOARD_URL: string | undefined =
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ((import.meta as any).env as { VITE_DASHBOARD_URL?: string } | undefined)
    ?.VITE_DASHBOARD_URL;

const IS_DEV: boolean =
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ((import.meta as any).env as { DEV?: boolean } | undefined)?.DEV === true;

function readLocalStorageOverride(): string | null {
  try {
    const value = window.localStorage.getItem(LOCAL_STORAGE_KEY);
    return value && value.trim().length > 0 ? value.trim() : null;
  } catch {
    // Some webviews lock down localStorage; treat as no override.
    return null;
  }
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

function safeDashboardOrigin(raw: string | null | undefined): string | null {
  if (!raw) return null;
  if (CONTROL_RE.test(raw)) return null;
  try {
    const parsed = new URL(stripTrailingSlash(raw.trim()));
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:")
      return null;
    if (parsed.username || parsed.password) return null;
    if (parsed.search || parsed.hash) return null;
    if (parsed.protocol === "http:" && !isLocalHost(parsed.hostname))
      return null;
    return parsed.toString().replace(/\/+$/, "");
  } catch {
    return null;
  }
}

function isLocalHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h === "localhost" || h === "127.0.0.1" || h === "::1" || h === "[::1]";
}

/**
 * Persist a custom dashboard URL so subsequent launches use it without
 * re-prompting. Cleared by passing null/empty.
 */
export function setDashboardUrlOverride(url: string | null): void {
  try {
    const safe = safeDashboardOrigin(url);
    if (safe) {
      window.localStorage.setItem(LOCAL_STORAGE_KEY, safe);
    } else {
      window.localStorage.removeItem(LOCAL_STORAGE_KEY);
    }
  } catch {
    // localStorage locked down — silently ignore. Caller falls back to env/defaults.
  }
}

/**
 * Returns the ordered list of URLs the boot flow should probe, deduped.
 * The first one that responds (any HTTP status, including 4xx) wins.
 */
export function getCandidateDashboardUrls(): string[] {
  const out: string[] = [];
  const push = (u: string | null | undefined): void => {
    const norm = safeDashboardOrigin(u);
    if (!norm) return;
    if (!out.includes(norm)) out.push(norm);
  };

  push(readLocalStorageOverride());
  push(BAKED_VITE_DASHBOARD_URL);

  if (IS_DEV) {
    DEFAULT_DEV_URLS.forEach(push);
    push(DEFAULT_PROD_URL);
  } else {
    // Production builds never probe (or redirect into) localhost — the
    // dev fallbacks are dev-only candidates. An operator can still point
    // at a local dashboard explicitly via the localStorage override.
    push(DEFAULT_PROD_URL);
  }

  return out;
}

/**
 * Returns the FIRST candidate URL — historical behavior. Use
 * `pickReachableDashboardUrl()` when you can afford the async probe.
 */
export function getDashboardUrl(): string {
  return getCandidateDashboardUrls()[0] ?? DEFAULT_PROD_URL;
}

/**
 * Probe a URL with a HARD timeout. Returns true on any HTTP response
 * (including 401/404 — the host is at least reachable) or false on
 * network failure / timeout / DNS error.
 *
 * Why `Promise.race` over just `AbortController`: in some WebKit
 * configurations a `fetch()` against an unresolvable DNS hostname
 * can ignore the abort signal and block at the platform DNS layer
 * for ~30s. The race gives us a wall-clock guarantee regardless of
 * the underlying network stack's behaviour. The lingering fetch
 * promise eventually rejects on its own — we just stop waiting.
 *
 * `mode: 'no-cors'` lets us probe cross-origin without surfacing
 * preflight failures as `false` for hosts that don't allow CORS
 * but ARE alive.
 */
export async function probeDashboardUrl(
  url: string,
  timeoutMs: number = PROBE_TIMEOUT_MS,
): Promise<boolean> {
  const ctrl = new AbortController();
  const timer = window.setTimeout(() => ctrl.abort(), timeoutMs);
  let timeoutTimer: number | null = null;
  try {
    const fetched = (async (): Promise<boolean> => {
      try {
        await fetch(url, {
          method: "GET",
          mode: "no-cors",
          signal: ctrl.signal,
          cache: "no-store",
          redirect: "follow",
        });
        return true;
      } catch {
        return false;
      }
    })();
    const timeout = new Promise<boolean>((resolve) => {
      timeoutTimer = window.setTimeout(() => resolve(false), timeoutMs + 50);
    });
    return await Promise.race([fetched, timeout]);
  } finally {
    window.clearTimeout(timer);
    if (timeoutTimer !== null) {
      window.clearTimeout(timeoutTimer);
    }
  }
}

/**
 * Probe candidates in order; resolve with the first reachable URL or null.
 * The `onProbe` callback fires once per attempt for UI progress.
 */
export async function pickReachableDashboardUrl(
  onProbe?: (url: string, ok: boolean) => void,
): Promise<string | null> {
  for (const url of getCandidateDashboardUrls()) {
    const ok = await probeDashboardUrl(url);
    onProbe?.(url, ok);
    if (ok) return url;
  }
  return null;
}

/**
 * Map a `moosewave://...` deep-link to a path on the hosted dashboard.
 * Returns `null` for unknown / malformed inputs so callers can log + ignore.
 *
 * Supported actions:
 *   moosewave://approval/{id}        -> /app/approvals/{id}
 *   moosewave://subscriber/{email}   -> /app/subscribers?email=...
 *   moosewave://campaign/{id}        -> /app/campaigns/{id}
 *   moosewave://sequence/{id}        -> /app/sequences/{id}
 *   moosewave://migrations/api-key   -> /app/migrations/api-key
 *   moosewave://migrate/{src}/api-key-entry
 *                                    -> /app/migrations/api-key?source={src}
 *   moosewave://settings             -> /app/settings
 */
export function mapDeepLinkToPath(rawUrl: string): string | null {
  const request = parseDeepLink(rawUrl);
  if (!request) return null;

  switch (request.action) {
    case "approval":
      return mapResourceDeepLink(request, "/app/approvals");
    case "subscriber":
      return mapSubscriberDeepLink(request);
    case "campaign":
      return mapResourceDeepLink(request, "/app/campaigns");
    case "sequence":
      return mapResourceDeepLink(request, "/app/sequences");
    case "migrations":
      return mapMigrationDeepLink(request);
    case "migrate":
      return mapMigrationReturnDeepLink(request);
    case "settings":
      return request.segments.length === 0 && !request.hasRawQuery
        ? "/app/settings"
        : null;
    default:
      return null;
  }
}

interface ParsedDeepLink {
  action: string;
  hasRawQuery: boolean;
  parsed: URL;
  rawUrl: string;
  segments: string[];
}

function parseDeepLink(rawUrl: string): ParsedDeepLink | null {
  if (
    typeof rawUrl !== "string" ||
    rawUrl.length === 0 ||
    !rawUrl.startsWith("moosewave://") ||
    rawUrl.trim() !== rawUrl ||
    CONTROL_RE.test(rawUrl) ||
    rawUrl.includes("\\") ||
    new TextEncoder().encode(rawUrl).byteLength > MAX_DEEP_LINK_BYTES
  ) {
    return null;
  }
  const afterScheme = rawUrl.slice("moosewave://".length);
  const authorityEnd = afterScheme.search(/[/?]/u);
  const authority = afterScheme.slice(
    0,
    authorityEnd === -1 ? undefined : authorityEnd,
  );
  if (!/^[a-z-]+$/u.test(authority)) return null;

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }

  if (
    parsed.protocol !== "postwave:" ||
    !parsed.hostname ||
    parsed.host !== parsed.hostname ||
    parsed.username ||
    parsed.password ||
    parsed.hash
  ) {
    return null;
  }

  const action = parsed.hostname;
  const segments = decodeDeepLinkSegments(parsed.pathname);
  if (!segments) return null;
  return {
    action,
    hasRawQuery: rawUrl.includes("?"),
    parsed,
    rawUrl,
    segments,
  };
}

function mapResourceDeepLink(
  request: ParsedDeepLink,
  path: string,
): string | null {
  const id = singleDeepLinkSegment(request.segments);
  if (!id || !RESOURCE_ID_RE.test(id) || request.hasRawQuery) return null;
  return `${path}/${encodeURIComponent(id)}`;
}

function mapSubscriberDeepLink(request: ParsedDeepLink): string | null {
  const target = singleDeepLinkSegment(request.segments);
  if (!target || !isSafeSubscriberTarget(target) || request.hasRawQuery) {
    return null;
  }
  return `/app/subscribers?email=${encodeURIComponent(target)}`;
}

function mapMigrationDeepLink(request: ParsedDeepLink): string | null {
  if (request.segments.length !== 1 || request.segments[0] !== "api-key") {
    return null;
  }
  const allowed = ["source", "state"] as const;
  if (!hasCanonicalRawQuery(request.rawUrl, allowed)) return null;
  const params = strictDeepLinkParams(request.parsed.searchParams, allowed);
  if (!params || (request.hasRawQuery && params.size === 0)) return null;
  const source = params.get("source");
  const state = params.get("state");
  if (source !== undefined && !isMigrationSourceId(source)) return null;
  if (state !== undefined && !isSafeDeepLinkState(state)) return null;
  return migrationDeepLinkPath(source, state);
}

function mapMigrationReturnDeepLink(request: ParsedDeepLink): string | null {
  const [source, entry] = request.segments;
  if (
    request.segments.length !== 2 ||
    entry !== "api-key-entry" ||
    !isMigrationSourceId(source)
  ) {
    return null;
  }
  const allowed = ["state"] as const;
  if (!hasCanonicalRawQuery(request.rawUrl, allowed)) return null;
  const params = strictDeepLinkParams(request.parsed.searchParams, allowed);
  if (!params || (request.hasRawQuery && params.size === 0)) return null;
  const state = params.get("state");
  if (state !== undefined && !isSafeDeepLinkState(state)) return null;
  return migrationDeepLinkPath(source, state);
}

function decodeDeepLinkSegments(pathname: string): string[] | null {
  if (pathname === "") return [];
  if (!pathname.startsWith("/")) return null;
  const encoded = pathname.slice(1).split("/");
  if (encoded.some((segment) => segment.length === 0)) return null;
  const decoded: string[] = [];
  try {
    for (const segment of encoded) {
      const value = decodeURIComponent(segment);
      // A remaining percent sign could be interpreted by a later decoder.
      if (value.includes("%") || CONTROL_RE.test(value)) return null;
      decoded.push(value);
    }
  } catch {
    return null;
  }
  return decoded;
}

function singleDeepLinkSegment(segments: string[]): string | null {
  return segments.length === 1 ? (segments[0] ?? null) : null;
}

function strictDeepLinkParams(
  searchParams: URLSearchParams,
  allowed: readonly string[],
): Map<string, string> | null {
  const result = new Map<string, string>();
  for (const [key, value] of searchParams.entries()) {
    if (!allowed.includes(key) || result.has(key) || value.includes("%")) {
      return null;
    }
    result.set(key, value);
  }
  return result;
}

function hasCanonicalRawQuery(
  rawUrl: string,
  allowed: readonly string[],
): boolean {
  const queryIndex = rawUrl.indexOf("?");
  if (queryIndex === -1) return true;
  const query = rawUrl.slice(queryIndex + 1);
  if (!query) return false;
  const seen = new Set<string>();
  for (const pair of query.split("&")) {
    const separator = pair.indexOf("=");
    if (separator <= 0 || separator !== pair.lastIndexOf("=")) return false;
    const key = pair.slice(0, separator);
    const value = pair.slice(separator + 1);
    if (
      !allowed.includes(key) ||
      seen.has(key) ||
      !isSafeDeepLinkState(value)
    ) {
      return false;
    }
    seen.add(key);
  }
  return true;
}

function migrationDeepLinkPath(source?: string, state?: string): string {
  const path = "/app/migrations/api-key";
  const params = new URLSearchParams();
  if (source) params.set("source", source);
  if (state) params.set("state", state);
  const query = params.toString();
  return query ? `${path}?${query}` : path;
}

function isSafeDeepLinkState(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= MAX_DEEP_LINK_STATE_CHARS &&
    OPAQUE_DEEP_LINK_VALUE_RE.test(value)
  );
}

function isSafeSubscriberTarget(value: string): boolean {
  if (!SUBSCRIBER_TARGET_RE.test(value)) return false;
  const atCount = value.match(/@/g)?.length ?? 0;
  if (atCount === 0) return RESOURCE_ID_RE.test(value);
  return (
    atCount === 1 &&
    !value.startsWith("@") &&
    !value.endsWith("@") &&
    !value.includes("..")
  );
}

/**
 * Combine a base URL with an optional path or deep-link.
 */
export function buildDashboardHref(
  base: string,
  pathOrDeepLink?: string | null,
): string {
  const root = safeDashboardOrigin(base) ?? DEFAULT_PROD_URL;
  if (!pathOrDeepLink) return root;

  if (/^https?:\/\//i.test(pathOrDeepLink)) {
    if (CONTROL_RE.test(pathOrDeepLink)) return root;
    const safe = safeDashboardOrigin(pathOrDeepLink);
    if (!safe) return root;
    try {
      const target = new URL(pathOrDeepLink);
      return target.origin === new URL(root).origin ? target.toString() : root;
    } catch {
      return root;
    }
  }

  if (/^postwave:\/\//i.test(pathOrDeepLink)) {
    const path = mapDeepLinkToPath(pathOrDeepLink);
    return path ? `${root}${path}` : root;
  }

  const safePath = safeDashboardPath(pathOrDeepLink);
  return safePath ? new URL(safePath, `${root}/`).toString() : root;
}

function safeDashboardPath(raw: string): string | null {
  if (!raw || raw.trim() !== raw || CONTROL_RE.test(raw)) return null;
  if (raw.includes("\\") || raw.startsWith("//")) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) return null;
  const path = raw.startsWith("/") ? raw : `/${raw}`;
  try {
    const parsed = new URL(path, "https://postwave.local");
    if (parsed.origin !== "https://postwave.local") return null;
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return null;
  }
}
