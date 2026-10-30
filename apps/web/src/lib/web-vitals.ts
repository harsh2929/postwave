// SPDX-License-Identifier: AGPL-3.0-only
//
// Browser-side Core Web Vitals reporter.
//
// Metrics (CLS, FCP, FID/INP, LCP, TTFB) go to an optional ingest endpoint
// configured with NEXT_PUBLIC_WEB_VITALS_ENDPOINT. When unset, the reporter
// is a no-op so visitors do not pay for guaranteed 404 telemetry requests on
// installs that have not wired up an ingest pipeline yet.
//
// ONE REQUEST PER PAGE VIEW. This used to send a request per metric, and
// Next's hook also reports its own markers (Next.js-hydration, -render,
// -route-change-to-render) on every client-side navigation. The ingest
// endpoint allows 100 events per minute per IP, so a few tabs (or one office
// behind NAT) flooded it: 264 HTTP 429s in a four-browser run on staging, and
// the reporter kept sending into them. Now:
//
//   - only Core Web Vitals are kept (label "web-vital"); Next's markers are
//     not web vitals and were most of the volume;
//   - each metric's latest value is buffered by name, and the buffer is sent
//     as one JSON array when the page is hidden (visibilitychange) or
//     unloaded (pagehide) — the moments the library reports final values;
//   - a 429 backs this tab off for the server's Retry-After (60s when it is
//     not readable). The batch is dropped, never retried, and the back-off
//     is kept in sessionStorage so the next page load in the tab honours it.
//
// Transport: keepalive fetch, so the request survives unload like
// sendBeacon does but its status can be read; sendBeacon only where fetch
// cannot be used. Both send text/plain (what sendBeacon does with a string):
// a CORS-simple request, so a cross-origin endpoint costs no preflight. The
// server decodes the body as JSON whatever its content type.
//
// Cross-origin endpoints are only posted to from the app and site origins,
// which are the origins the ingest endpoint allows. Hosted form pages are
// served on their own origin (forms.<domain>): posting from there was
// refused by CORS on every load.

import { redactPath } from "@postwave/telemetry";

/**
 * Structural type for the metric object passed by `next/web-vitals`'s
 * `useReportWebVitals` hook. We deliberately keep this loose rather than
 * importing Next's internal `Metric` type — the public surface is stable but
 * the import path under `next/dist/compiled/web-vitals` is not.
 */
export interface WebVitalsMetric {
  id: string;
  name: string;
  label: "web-vital" | "custom" | string;
  value: number;
  startTime?: number;
  delta?: number;
  rating?: "good" | "needs-improvement" | "poor";
  navigationType?: string;
  attribution?: Record<string, unknown>;
}

interface ReportPayload {
  id: string;
  session_id: string;
  name: string;
  label: string;
  value: number;
  delta?: number;
  rating?: string;
  startTime?: number;
  navigationType?: string;
  page: string;
  ts: number;
}

const WEB_VITALS_SESSION_KEY = "postwave:web-vitals-session";
const BACKOFF_KEY = "postwave:web-vitals-backoff-until";
/** The server's window; used when its Retry-After is not readable (CORS). */
const DEFAULT_BACKOFF_MS = 60_000;
/** Never wait longer than this on a server's word. */
const MAX_BACKOFF_MS = 10 * 60_000;
/** The server refuses larger batches; a page view has about six vitals. */
const MAX_BATCH = 20;

let cachedSessionID = "";
/** Latest payload per metric name for the current page view. */
const pending = new Map<string, ReportPayload>();
let listening = false;
let lateFlushScheduled = false;
let backoffUntil = 0;

