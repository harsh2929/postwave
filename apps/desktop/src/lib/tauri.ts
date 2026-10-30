/**
 * Typed wrapper around the Tauri 2 IPC commands exposed by the Rust shell.
 *
 * Every function gracefully degrades when the bundle is loaded outside Tauri
 * (e.g. opened directly in a browser via `vite dev`):
 *   - read-only commands return null / sensible defaults,
 *   - side-effecting commands either no-op or fall back to a web equivalent
 *     (e.g. `showNotification` uses the Web Notifications API).
 *
 * Command names + payloads must match the Rust `#[tauri::command]` signatures
 * declared by the parallel agent in `apps/desktop/src-tauri/src/`.
 */

import { Channel, invoke } from "@tauri-apps/api/core";

export type Platform =
  | "macos"
  | "windows"
  | "linux"
  | "ios"
  | "android"
  | "unknown";

export interface AppVersion {
  version: string;
  commit?: string;
}

export interface NativeWindowLifecycleSnapshot {
  closeRequested: boolean;
  quitRequested: boolean;
  osShutdownRequested: boolean;
  recoveredInterruptedShutdown: boolean;
}

export interface DesktopWindowContext {
  title: string;
  authenticated: boolean;
  canCompose: boolean;
  activeSection: "dashboard" | "approvals" | "settings" | "other";
}

/** One-shot, privacy-safe marker recovered after a native Rust panic. */
export interface NativeCrashRecord {
  incidentId: string;
  occurredAtMs: number;
  kind: "native_panic";
  location: string | null;
}

export interface RendererDiagnosticRecord {
  incidentId: string;
  occurredAtMs: number;
  kind:
    | "renderer_boundary"
    | "window_error"
    | "unhandled_rejection"
    | "bootstrap_failure";
  errorType: string;
  errorCode: string | null;
  componentTrace: string[];
  safeMode: boolean;
}

/**
 * Native notification payload.
 *
 * `activationId` is deliberately only the encrypted Notification Center's
 * opaque 16-hex row id. Native code never receives a resource id, tenant,
 * email address or deep link; activation resolves against the currently
 * decrypted identity after the window is focused.
 */
export interface NotificationOptions {
  title: string;
  body: string;
  activationId?: string;
}

export type DesktopNotificationPermission =
  | "granted"
  | "denied"
  | "default"
  | "unsupported";

export interface NativeApiBrokerStatus {
  configured: boolean;
  baseUrl: string | null;
  credentialFingerprint: string | null;
  legacyReentryRequired: boolean;
}

/** Non-secret native session transport metadata. Cookie values never cross IPC. */
export interface NativeSessionBrokerStatus {
  baseUrl: string;
}

export interface WorkspaceCredentialStatus {
  id: string;
  configured: boolean;
  legacyReentryRequired: boolean;
}

interface NativeApiBrokerResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: number[];
}

interface NativeApiBrokerResponseHead {
  status: number;
  statusText: string;
  headers: Record<string, string>;
}

type NativeApiBrokerStreamSignal =
  | { event: "complete" }
  | { event: "error"; message: string };

let nativeApiStatus: NativeApiBrokerStatus = {
  configured: false,
  baseUrl: null,
  credentialFingerprint: null,
  legacyReentryRequired: false,
};

let nativeSessionStatus: NativeSessionBrokerStatus | null = null;

/* ---------------- auto-update (env-gated, see src-tauri/src/updater.rs) */

export type UpdateCheckStatus = "not_configured" | "up_to_date" | "available";
export type UpdateCheckSource = "manual" | "scheduled";
export type UpdateSeverity =
  | "informational"
  | "recommended"
  | "important"
  | "critical";

/** Mirror of Rust `UpdateInfo` — keep field names in lockstep. */
export interface UpdateCheckResult {
  status: UpdateCheckStatus;
  available: boolean;
  current_version: string;
  latest_version: string | null;
  notes: string | null;
  severity: UpdateSeverity;
  published_at: string | null;
  checked_at_ms: number;
  source: UpdateCheckSource;
}

