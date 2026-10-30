// SPDX-License-Identifier: AGPL-3.0-only
/// <reference lib="webworker" />

/**
 * Moosewave PWA service worker — Serwist-powered.
 *
 * Routes (in order of evaluation):
 *   0. Not handled at all (the fetch listener registered before Serwist's):
 *      event streams, and every non-navigation request the worker could
 *      neither cache nor rescue (authenticated /api, RSC payloads,
 *      cross-origin) — the browser fetches those itself
 *   1. CacheFirst for reviewed static assets (Next JS chunks bypass the worker)
 *   2. StaleWhileRevalidate (60s) for public archive /api GETs
 *   3. Network-only for authenticated /api (TanStack Query owns offline)
 *   4. Network-only for auth-sensitive pages and payloads
 *   5. NetworkFirst (3s timeout) for public navigations, /offline fallback
 *   6. Terminal deny: anything not positively cacheable is network-only
 *   Since step 0, only page loads reach 3, 4 and 6 (and a failed one still
 *   gets the /offline fallback); for every other request they are defensive,
 *   kept so a change to step 0 cannot let such a request fall through to
 *   defaultCache's catch-alls.
 *
 * IMPORTANT: this file does NOT call self.skipWaiting() — the new SW
 * waits for the user to confirm via the "Update available — Refresh"
 * toast. PwaRegistrar receives the `waiting` event and orchestrates the
 * UX. Forcing skipWaiting causes asset/runtime version mismatches.
 * The flip side: a change to the routing here reaches a tab only once the new
 * worker activates, i.e. after the user accepts that toast or every tab of the
 * origin has closed. Until then the old worker keeps its old routing,
 * including the stream proxying step 0 exists to stop.
 *
 * Navigation Preload is enabled by Serwist's default configuration.
 */

import { defaultCache } from "@serwist/next/worker";
import type { PrecacheEntry, SerwistGlobalConfig } from "serwist";
import {
  CacheFirst,
  ExpirationPlugin,
  NetworkFirst,
  NetworkOnly,
  Serwist,
  StaleWhileRevalidate,
} from "serwist";

import {
  resolveNotificationClickPath,
  resolveSameOriginNotificationTarget,
} from "./sw-notification-routing";
import {
  isAuthenticatedApiRequest,
  isAuthSensitiveRequest,
  isCacheCandidate,
  isPublicArchiveApiCacheCandidate,
  isStaticAssetCacheCandidate,
  shouldBypassServiceWorker,
  shouldCacheNavigation,
} from "./sw-cache-policy";

declare global {
  interface WorkerGlobalScope extends SerwistGlobalConfig {
    __SW_MANIFEST: (PrecacheEntry | string)[] | undefined;
  }
}

declare const self: ServiceWorkerGlobalScope & {
  __SW_MANIFEST: (PrecacheEntry | string)[] | undefined;
};

type TaggedExtendableEvent = ExtendableEvent & { tag: string };
type JsonPushMessageData = {
  title?: unknown;
  body?: unknown;
  tag?: unknown;
  url?: unknown;
  icon?: unknown;
  // Cross-channel notification identity: the server's notification_feed row
  // id, shared by the in-app feed, mobile push, and SSE deliveries of the
  // same logical notification (Apple-level integration, fix-now #3).
  notification_id?: unknown;
  event?: unknown;
};
type PostwaveNotificationData = {
  url?: unknown;
  notificationId?: unknown;
};
type NotificationClickEvent = ExtendableEvent & {
  notification: Notification & { data?: PostwaveNotificationData };
};
type NavigableWindowClient = WindowClient & {
  navigate?: (url: string) => Promise<WindowClient | null>;
};