function buildPayload(metric: WebVitalsMetric): ReportPayload {
  const page = currentPageLocation();
  // Only `pathname` is shipped — `href` was previously included but
  // any future route that encodes an email in the path (magic-link,
  // unsubscribe) would have leaked it into the web-vitals sink.
  // pathname alone gives all the analytical signal needed for vitals
  // dashboards. Audit finding (frontend PII).
  return {
    id: metric.id,
    session_id: webVitalsSessionID(),
    name: metric.name,
    label: metric.label,
    value: metric.value,
    delta: metric.delta,
    rating: metric.rating,
    startTime: metric.startTime,
    navigationType: metric.navigationType,
    page: redactPath(page.pathname),
    ts: Date.now(),
  };
}

function webVitalsSessionID(): string {
  if (cachedSessionID) return cachedSessionID;
  if (typeof window === "undefined") return "";
  try {
    const stored = window.sessionStorage?.getItem(WEB_VITALS_SESSION_KEY);
    if (stored) {
      cachedSessionID = stored;
      return stored;
    }
  } catch {
    // Storage may be unavailable in privacy-restricted contexts.
  }
  cachedSessionID = newAnonymousSessionID();
  try {
    window.sessionStorage?.setItem(WEB_VITALS_SESSION_KEY, cachedSessionID);
  } catch {
    // The in-memory value still correlates this page session.
  }
  return cachedSessionID;
}