/** Retained by Rust so scheduled results cannot race renderer startup. */
export interface NativeUpdateStateSnapshot {
  result: UpdateCheckResult | null;
  error: string | null;
  checked_at_ms: number;
  source: UpdateCheckSource;
}

export type InstallUpdateStatus = "not_configured" | "up_to_date" | "installed";

/** Mirror of Rust `InstallResult`. */
export interface InstallUpdateResult {
  status: InstallUpdateStatus;
  version: string | null;
}

const NOT_CONFIGURED_UPDATE: UpdateCheckResult = {
  status: "not_configured",
  available: false,
  current_version: "",
  latest_version: null,
  notes: null,
  severity: "recommended",
  published_at: null,
  checked_at_ms: 0,
  source: "manual",
};

/**
 * Internal: are we running inside the Tauri webview?
 *
 * Tauri 2 sets `window.__TAURI_INTERNALS__`. We check for that rather than
 * the legacy `__TAURI__` global which is no longer present by default.
 */
export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/**
 * Best-effort wrapper around `invoke` that swallows "not in Tauri" errors and
 * surfaces real command failures. The fallback runs when not in Tauri.
 */
async function safeInvoke<T>(
  command: string,
  args: Record<string, unknown> | undefined,
  fallback: () => T | Promise<T>,
): Promise<T> {
  if (!isTauri()) return fallback();
  try {
    return (await invoke<T>(command, args)) as T;
  } catch (err) {
    // Re-throw real IPC errors so callers can decide what to do.
    throw new TauriCommandError(command, err);
  }
}

export class TauriCommandError extends Error {
  readonly command: string;
  override readonly cause: unknown;
  constructor(command: string, cause: unknown) {
    super(`Tauri command \`${command}\` failed: ${describe(cause)}`);
    this.name = "TauriCommandError";
    this.command = command;
    this.cause = cause;
  }
}

function isSafeNotificationCopy(options: NotificationOptions): boolean {
  const control = /[\u0000-\u001f\u007f]/u;
  return (
    options.title.length > 0 &&
    options.title.length <= 120 &&
    options.title.trim() === options.title &&
    !control.test(options.title) &&
    options.body.length > 0 &&
    options.body.length <= 280 &&
    options.body.trim() === options.body &&
    !control.test(options.body) &&
    (options.activationId === undefined ||
      /^[0-9a-f]{16}$/u.test(options.activationId))
  );
}

