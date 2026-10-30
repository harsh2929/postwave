/**
 * Tiny pub-sub around the native deep-link security boundary.
 *
 * Rust owns the OS plugin and does all untrusted parsing before emitting a
 * canonical URL. Renderer code deliberately has no direct access to the
 * deep-link plugin, so cold-start and live URLs cannot bypass that gate.
 */

import { listen } from "@tauri-apps/api/event";

import {
  inspectDesktopAuthLink,
  type AuthLinkContractFailure,
  type AuthLinkFlow,
} from "./auth-link-contract";
import {
  getDesktopRouteSnapshot,
  subscribeDesktopRoute,
} from "./desktop-router";
import { isTauri, tauriApi } from "./tauri";

export type DeepLinkHandler = (url: string) => void;
export interface DeepLinkRejection {
  reason: AuthLinkContractFailure;
  flow: AuthLinkFlow | null;
}
export type DeepLinkRejectionHandler = (rejection: DeepLinkRejection) => void;
export type Unsubscribe = () => void;

const handlers = new Set<DeepLinkHandler>();
const rejectionHandlers = new Set<DeepLinkRejectionHandler>();
let pluginAttached = false;
let lastUrl = "";
let lastUrlAt = 0;

/* ------------------------------------------------------------------ */
/*  Pending deep-link target handoff                                    */
/* ------------------------------------------------------------------ */

/**
 * Single-slot handoff for the resource id carried by a deep link
 * (e.g. `moosewave://approval/abc123`). App.tsx routes the link to a
 * section synchronously, but the section page mounts later — it calls
 * `consumePendingDeepLinkTarget()` on mount to pick up the specific
 * resource instead of landing on the generic list.
 */
let pendingDeepLinkTarget: { section: string; id: string } | null = null;
let pendingRouteRevision: number | null = null;
let consumedRouteRevision: number | null = null;
const pendingDeepLinkTargetHandlers = new Set<
  (target: { section: string; id: string }) => void
>();

export function setPendingDeepLinkTarget(t: {
  section: string;
  id: string;
}): void {
  pendingDeepLinkTarget = t;
  pendingRouteRevision = null;
  for (const handler of pendingDeepLinkTargetHandlers) {
    handler(t);
  }
}

/** Consumed once — a second call returns null until a new link arrives. */
export function consumePendingDeepLinkTarget(): {
  section: string;
  id: string;
} | null {
  const t = pendingDeepLinkTarget;
  if (t) {
    pendingDeepLinkTarget = null;
    if (pendingRouteRevision !== null) {
      consumedRouteRevision = pendingRouteRevision;
    }
    pendingRouteRevision = null;
    return t;
  }

  // Reload/application-reopen can begin on a resource route before any live
  // native event exists. Let the destination consume that typed route once,
  // preserving the established handoff API while avoiding a second route
  // state store.
  const snapshot = getDesktopRouteSnapshot();
  if (
    snapshot.route.resourceId &&
    consumedRouteRevision !== snapshot.revision
  ) {
    consumedRouteRevision = snapshot.revision;
    return {
      section: snapshot.route.section,
      id: snapshot.route.resourceId,
    };
  }
  return null;
}

export function onPendingDeepLinkTarget(
  handler: (target: { section: string; id: string }) => void,
): Unsubscribe {
  pendingDeepLinkTargetHandlers.add(handler);
  return () => {
    pendingDeepLinkTargetHandlers.delete(handler);
  };
}

// Route-backed resources and native deep links converge here. The listener is
// registered before application navigation begins, so same-section resource
// changes notify already-mounted pages and section changes seed the pending
// handoff before the destination's mount effect runs.
subscribeDesktopRoute(() => {
  const snapshot = getDesktopRouteSnapshot();
  const id = snapshot.route.resourceId;
  if (!id) return;
  pendingDeepLinkTarget = { section: snapshot.route.section, id };
  pendingRouteRevision = snapshot.revision;
  for (const handler of pendingDeepLinkTargetHandlers) {
    handler(pendingDeepLinkTarget);
  }
});

/**
 * Subscribe to incoming deep-link URLs. Returns an unsubscribe function.
 *
 * The first call lazily wires up the underlying Tauri plugin listener; the
 * listener stays attached for the lifetime of the page (cleanup happens when
 * the webview is destroyed).
 */
