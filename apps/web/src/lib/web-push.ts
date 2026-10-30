// SPDX-License-Identifier: AGPL-3.0-only
//
// Browser Web Push subscription flow. The PWA service worker (src/app/sw.ts)
// previously did offline-cache only; this adds the client half of Web Push:
// request permission, subscribe via PushManager with the VAPID public key, and
// hand the subscription to the backend for storage.
//
// The feature is deployment-gated: fetchWebPushConfig asks the API for its
// VAPID public key and enabled flag, falling back to NEXT_PUBLIC_VAPID_PUBLIC_KEY
// for local/dev builds. When the API/key is absent the UI reports
// "not configured" instead of exposing a broken opt-in flow.

import { api } from "./api";

export type WebPushSupport = "supported" | "unsupported" | "no-vapid-key";

export type WebPushPermission = NotificationPermission; // "default" | "granted" | "denied"

/** Server endpoints used to register and remove this browser subscription. */
const SUBSCRIBE_PATH = "/api/v1/notifications/web-push/subscribe";
const UNSUBSCRIBE_PATH = "/api/v1/notifications/web-push/unsubscribe";
const REGISTERED_ENDPOINT_KEY = "postwave:web-push-registered-endpoint";

/** The VAPID application server public key, base64url, from env. */
export function vapidPublicKey(): string {
  return (process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY || "").trim();
}

/** Whether this BROWSER can do Web Push (server VAPID config is checked
 *  separately, async, via fetchWebPushConfig). */
export function webPushSupport(): WebPushSupport {
  if (
    typeof window === "undefined" ||
    typeof navigator === "undefined" ||
    !("serviceWorker" in navigator) ||
    typeof PushManager === "undefined" ||
    typeof Notification === "undefined"
  ) {
    return "unsupported";
  }
  return "supported";
}

interface WebPushConfig {
  enabled: boolean;
  publicKey: string;
}

let cachedConfig: WebPushConfig | null = null;

/**
 * Resolve the VAPID public key + whether push is configured, from the backend
 * (GET .../vapid-public-key), falling back to NEXT_PUBLIC_VAPID_PUBLIC_KEY.
 * Cached for the session.
 */
export async function fetchWebPushConfig(): Promise<WebPushConfig> {
  if (cachedConfig) return cachedConfig;
  const envKey = vapidPublicKey();
  try {
    const res = await api.get<{ enabled: boolean; public_key: string }>(
      "/api/v1/notifications/web-push/vapid-public-key",
    );
    const key = (res.public_key || "").trim() || envKey;
    cachedConfig = {
      enabled: Boolean(res.enabled) && key !== "",
      publicKey: key,
    };
  } catch {
    cachedConfig = { enabled: envKey !== "", publicKey: envKey };
  }
  return cachedConfig;
}

/** Send the current user a test push (round-trip check). Returns how many of
 *  their devices accepted it. */
export async function sendTestPush(): Promise<number> {
  const res = await api.post<{ delivered: number }>(
    "/api/v1/notifications/web-push/test",
  );
  return res.delivered ?? 0;
}

/** Current Notification permission, or "denied" where unsupported. */
export function currentPermission(): WebPushPermission {
  if (typeof Notification === "undefined") return "denied";
  return Notification.permission;
}

/**
 * Decode a base64url VAPID key into the Uint8Array PushManager.subscribe
 * expects for applicationServerKey.
 */
export function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  // Construct over a concrete ArrayBuffer so the result is a BufferSource
  // PushManager.subscribe's applicationServerKey accepts.
  const buf = new ArrayBuffer(raw.length);
  const out = new Uint8Array(buf);
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

/** Serialize a PushSubscription into the JSON the backend needs to send pushes. */
export function serializeSubscription(sub: PushSubscription): {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  expiration_time: number | null;
} {
  const json = sub.toJSON();
  return {
    endpoint: sub.endpoint,
    keys: {
      p256dh: json.keys?.p256dh ?? "",
      auth: json.keys?.auth ?? "",
    },
    expiration_time: sub.expirationTime ?? null,
  };
}

export interface SubscribeResult {
  status: "subscribed" | "denied" | "unsupported" | "no-vapid-key" | "error";
  subscription?: PushSubscription;
  message?: string;
}

/**
 * Request permission (if needed) and subscribe to Web Push. Registers the
 * resulting subscription with the backend. Safe to call when already
 * subscribed (returns the existing subscription).
 */
export async function subscribeToWebPush(): Promise<SubscribeResult> {
  if (webPushSupport() !== "supported") {
    return { status: "unsupported" };
  }
  const config = await fetchWebPushConfig();
  if (!config.enabled || !config.publicKey) {
    return { status: "no-vapid-key" };
  }

  let permission = currentPermission();
  if (permission === "default") {
    permission = await Notification.requestPermission();
  }
  if (permission !== "granted") {
    return { status: "denied" };
  }

  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(config.publicKey),
    });
  }

  // Register with the backend so server-side events can deliver a push.
  try {
    await api.post(SUBSCRIBE_PATH, serializeSubscription(sub));
  } catch (e) {
    // A browser-only subscription is unusable: the server cannot deliver to
    // it. Roll it back and report an error instead of showing a false success.
    await sub.unsubscribe().catch(() => false);
    forgetRegisteredEndpoint();
    return {
      status: "error",
      message:
        e instanceof Error ? e.message : "Backend registration unavailable",
    };
  }
  // Deliberately outside the try above. This is a local bookkeeping cache, not
  // the source of truth, and the server registration has already committed —
  // when it lived inside the try a QuotaExceededError (or storage blocked
  // entirely) rolled back a perfectly good subscription and reported failure.
  rememberRegisteredEndpoint(sub.endpoint);
  return { status: "subscribed", subscription: sub };
}

/** Unsubscribe locally and tell the backend to drop the subscription. */
export async function unsubscribeFromWebPush(): Promise<void> {
  if (webPushSupport() === "unsupported") return;
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (!sub) return;
  const endpoint = sub.endpoint;
  // Guarded: an unguarded removeItem threw before sub.unsubscribe() could run
  // whenever storage was inaccessible, making it impossible to unsubscribe at
  // all in Safari private mode or with site storage blocked by policy.
  forgetRegisteredEndpoint();
  try {
    await sub.unsubscribe();
  } finally {
    try {
      await api.post(UNSUBSCRIBE_PATH, { endpoint });
    } catch {
      /* best-effort — local unsubscribe already happened */
    }
  }
}

/** Whether the browser currently holds an active push subscription. */
export async function isSubscribed(): Promise<boolean> {
  if (webPushSupport() === "unsupported") return false;
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (!sub) return false;
    return readRegisteredEndpoint() === sub.endpoint;
  } catch {
    return false;
  }
}

// Reading `window.localStorage` can itself throw a SecurityError when site
// storage is blocked by policy, so access and operation are both guarded. This
// endpoint record is only a local cache of "did we register with the backend" —
// losing it must degrade the UI, never fail an operation.
function readRegisteredEndpoint(): string | null {
  try {
    if (typeof window === "undefined") return null;
    return window.localStorage.getItem(REGISTERED_ENDPOINT_KEY);
  } catch {
    return null;
  }
}

function rememberRegisteredEndpoint(endpoint: string): void {
  try {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(REGISTERED_ENDPOINT_KEY, endpoint);
  } catch {
    /* best-effort cache; isSubscribed() degrades to false */
  }
}

function forgetRegisteredEndpoint(): void {
  try {
    if (typeof window === "undefined") return;
    window.localStorage.removeItem(REGISTERED_ENDPOINT_KEY);
  } catch {
    /* nothing to forget */
  }
}