const serwist = new Serwist({
  precacheEntries: self.__SW_MANIFEST,
  // Critical: do NOT skipWaiting; the registrar shows a toast and the
  // user pulls the trigger via postMessage({type:'SKIP_WAITING'}).
  skipWaiting: false,
  clientsClaim: true,
  navigationPreload: true,
  disableDevLogs: true,
  runtimeCaching: [
    // 1) Reviewed static assets — CacheFirst. Content-hashed Next JS chunks
    // bypass the worker so preload and execution requests share one HTTP cache.
    {
      matcher: ({ request, url }) => isStaticAssetCacheCandidate(request, url),
      handler: new CacheFirst({
        cacheName: "postwave-static-v1",
        plugins: [
          new ExpirationPlugin({
            maxEntries: 256,
            maxAgeSeconds: 60 * 60 * 24 * 30, // 30 days
          }),
        ],
      }),
    },
    // 2) Public archive endpoints — StaleWhileRevalidate, 60s.
    {
      matcher: ({ url, request }) =>
        isPublicArchiveApiCacheCandidate(request, url),
      handler: new StaleWhileRevalidate({
        cacheName: "postwave-public-api-v1",
        plugins: [
          new ExpirationPlugin({
            maxEntries: 128,
            maxAgeSeconds: 60, // 60s
            purgeOnQuotaError: true,
          }),
        ],
      }),
    },
    // 3) Authenticated /api — NETWORK ONLY. TanStack Query owns the
    //    offline cache; serving stale auth data from the SW could
    //    cross tenant boundaries.
    {
      matcher: ({ url, request }) => isAuthenticatedApiRequest(request, url),
      handler: new NetworkOnly(),
    },
    // 4) Authenticated/auth-flow requests — NETWORK ONLY. Page HTML and RSC
    // payloads carry tenant/user-specific state and must not be served stale
    // after logout, workspace switch, or role change. This deliberately does
    // NOT test request.mode: Next fetches RSC payloads and <Link> prefetches
    // with mode "cors", so a navigate-only matcher lets every client-side
    // navigation inside /app through to the caching rules below it.
    {
      matcher: ({ request, url }) => isAuthSensitiveRequest(request, url),
      handler: new NetworkOnly(),
    },
    // 5) Public navigations — NetworkFirst, 3s timeout, /offline fallback.
    {
      matcher: ({ request, url }) => shouldCacheNavigation(request, url),
      handler: new NetworkFirst({
        cacheName: "postwave-pages-v1",
        networkTimeoutSeconds: 3,
        plugins: [
          new ExpirationPlugin({
            maxEntries: 32,
            maxAgeSeconds: 60 * 60 * 24, // 24h
          }),
        ],
      }),
    },
    // 6) TERMINAL DENY. Serwist matches first-rule-wins with fall-through: a
    // request the rules above REFUSE is not network-only, it keeps falling
    // until something matches. `defaultCache` ends in two catch-alls that
    // store every same-origin non-/api GET (one keyed on the RSC header, one
    // on nothing at all) in a 24h NetworkFirst cache. That turned the
    // allow-list above into a preference: `shouldCacheNavigation` returning
    // false for `/accept-invite?token=…` only meant the response was cached one
    // rule later, keyed by the URL including the credential. Cache Storage
    // ignores Cache-Control, so `no-store` did not prevent the write either.
    //
    // Anything the allow-list did not positively accept stops here.
    {
      matcher: ({ request, url }) => !isCacheCandidate(request, url),
      handler: new NetworkOnly(),
    },
    ...defaultCache,
  ],
  fallbacks: {
    entries: [
      {
        url: "/offline",
        matcher({ request }) {
          return request.destination === "document";
        },
      },
    ],
  },
});

// Bridge for the existing offline outbox flush, kept compatible with
// the legacy sw.js so currently-installed clients keep working through
// the upgrade.
self.addEventListener("sync", (event: TaggedExtendableEvent) => {
  if (event.tag !== "postwave-offline-flush") return;
  event.waitUntil(notifyClientsToFlushQueue());
});