export function onDeepLink(handler: DeepLinkHandler): Unsubscribe {
  handlers.add(handler);

  if (isTauri() && !pluginAttached) {
    pluginAttached = true;
    void attachPluginListener();
  }

  return () => {
    handlers.delete(handler);
  };
}

/** Subscribe to redacted native auth-link rejections. */
export function onDeepLinkRejection(
  handler: DeepLinkRejectionHandler,
): Unsubscribe {
  rejectionHandlers.add(handler);

  if (isTauri() && !pluginAttached) {
    pluginAttached = true;
    void attachPluginListener();
  }

  return () => {
    rejectionHandlers.delete(handler);
  };
}

/**
 * Manually feed a URL into the deep-link bus. Useful for testing and for
 * surfacing tray-menu events the same way as native deep-links.
 */
export function emitDeepLink(url: string): void {
  const now = Date.now();
  if (url === lastUrl && now - lastUrlAt < 750) {
    return;
  }
  lastUrl = url;
  lastUrlAt = now;

  for (const handler of handlers) {
    try {
      handler(url);
    } catch {
      // Don't let a bad subscriber break the others.
      // eslint-disable-next-line no-console
      console.error("[postwave-desktop] deep-link handler threw");
    }
  }
}

async function attachPluginListener(): Promise<void> {
  try {
    // Attach FIRST, then tell Rust the renderer is ready. Rust drains its
    // bounded cold-start queue under the same mutex it uses for live events,
    // which closes the listener-registration race without calling the plugin
    // from this less-trusted layer.
    await listen<unknown[]>("deep-link://opened", (event) => {
      if (!Array.isArray(event.payload)) return;
      for (const message of event.payload) {
        processNativeDeepLinkMessage(message);
      }
    });
    const pending = await tauriApi.takePendingDeepLinks();
    for (const message of pending) processNativeDeepLinkMessage(message);
  } catch {
    // eslint-disable-next-line no-console
    console.warn("[postwave-desktop] failed to attach deep-link listener");
  }
}

const NATIVE_ACTIONS = new Set([
  "approval",
  "subscriber",
  "campaign",
  "sequence",
  "settings",
  "auth",
  "migrations",
]);
const MAX_NATIVE_DEEP_LINK_BYTES = 8 * 1024;

function processNativeDeepLinkMessage(message: unknown): void {
  // Rolling/dev compatibility for an older native binary that returned bare
  // canonical strings. Current binaries always send the tagged envelope.
  if (typeof message === "string") {
    if (isValidatedNativeDeepLink(message)) emitDeepLink(message);
    return;
  }
  if (!message || typeof message !== "object" || Array.isArray(message)) return;
  const record = message as Record<string, unknown>;
  if (record.kind === "opened") {
    if (isValidatedNativeDeepLink(record.url)) emitDeepLink(record.url);
    return;
  }
  if (record.kind !== "rejected") return;
  if (!isAuthLinkContractFailure(record.reason)) return;
  if (
    record.flow !== null &&
    record.flow !== "magic" &&
    record.flow !== "reset"
  ) {
    return;
  }
  const rejection: DeepLinkRejection = {
    reason: record.reason,
    flow: record.flow,
  };
  for (const handler of rejectionHandlers) {
    try {
      handler(rejection);
    } catch {
      // eslint-disable-next-line no-console
      console.error("[postwave-desktop] deep-link rejection handler threw");
    }
  }
}

function isAuthLinkContractFailure(
  value: unknown,
): value is AuthLinkContractFailure {
  return (
    value === "invalid_link" ||
    value === "unsupported_version" ||
    value === "wrong_device" ||
    value === "wrong_flow" ||
    value === "invalid_signature"
  );
}

function isValidatedNativeDeepLink(rawUrl: unknown): rawUrl is string {
  if (typeof rawUrl !== "string" || rawUrl.length === 0) return false;
  if (new TextEncoder().encode(rawUrl).byteLength > MAX_NATIVE_DEEP_LINK_BYTES)
    return false;
  if (rawUrl.trim() !== rawUrl || rawUrl.includes("\\")) return false;
  try {
    const parsed = new URL(rawUrl);
    const validEnvelope =
      parsed.protocol === "postwave:" &&
      NATIVE_ACTIONS.has(parsed.hostname) &&
      !parsed.username &&
      !parsed.password &&
      !parsed.port &&
      !parsed.hash;
    if (!validEnvelope) return false;
    if (parsed.hostname !== "auth") return true;
    return inspectDesktopAuthLink(rawUrl).kind === "valid";
  } catch {
    return false;
  }
}