function newAnonymousSessionID(): string {
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    return crypto.randomUUID();
  }
  return `wv-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function currentPageLocation(): { pathname: string; href: string } {
  if (typeof window === "undefined") return { pathname: "", href: "" };
  const pathname = window.location.pathname || "";
  try {
    const url = new URL(window.location.href);
    url.search = "";
    url.hash = "";
    url.username = "";
    url.password = "";
    return { pathname, href: url.toString() };
  } catch {
    return { pathname, href: pathname };
  }
}

/**
 * Buffers a metric for this page view. Safe to call from any client
 * component; never throws and never sends on its own — the buffer goes out
 * once, when the page is hidden or unloaded.
 */
export function reportWebVitals(metric: WebVitalsMetric): void {
  if (typeof window === "undefined") return;
  const endpoint = resolveEndpoint();
  if (!endpoint || !mayReportFromThisOrigin(endpoint)) return;
  // Next's own markers are not web vitals, and were most of the traffic.
  if (metric.label !== "web-vital") return;

  let payload: ReportPayload;
  try {
    payload = buildPayload(metric);
  } catch {
    return;
  }
  // A later report of the same metric is its final value: keep only that.
  pending.set(metric.name, payload);
  listenForPageEnd();

  // CLS and INP report their final values from the library's own
  // visibilitychange listener. One that runs after ours lands here with the
  // page already hidden: send it after the event instead of holding it until
  // the next hide, which may never come.
  if (isHidden() && !lateFlushScheduled) {
    lateFlushScheduled = true;
    setTimeout(() => {
      lateFlushScheduled = false;
      flush("fetch");
    }, 0);
  }
}

function isHidden(): boolean {
  try {
    return document.visibilityState === "hidden";
  } catch {
    return false;
  }
}

function listenForPageEnd(): void {
  if (listening) return;
  listening = true;
  // Registered on first report, i.e. after next/web-vitals registered its own
  // hidden listeners, so on the same event ours runs after theirs and sees
  // the final values.
  window.addEventListener("visibilitychange", () => {
    if (isHidden()) flush("fetch");
  });
  // Safari does not always fire visibilitychange on unload. The page is
  // going away, so there is no response to read: sendBeacon is the most
  // reliable carrier here.
  window.addEventListener("pagehide", () => flush("beacon"));
}

function flush(preferred: "fetch" | "beacon"): void {
  if (pending.size === 0) return;
  const endpoint = resolveEndpoint();
  const events = [...pending.values()].slice(0, MAX_BATCH);
  pending.clear();
  if (!endpoint || backingOff()) return;

  let body: string;
  try {
    body = JSON.stringify(events);
  } catch {
    // If stringify fails for any reason (circular ref, exotic value),
    // drop the batch rather than throw into the user's session.
    return;
  }
  if (preferred === "beacon" && beacon(endpoint, body)) return;
  if (post(endpoint, body)) return;
  if (preferred === "fetch") beacon(endpoint, body);
}

function beacon(endpoint: string, body: string): boolean {
  if (
    typeof navigator === "undefined" ||
    typeof navigator.sendBeacon !== "function"
  ) {
    return false;
  }
  try {
    // A string body goes out as text/plain: no CORS preflight.
    return navigator.sendBeacon(endpoint, body);
  } catch {
    return false;
  }
}

function post(endpoint: string, body: string): boolean {
  if (typeof fetch !== "function") return false;
  try {
    void fetch(endpoint, {
      method: "POST",
      body,
      headers: { "Content-Type": "text/plain;charset=UTF-8" },
      // Survives page unload like sendBeacon, but its status is readable.
      keepalive: true,
      // Don't send credentials — perf metrics are anonymous.
      credentials: "omit",
    })
      .then((response) => {
        if (response.status === 429) backOff(response);
      })
      .catch(() => {
        // Telemetry must never raise into the user's session, and a failed
        // batch is not worth a second request.
      });
    return true;
  } catch {
    return false;
  }
}

function backingOff(): boolean {
  const now = Date.now();
  if (backoffUntil > now) return true;
  try {
    const stored = Number(window.sessionStorage?.getItem(BACKOFF_KEY));
    if (Number.isFinite(stored) && stored > now) {
      backoffUntil = Math.min(stored, now + MAX_BACKOFF_MS);
      return true;
    }
  } catch {
    // The in-memory deadline still applies to this page.
  }
  return false;
}

function backOff(response: Response): void {
  let waitMs = DEFAULT_BACKOFF_MS;
  // Only readable when the server exposes it; cross-origin it usually isn't.
  const retryAfter = Number(response.headers?.get?.("Retry-After"));
  if (Number.isFinite(retryAfter) && retryAfter > 0) {
    waitMs = Math.min(retryAfter * 1000, MAX_BACKOFF_MS);
  }
  backoffUntil = Date.now() + waitMs;
  try {
    window.sessionStorage?.setItem(BACKOFF_KEY, String(backoffUntil));
  } catch {
    // In-memory only.
  }
}

/**
 * A cross-origin endpoint only accepts the app and site origins (the API's
 * web-vitals CORS allow-list). From any other origin — hosted forms on
 * forms.<domain>, above all — the browser refuses the request, so don't
 * make it. Same-origin endpoints, and installs that configure neither
 * origin, report as before.
 */
function mayReportFromThisOrigin(endpoint: string): boolean {
  let here: string;
  let target: string;
  try {
    here = new URL(window.location.href).origin;
    target = new URL(endpoint, window.location.href).origin;
  } catch {
    return false;
  }
  if (target === here) return true;
  const allowed = [
    process.env.NEXT_PUBLIC_APP_URL,
    process.env.NEXT_PUBLIC_SITE_URL,
  ]
    .map(originOf)
    .filter((origin): origin is string => origin !== null);
  return allowed.length === 0 || allowed.includes(here);
}

function originOf(raw: string | undefined): string | null {
  if (!raw?.trim()) return null;
  try {
    return new URL(raw.trim()).origin;
  } catch {
    return null;
  }
}

function resolveEndpoint(): string | null {
  const endpoint = process.env.NEXT_PUBLIC_WEB_VITALS_ENDPOINT?.trim();
  if (!endpoint) return null;
  if (endpoint.startsWith("/") && !endpoint.startsWith("//")) {
    return /[\r\n\x00]/.test(endpoint) ? null : endpoint;
  }
  try {
    const url = new URL(endpoint);
    if (url.username || url.password) return null;
    if (url.protocol !== "https:" && !isLocalHttpURL(url)) return null;
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function isLocalHttpURL(url: URL): boolean {
  const host = url.hostname.toLowerCase();
  return (
    url.protocol === "http:" &&
    (host === "localhost" ||
      host === "127.0.0.1" ||
      host === "::1" ||
      host === "[::1]")
  );
}