// `periodicsync` is supported in Chromium service workers but is not yet in
// TypeScript's ServiceWorkerGlobalScopeEventMap.
self.addEventListener("periodicsync", ((event: Event) => {
  const syncEvent = event as TaggedExtendableEvent;
  if (syncEvent.tag !== "postwave-offline-flush") return;
  syncEvent.waitUntil(notifyClientsToFlushQueue());
}) as EventListener);

self.addEventListener("message", (event: ExtendableMessageEvent) => {
  if (event.data?.type === "SKIP_WAITING") {
    void (self as ServiceWorkerGlobalScope).skipWaiting();
  }
});

// ---------------------------------------------------------------------------
// Web Push. The Go sender's contract is deliberately small and explicit:
// {title, body, url, icon, tag, notification_id, event}. Keep the service
// worker aligned with that wire shape instead of maintaining an unreachable
// second event renderer. notification_id is the cross-channel identity (the
// server feed row id) — carried into the shown notification's data so click
// handling and future read-sync can reference the same logical notification
// every other channel carries.
self.addEventListener("push", (event: PushEvent) => {
  let data: JsonPushMessageData = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    // Non-JSON payload — render the generic notification.
    data = {};
  }

  event.waitUntil(
    (self as ServiceWorkerGlobalScope).registration.showNotification(
      typeof data.title === "string" && data.title ? data.title : "Moosewave",
      {
        body: typeof data.body === "string" ? data.body : "",
        tag: typeof data.tag === "string" ? data.tag : undefined,
        data: {
          url: typeof data.url === "string" ? data.url : "",
          notificationId:
            typeof data.notification_id === "string"
              ? data.notification_id
              : "",
        },
        icon:
          typeof data.icon === "string" && data.icon
            ? data.icon
            : "/icons/icon-192.png",
        badge: "/icons/badge-72.png",
      },
    ),
  );
});

self.addEventListener("notificationclick", (event: NotificationClickEvent) => {
  event.notification.close();
  const data = event.notification.data || {};

  const path = resolveNotificationClickPath(data);

  event.waitUntil(focusOrOpen(path));
});

// Focus an existing client on the target path, else open a new window. Matches
// any same-origin client first so a click reuses the open dashboard tab.
async function focusOrOpen(path: string): Promise<void> {
  const scope = self as ServiceWorkerGlobalScope;
  const target = resolveSameOriginNotificationTarget(
    path,
    scope.location.origin,
  );
  const clients = await scope.clients.matchAll({
    includeUncontrolled: true,
    type: "window",
  });
  for (const client of clients) {
    // Reuse any open dashboard tab; navigate it to the target if possible.
    if ("focus" in client) {
      try {
        if ("navigate" in client && client.url !== target) {
          await (client as NavigableWindowClient).navigate?.(target);
        }
      } catch {
        /* navigate can reject cross-origin — fall through to focus */
      }
      return void (await client.focus());
    }
  }
  if (scope.clients.openWindow) {
    await scope.clients.openWindow(target);
  }
}

async function notifyClientsToFlushQueue(): Promise<void> {
  const clients = await (self as ServiceWorkerGlobalScope).clients.matchAll({
    includeUncontrolled: true,
    type: "window",
  });
  await Promise.all(
    clients.map((client) =>
      client.postMessage({ type: "POSTWAVE_FLUSH_OFFLINE_QUEUE" }),
    ),
  );
}

// Requests the worker cannot cache or rescue — event streams above all — are
// handed back to the browser before Serwist sees them. Listeners run in the
// order they were added, so this one must be registered before
// serwist.addEventListeners(); not calling respondWith lets the browser fetch
// the request itself, and stopping propagation keeps Serwist's listener from
// proxying it anyway. See shouldBypassServiceWorker for why.
self.addEventListener("fetch", (event: FetchEvent) => {
  if (!shouldBypassServiceWorker(event.request, new URL(event.request.url))) {
    return;
  }
  event.stopImmediatePropagation();
});

serwist.addEventListeners();