function describe(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

function responseFromNative(result: NativeApiBrokerResponse): Response {
  const body = [204, 205, 304].includes(result.status)
    ? null
    : new Uint8Array(result.body).buffer;
  return new Response(body, {
    status: result.status,
    statusText: result.statusText,
    headers: result.headers,
  });
}

function nativeApiTarget(url: string, baseUrl: string): URL | null {
  try {
    const target = new URL(url);
    const base = new URL(baseUrl);
    if (target.origin !== base.origin || target.username || target.password) {
      return null;
    }
    const basePath = base.pathname.replace(/\/+$/u, "");
    const apiPrefix = basePath ? `${basePath}/api/` : "/api/";
    return target.pathname.startsWith(apiPrefix) ? target : null;
  } catch {
    return null;
  }
}

async function fetchWithNativeStream(
  command: "api_broker_stream_request" | "session_broker_stream_request",
  cancelCommand: "api_broker_cancel" | "session_broker_cancel",
  unavailableMessage: string,
  baseUrl: string,
  url: string,
  init: RequestInit,
): Promise<Response | null> {
  if (!isTauri()) return null;
  const target = nativeApiTarget(url, baseUrl);
  if (!target) return null;
  const callerHeaders = new Headers(init.headers);
  if (callerHeaders.has("Authorization") || callerHeaders.has("Cookie")) {
    return null;
  }
  // Rust owns every credential-bearing or device-identity header. Removing
  // renderer copies here keeps ordinary shared request helpers compatible;
  // Rust validates the remaining map again before dispatch.
  callerHeaders.delete("X-Postwave-Client");
  callerHeaders.delete("X-Postwave-Version");
  callerHeaders.delete("User-Agent");
  if (init.signal?.aborted) throw new DOMException("Aborted", "AbortError");

  const method = (init.method ?? "GET").toUpperCase();
  let body: number[] = [];
  let headers = callerHeaders;
  if (init.body != null) {
    const normalized = new Request(url, {
      method,
      headers: callerHeaders,
      body: init.body,
    });
    headers = normalized.headers;
    body = Array.from(new Uint8Array(await normalized.arrayBuffer()));
  }
  const headerRecord: Record<string, string> = {};
  headers.forEach((value, name) => {
    headerRecord[name] = value;
  });
  const timeoutMs = Number(
    (init as RequestInit & { __postwaveTimeoutMs?: number })
      .__postwaveTimeoutMs ?? 30_000,
  );
  const requestId =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const cancelNative = (): void => {
    void safeInvoke<void>(cancelCommand, { requestId }, () => undefined).catch(
      () => undefined,
    );
  };

  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let settled = false;
  const cleanup = (): void => {
    init.signal?.removeEventListener("abort", onAbort);
  };
  const onAbort = (): void => {
    if (!settled) {
      settled = true;
      controller.error(new DOMException("Aborted", "AbortError"));
    }
    cleanup();
    cancelNative();
  };
  const stream = new ReadableStream<Uint8Array>({
    start(nextController) {
      controller = nextController;
    },
    cancel() {
      if (!settled) {
        settled = true;
        cleanup();
        cancelNative();
      }
    },
  });
  const onEvent = new Channel<
    ArrayBuffer | Uint8Array | number[] | NativeApiBrokerStreamSignal
  >((event) => {
    if (settled) return;
    if (
      !(event instanceof ArrayBuffer) &&
      !(event instanceof Uint8Array) &&
      !Array.isArray(event)
    ) {
      settled = true;
      cleanup();
      if (event.event === "complete") controller.close();
      else controller.error(new Error(event.message));
      return;
    }
    const bytes =
      event instanceof ArrayBuffer
        ? new Uint8Array(event)
        : event instanceof Uint8Array
          ? event
          : new Uint8Array(event);
    controller.enqueue(bytes);
  });
  init.signal?.addEventListener("abort", onAbort, { once: true });
  if (init.signal?.aborted) {
    onAbort();
    throw new DOMException("Aborted", "AbortError");
  }

  let head: NativeApiBrokerResponseHead;
  try {
    head = await safeInvoke<NativeApiBrokerResponseHead>(
      command,
      {
        request: {
          requestId,
          url: target.toString(),
          method,
          headers: headerRecord,
          body,
          timeoutMs,
        },
        onEvent,
      },
      () => {
        throw new Error(unavailableMessage);
      },
    );
  } catch (error) {
    const surfacedError = init.signal?.aborted
      ? new DOMException("Aborted", "AbortError")
      : error;
    if (!settled) {
      settled = true;
      controller.error(surfacedError);
    }
    cleanup();
    throw surfacedError;
  }
  if (init.signal?.aborted) {
    cleanup();
    cancelNative();
    throw new DOMException("Aborted", "AbortError");
  }
  const responseBody = [204, 205, 304].includes(head.status) ? null : stream;
  const responseHeaders = new Headers(head.headers);
  // Rust already allowlists response headers; retain the credential boundary
  // even if a future native refactor accidentally includes a sensitive name.
  responseHeaders.delete("Set-Cookie");
  responseHeaders.delete("Cookie");
  responseHeaders.delete("Authorization");
  return new Response(responseBody, {
    status: head.status,
    statusText: head.statusText,
    headers: responseHeaders,
  });
}

/* ------------------------------------------------------------------ */
/*  Public API                                                          */
/* ------------------------------------------------------------------ */

export const tauriApi = {
  /**
   * Show a native OS notification. Falls back to the Web Notifications API
   * outside Tauri only after the explicit permission method has been used.
   */
  async showNotification(opts: NotificationOptions): Promise<void> {
    if (!isSafeNotificationCopy(opts)) {
      throw new Error("notifications_invalid_copy");
    }
    if (isTauri()) {
      await safeInvoke<void>(
        "show_native_notification",
        { ...opts },
        () => undefined,
      );
      return;
    }

    if (typeof window === "undefined" || !("Notification" in window)) {
      throw new Error("notifications_unavailable");
    }

    if (Notification.permission === "default") {
      throw new Error("notifications_permission_required");
    }
    if (Notification.permission !== "granted") {
      throw new Error("notifications_permission_denied");
    }
    try {
      // eslint-disable-next-line no-new
      new Notification(opts.title, { body: opts.body });
    } catch {
      throw new Error("notifications_delivery_failed");
    }
  },

  /**
   * Request permission only from an explicit settings action. Background
   * event delivery calls `showNotification` and can never trigger a surprise
   * browser permission prompt.
   */
  async requestNotificationPermission(): Promise<DesktopNotificationPermission> {
    if (isTauri()) {
      // Desktop notification APIs do not expose a consistent cross-platform
      // permission query. The following explicit test delivery remains the
      // authoritative installed-OS integration check.
      return "granted";
    }
    if (typeof window === "undefined" || !("Notification" in window)) {
      return "unsupported";
    }
    if (Notification.permission !== "default") return Notification.permission;
    try {
      return await Notification.requestPermission();
    } catch {
      return "denied";
    }
  },

  /**
   * Open a URL in the user's default browser.
   * In a browser fallback, opens a new tab.
   */
  async openUrl(url: string): Promise<void> {
    const safeUrl = safeOpenExternalUrl(url);
    if (!safeUrl) {
      throw new Error("Refused to open an unsafe external URL");
    }
    if (isTauri()) {
      await safeInvoke<void>("open_url", { url: safeUrl }, () => undefined);
      return;
    }
    if (typeof window !== "undefined") {
      window.open(safeUrl, "_blank", "noopener,noreferrer");
    }
  },

  /**
   * Update the macOS dock / Windows taskbar / Linux tray badge counter.
   * Pass `null` to clear the badge.
   */
  async setTrayBadge(count: number | null): Promise<void> {
    await safeInvoke<void>("set_tray_badge", { count }, () => undefined);
  },

  /**
   * Get the desktop app's semver version (and optional git commit).
   * Returns null when not in Tauri.
   */
  async getAppVersion(): Promise<AppVersion | null> {
    return safeInvoke<AppVersion | null>(
      "get_app_version",
      undefined,
      () => null,
    );
  },

  /**
   * Detect the host OS family.
   */
  async getPlatform(): Promise<Platform> {
    return safeInvoke<Platform>("get_platform", undefined, () =>
      detectWebPlatform(),
    );
  },

  /** Append an already-structural renderer incident to the bounded log. */
  async recordRendererDiagnostic(
    record: RendererDiagnosticRecord,
  ): Promise<void> {
    await safeInvoke<void>(
      "diagnostics_record_renderer_event",
      { record },
      () => undefined,
    );
  },

  /** Consume the panic marker recovered during native startup, at most once. */
  async takeNativeCrashRecord(): Promise<NativeCrashRecord | null> {
    return safeInvoke<NativeCrashRecord | null>(
      "diagnostics_take_startup_crash",
      undefined,
      () => null,
    );
  },

  /** Tell native background services to observe the renderer's Safe Mode. */
  async setDesktopSafeMode(active: boolean): Promise<void> {
    await safeInvoke<void>(
      "diagnostics_set_safe_mode",
      { active },
      () => undefined,
    );
  },

  /** Read the bounded structural native journal for Copy diagnostics. */
  async readDesktopDiagnostics(): Promise<string> {
    return safeInvoke<string>("diagnostics_read_recent", undefined, () => "");
  },

  /**
   * Complete the native deep-link listener handshake and drain URLs that
   * arrived before the renderer was ready. Rust has already length-capped,
   * allowlisted, single-decoded, and canonicalized every returned value.
   */
  async takePendingDeepLinks(): Promise<unknown[]> {
    return safeInvoke<unknown[]>("deep_link_take_pending", undefined, () => []);
  },

  /** Drain opaque OS-notification activations after attaching the listener. */
  async takePendingNotificationActivations(): Promise<unknown[]> {
    return safeInvoke<unknown[]>(
      "notification_activation_take_pending",
      undefined,
      () => [],
    );
  },

  /**
   * Quit the app. No-op in a browser.
   */
  async quitApp(): Promise<void> {
    await safeInvoke<void>("quit_app", undefined, () => undefined);
  },

  /** Install the listener-first native lifecycle handshake and drain intents. */
  async desktopWindowLifecycleReady(): Promise<NativeWindowLifecycleSnapshot> {
    return safeInvoke<NativeWindowLifecycleSnapshot>(
      "desktop_window_lifecycle_ready",
      undefined,
      () => ({
        closeRequested: false,
        quitRequested: false,
        osShutdownRequested: false,
        recoveredInterruptedShutdown: false,
      }),
    );
  },

  /** Hide the main window after the central lifecycle coordinator approves. */
  async hideDesktopWindow(): Promise<void> {
    await safeInvoke<void>("desktop_window_hide", undefined, () => undefined);
  },

  /** Clear a retained native intent when the operator cancels review. */
  async cancelDesktopWindowIntent(
    kind: "close-window" | "quit-app" | "os-shutdown" | "recovered-shutdown",
  ): Promise<void> {
    await safeInvoke<void>(
      "desktop_window_cancel_intent",
      { kind },
      () => undefined,
    );
  },

  /** Update route-first title and native menu/tray enabled states. */
  async setDesktopWindowContext(context: DesktopWindowContext): Promise<void> {
    await safeInvoke<void>(
      "desktop_window_set_context",
      { context },
      () => undefined,
    );
  },

  async sealVaultString(plaintext: string): Promise<string> {
    return safeInvoke<string>("vault_seal", { plaintext }, () => {
      throw new Error("Native local vault is unavailable");
    });
  },

  async openVaultString(envelope: string): Promise<string | null> {
    return safeInvoke<string | null>("vault_open", { envelope }, () => null);
  },

  async purgeVaultKey(): Promise<void> {
    await safeInvoke<void>("vault_purge_key", undefined, () => undefined);
  },

  async initializeApiBroker(
    baseUrl: string,
    legacyApiKey: string | null,
  ): Promise<NativeApiBrokerStatus> {
    nativeApiStatus = await safeInvoke<NativeApiBrokerStatus>(
      "api_broker_initialize",
      { baseUrl, legacyApiKey },
      () => ({
        configured: false,
        baseUrl: null,
        credentialFingerprint: null,
        legacyReentryRequired: false,
      }),
    );
    return nativeApiStatus;
  },

  async configureApiBroker(
    baseUrl: string,
    apiKey: string | null,
    preserveExisting: boolean,
  ): Promise<NativeApiBrokerStatus> {
    nativeApiStatus = await safeInvoke<NativeApiBrokerStatus>(
      "api_broker_configure",
      { baseUrl, apiKey, preserveExisting },
      () => ({
        configured: false,
        baseUrl: null,
        credentialFingerprint: null,
        legacyReentryRequired: false,
      }),
    );
    return nativeApiStatus;
  },

  async clearApiBroker(): Promise<void> {
    await safeInvoke<void>("api_broker_clear", undefined, () => undefined);
    nativeApiStatus = {
      configured: false,
      baseUrl: null,
      credentialFingerprint: null,
      legacyReentryRequired: false,
    };
  },

  apiBrokerStatus(): NativeApiBrokerStatus {
    return { ...nativeApiStatus };
  },

  async probeApiConnection(
    baseUrl: string,
    url: string,
    apiKey: string | null,
    timeoutMs = 5_000,
  ): Promise<Response> {
    const result = await safeInvoke<NativeApiBrokerResponse>(
      "api_broker_probe",
      { request: { baseUrl, url, apiKey, timeoutMs } },
      () => {
        throw new Error("Native API broker is unavailable");
      },
    );
    return responseFromNative(result);
  },

  async storeWorkspaceCredential(
    id: string,
    baseUrl: string,
    apiKey: string,
  ): Promise<void> {
    await safeInvoke<void>(
      "api_workspace_store",
      { id, baseUrl, apiKey },
      () => undefined,
    );
  },

  async removeWorkspaceCredential(id: string): Promise<void> {
    await safeInvoke<void>("api_workspace_remove", { id }, () => undefined);
  },

  async workspaceCredentialStatus(
    workspaces: Array<{ id: string; baseUrl: string }>,
  ): Promise<WorkspaceCredentialStatus[]> {
    return safeInvoke<WorkspaceCredentialStatus[]>(
      "api_workspace_status",
      { workspaces },
      () =>
        workspaces.map(({ id }) => ({
          id,
          configured: false,
          legacyReentryRequired: false,
        })),
    );
  },

  async switchWorkspaceCredential(
    currentId: string,
    targetId: string,
    targetBaseUrl: string,
  ): Promise<NativeApiBrokerStatus> {
    nativeApiStatus = await safeInvoke<NativeApiBrokerStatus>(
      "api_workspace_switch",
      { currentId, targetId, targetBaseUrl },
      () => ({
        configured: false,
        baseUrl: null,
        credentialFingerprint: null,
        legacyReentryRequired: false,
      }),
    );
    return nativeApiStatus;
  },

  /** Bind the native cookie jar to the configured API server. */
  async initializeSessionBroker(
    baseUrl: string,
  ): Promise<NativeSessionBrokerStatus> {
    nativeSessionStatus = await safeInvoke<NativeSessionBrokerStatus>(
      "session_broker_initialize",
      { baseUrl },
      () => ({ baseUrl }),
    );
    return { ...nativeSessionStatus };
  },

  sessionBrokerStatus(): NativeSessionBrokerStatus | null {
    return nativeSessionStatus ? { ...nativeSessionStatus } : null;
  },

  /** Clear the active pw_session without reading it into the renderer. */
  async clearSessionBroker(): Promise<void> {
    await safeInvoke<void>("session_broker_clear", undefined, () => undefined);
  },

  /** Shared-device sign-out across every origin-partitioned native jar. */
  async clearAllSessionBrokers(): Promise<void> {
    await safeInvoke<void>(
      "session_broker_clear_all",
      undefined,
      () => undefined,
    );
  },

  /**
   * Cookie-authenticated native transport. Rust applies the exact configured
   * origin/path boundary and strips Set-Cookie from the IPC response.
   */
  async fetchWithSessionBroker(
    url: string,
    init: RequestInit = {},
  ): Promise<Response | null> {
    if (!isTauri() || !nativeSessionStatus) return null;
    return fetchWithNativeStream(
      "session_broker_stream_request",
      "session_broker_cancel",
      "Native session broker is unavailable",
      nativeSessionStatus.baseUrl,
      url,
      init,
    );
  },

  /**
   * Use the native authenticated transport only when a bound credential is
   * active and the destination has that exact origin. Caller-provided
   * Authorization remains a normal webview request (e.g. API Playground).
   */
  async fetchWithApiBroker(
    url: string,
    init: RequestInit = {},
  ): Promise<Response | null> {
    if (!isTauri() || !nativeApiStatus.configured || !nativeApiStatus.baseUrl) {
      return null;
    }
    return fetchWithNativeStream(
      "api_broker_stream_request",
      "api_broker_cancel",
      "Native API broker is unavailable",
      nativeApiStatus.baseUrl,
      url,
      init,
    );
  },

  /**
   * Read a migration-upload resume ledger from the Tauri app local data
   * dir. Returns null when no ledger exists, the ledger exceeds the
   * built-in size cap, or we're running in a browser. The payload is
   * opaque JSON — the caller (api-client.ts) owns the schema.
   *
   * Why this exists: the legacy code stored the ledger in localStorage,
   * which is per-origin capped (~5MB on most browsers) and gets evicted
   * on macOS WebView reset. Moving to appLocalDataDir survives both.
   */
  async readMigrationLedger(key: string): Promise<string | null> {
    return safeInvoke<string | null>(
      "migration_ledger_read",
      { key },
      () => null,
    );
  },

  async writeMigrationLedger(key: string, payload: string): Promise<void> {
    await safeInvoke<void>(
      "migration_ledger_write",
      { key, payload },
      () => undefined,
    );
  },

  async clearMigrationLedger(key: string): Promise<void> {
    await safeInvoke<void>("migration_ledger_clear", { key }, () => undefined);
  },

  /** Purge ambiguous v1, expired, and over-cap native resume ledgers. */
  async pruneMigrationLedgers(): Promise<void> {
    await safeInvoke<void>(
      "migration_ledger_prune",
      undefined,
      () => undefined,
    );
  },

  /**
   * Ask the Rust shell whether a newer signed release exists.
   *
   * Returns `status: "not_configured"` when the build shipped without
   * POSTWAVE_UPDATER_PUBKEY / POSTWAVE_UPDATER_ENDPOINT (and as the
   * browser fallback) — the UI must render that honestly rather than
   * pretending a check happened. Throws on real check failures
   * (network, malformed manifest, bad signature).
   */
  async checkForUpdates(): Promise<UpdateCheckResult> {
    return safeInvoke<UpdateCheckResult>(
      "check_for_updates",
      undefined,
      () => NOT_CONFIGURED_UPDATE,
    );
  },

  /**
   * Listener-first scheduler handshake. Rust retains its latest successful or
   * failed result until the renderer asks for it, closing the launch race.
   */
  async getUpdateState(): Promise<NativeUpdateStateSnapshot | null> {
    return safeInvoke<NativeUpdateStateSnapshot | null>(
      "get_update_state",
      undefined,
      () => null,
    );
  },

  /**
   * Download + apply the latest signed release. Resolves with
   * `status: "installed"` once the new binary is staged — the caller
   * should then prompt for a relaunch via `restartApp()`. Progress is
   * emitted by Rust as `updater:download-progress {downloaded, total}`
   * during the download; the root desktop-update service subscribes before
   * any menu or Settings surface mounts.
   */
  async installUpdate(): Promise<InstallUpdateResult> {
    return safeInvoke<InstallUpdateResult>("install_update", undefined, () => ({
      status: "not_configured",
      version: null,
    }));
  },

  /** Relaunch the app (after an installed update). No-op in a browser. */
  async restartApp(): Promise<void> {
    await safeInvoke<void>("restart_app", undefined, () => undefined);
  },
} as const;

export function safeOpenExternalUrl(
  raw: string | null | undefined,
): string | null {
  if (!raw || raw.length > 8_192 || /[\u0000-\u001f\u007f]/u.test(raw)) {
    return null;
  }
  try {
    const url = new URL(raw.trim());
    if (url.protocol === "mailto:") {
      return isSafeMailto(url) ? url.toString() : null;
    }
    if (url.protocol === "sms:") {
      return isSafeSmsIntent(url) ? url.toString() : null;
    }
    if (url.protocol !== "https:" && !isLocalHttpUrl(url)) return null;
    if (url.username || url.password) return null;
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function isSafeMailto(url: URL): boolean {
  const address = url.pathname.toLowerCase();
  if (address && !isSinglePostwaveMailRecipient(address)) return false;
  return Array.from(url.searchParams.keys()).every((key) =>
    ["subject", "body"].includes(key),
  );
}

function isSinglePostwaveMailRecipient(address: string): boolean {
  const separator = address.indexOf("@");
  if (separator <= 0 || separator !== address.lastIndexOf("@")) return false;
  const local = address.slice(0, separator);
  const domain = address.slice(separator + 1);
  return (
    local.length <= 64 &&
    /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(local) &&
    domain === "moosewave.com"
  );
}

function isSafeSmsIntent(url: URL): boolean {
  const recipient = url.pathname;
  if (recipient && !/^[+\d,-]+$/.test(recipient)) return false;
  return Array.from(url.searchParams.keys()).every(
    (key) => key === "" || key === "body",
  );
}

function isLocalHttpUrl(url: URL): boolean {
  const host = url.hostname.toLowerCase();
  return (
    url.protocol === "http:" &&
    (host === "localhost" ||
      host === "127.0.0.1" ||
      host === "::1" ||
      host === "[::1]")
  );
}

function detectWebPlatform(): Platform {
  if (typeof navigator === "undefined") return "unknown";
  const ua = navigator.userAgent.toLowerCase();
  if (ua.includes("mac os") || ua.includes("macintosh")) return "macos";
  if (ua.includes("windows")) return "windows";
  if (ua.includes("linux")) return "linux";
  if (ua.includes("iphone") || ua.includes("ipad")) return "ios";
  if (ua.includes("android")) return "android";
  return "unknown";
}
