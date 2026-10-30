// SPDX-License-Identifier: AGPL-3.0-only
//
// Pure (DOM/SW-global-free) routing + tagging helpers for the PWA service
// worker's Web Push handlers. Extracted out of sw.ts — which declares
// `/// <reference lib="webworker" />` and reaches for `self`/`clients`, neither
// of which exists in the node vitest environment — so the click-routing and
// notification-tag logic can be unit-tested. sw.ts is ordinary type-checked
// TypeScript (tsconfig includes `**/*.ts`); Serwist compiles it to /sw.js.

/** Notification data the SW stashes on showNotification({ data }). */
export interface PushNotificationData {
  /** Server-supplied click URL from the Go web-push sender. */
  url?: string;
}

const APP_HOME = "/app";
const MAX_CLICK_URL_LENGTH = 2_048;
const UNSAFE_URL_CHARACTERS = /[\\\u0000-\u001f\u007f]/;

function isSafeClickURL(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= MAX_CLICK_URL_LENGTH &&
    value === value.trim() &&
    !UNSAFE_URL_CHARACTERS.test(value)
  );
}

/**
 * Turn the sender-provided URL into a same-origin path. Absolute deployment
 * URLs keep their pathname/query; malformed or non-http values fall back home.
 */
export function resolveNotificationClickPath(
  data: PushNotificationData,
): string {
  const url = typeof data.url === "string" ? data.url : "";

  if (!isSafeClickURL(url)) return APP_HOME;

  // A protocol-relative URL (`//host/path`) is not an application path. A
  // backslash is rejected above because URL parsers can normalize it into a
  // slash before resolving the authority.
  if (url.startsWith("/") && !url.startsWith("//")) return url;
  try {
    const parsed = new URL(url);
    if (
      (parsed.protocol === "https:" || parsed.protocol === "http:") &&
      !parsed.username &&
      !parsed.password
    ) {
      return `${parsed.pathname}${parsed.search}${parsed.hash}`;
    }
  } catch {
    // Fall through to the dashboard home.
  }
  return APP_HOME;
}

/**
 * Resolve a previously sanitized click path against the service-worker origin.
 * This second check is intentionally kept at the navigation boundary so a
 * future routing change cannot accidentally turn a path into an external URL.
 */
export function resolveSameOriginNotificationTarget(
  path: string,
  origin: string,
): string {
  const base = new URL(origin);
  const fallback = new URL(APP_HOME, base);

  try {
    const target = new URL(path, base);
    return target.origin === base.origin ? target.href : fallback.href;
  } catch {
    return fallback.href;
  }
}
