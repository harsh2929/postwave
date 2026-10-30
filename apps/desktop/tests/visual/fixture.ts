/**
 * Shared fixture for visual regression tests.
 *
 * What this does for every test:
 *   1. Stubs window.__TAURI_INTERNALS__ before any app code runs so
 *      isTauri() returns true and the NotInTauri boot gate is bypassed.
 *      The stub responds to every IPC command with a canned value (see
 *      tauriCommandStubs below).
 *   2. Sets localStorage so the app boots with a known API URL + a
 *      "remembered session" — skipping the Welcome / SignIn screens.
 *   3. Intercepts network calls to /api/v1/* and returns canned JSON,
 *      so the dashboard renders deterministic data instead of empty
 *      states or loading spinners.
 *   4. Exposes a `setTheme(page, theme)` helper that flips the
 *      data-theme attribute the same way the user-facing settings
 *      toggle does.
 *
 * If you need a new view to render specific data, extend the route
 * intercepts in `apiRouteStubs`. Adding fields to existing handlers
 * is preferred to introducing per-test overrides — keeps the
 * snapshots stable.
 */
import { test as base, type Page } from "@playwright/test";

const VISUAL_USER_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const VISUAL_TENANT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const tauriCommandStubs: Record<string, unknown> = {
  get_app_version: { version: "0.0.0-visual-test", commit: "test" },
  get_platform: "macos",
  check_for_updates: { available: false },
  get_update_state: null,
  read_secret: null,
  store_secret: null,
  delete_secret: null,
  set_tray_badge: null,
  open_url: null,
  quit_app: null,
  show_native_notification: null,
  notification_activation_take_pending: [],
  diagnostics_record_renderer_event: null,
  diagnostics_take_startup_crash: null,
  diagnostics_set_safe_mode: null,
  desktop_window_lifecycle_ready: {
    closeRequested: false,
    quitRequested: false,
    osShutdownRequested: false,
    recoveredInterruptedShutdown: false,
  },
  desktop_window_set_context: null,
  // The renderer now initializes the origin-bound native API broker before
  // React mounts. Browser-based quality tests intentionally exercise the
  // cookie/session transport, so report a healthy broker with no stored key.
  api_broker_initialize: {
    configured: false,
    baseUrl: null,
    credentialFingerprint: null,
    legacyReentryRequired: false,
  },
  api_broker_configure: {
    configured: false,
    baseUrl: null,
    credentialFingerprint: null,
    legacyReentryRequired: false,
  },
  api_broker_clear: null,
  deep_link_take_pending: [],
  vault_seal: "visual-test-vault-envelope",
  vault_open: null,
  vault_purge_key: null,
  // Tauri 2 plugin IPCs the desktop shell talks to. The boot path calls
  // event listen/unlisten and the deep-link plugin's get_current. None
  // need real semantics for static screenshots — returning null silences
  // the "unstubbed" warning while keeping the boot pipeline intact.
  "plugin:event|listen": null,
  "plugin:event|unlisten": null,
  "plugin:deep-link|get_current": null,
};

const apiRouteStubs: Record<string, unknown> = {
  "/api/v1/auth/me": {
    user_id: VISUAL_USER_ID,
    tenant_id: VISUAL_TENANT_ID,
    email: "visual-test@example.invalid",
    role: "admin",
    effective_role: "admin",
    auth_provider: "password",
    email_verified: true,
    workspace_name: "Moosewave",
    workspace_slug: "test-tenant",
  },
  // Sidebar still reads the legacy API-key identity projection while the
  // shell/RBAC store reads /auth/me. Stub both contracts so a screenshot of
  // an authenticated shell never presents the contradictory "Not signed in"
  // footer.
  "/api/v1/me": {
    user: "visual-test@example.invalid",
    tenant: "Moosewave",
  },
  "/api/v1/audit/my-scopes": {
    scopes: ["audit:read", "audit:read_pii"],
    auditScopes: ["audit:read", "audit:read_pii"],
    isAdmin: true,
  },
  "/api/v1/dashboard/stats": {
    subscribers_total: 12_482,
    subscribers_added_30d: 418,
    subscribers_unsubbed_30d: 96,
    campaigns_sent_30d: 8,
    emails_sent_30d: 62_400,
    opens_total_30d: 26_270,
    clicks_total_30d: 5_242,
    bounces_total_30d: 374,
    active_sequences_count: 4,
    range: "30d",
    previous: {
      subscribers_added: 371,
      subscribers_unsubbed: 112,
      campaigns_sent: 7,
      emails_sent: 59_200,
      opens_total: 23_502,
      clicks_total: 4_440,
      bounces_total: 474,
    },
    sparklines: {
      subscribers: [11_980, 12_044, 12_117, 12_165, 12_241, 12_386, 12_482],
      opens: [3_420, 3_812, 3_610, 4_042, 3_774, 3_966, 3_646],
      clicks: [612, 748, 701, 804, 776, 850, 751],
      bounces: [68, 54, 61, 49, 52, 46, 44],
    },
    anomalies: { opens: false, clicks: false, bounces: false },
    recent_audit: [
      {
        id: "audit-visual-1",
        action: "campaign.sent",
        actor: "visual-test@example.invalid",
        at: "2026-07-18T07:30:00.000Z",
        description: "Summer launch sent",
      },
      {
        id: "audit-visual-2",
        action: "sequence.activated",
        actor: "visual-test@example.invalid",
        at: "2026-07-18T06:45:00.000Z",
        description: "Welcome journey activated",
      },
    ],
  },
  "/api/v1/dashboard/layout": {
    userId: VISUAL_USER_ID,
    tenantId: VISUAL_TENANT_ID,
    order: [
      "subs",
      "opens",
      "clicks",
      "bounces",
      "forecast",
      "anomalies",
      "goals",
      "benchmarks",
      "engagement",
      "parity",
      "inbox-health",
      "clv",
    ],
    updatedAt: "2026-07-16T00:00:00.000Z",
  },
  "/api/v1/subscribers": {
    items: [],
    total: 0,
    page: 1,
    per_page: 50,
  },
  "/api/v1/campaigns": {
    items: [
      {
        id: "campaign-visual-1",
        name: "Summer launch",
        subject: "A brighter way to ship",
        status: "sent",
        sent_at: "2026-07-17T14:00:00.000Z",
        open_rate: 0.448,
        click_rate: 0.091,
      },
      {
        id: "campaign-visual-2",
        name: "Product digest · July",
        subject: "What shipped this month",
        status: "sent",
        sent_at: "2026-07-14T09:00:00.000Z",
        open_rate: 0.413,
        click_rate: 0.078,
      },
    ],
  },
  "/api/v1/subscribers/growth": {
    days: 90,
    series: [],
    metric_contract_version: "verified-exact-ledger-v2",
    unavailable_metrics: ["lapsed"],
    partial_metrics: ["unsubbed"],
    total_added: 0,
    total_unsubbed: 0,
    delta: 0,
    delta_pct: 0,
    note: "Audience growth appears after the daily snapshot worker records data.",
  },
  "/api/v1/lifecycle/distribution": { items: [] },
  "/api/v1/lifecycle/stages": { stages: [] },
  "/api/v1/engagement-scores/distribution": { buckets: [] },
  "/api/v1/tags": { items: [] },
  "/api/v1/tag-groups": { items: [] },
  "/api/v1/tag-taxonomy": { items: [] },
  "/api/v1/health": { ok: true },
};

async function installTauriStub(page: Page): Promise<void> {
  const stubs = tauriCommandStubs;
  await page.addInitScript((stubsLiteral: typeof stubs) => {
    const visualRuntime = window as typeof window & {
      __authShowcaseNativeSignedOut?: boolean;
      __authShowcaseAuthChecks?: number;
      __visualUnexpectedTauriCommands?: string[];
    };
    visualRuntime.__visualUnexpectedTauriCommands = [];
    // Tauri 2 reads this global to identify "inside the webview". The
    // production internals object has invoke() + a handful of other
    // helpers; we only need invoke() for these tests.
    // Tauri 2's @tauri-apps/api/event uses transformCallback to register
    // a temporary global function name that Rust can call back into. We
    // return a fake handle name so the subscription resolves; the
    // callback will simply never be invoked in tests (events never
    // fire), which is the desired behavior for static screenshots.
    let cbCounter = 0;
    const visualVaultPrefix = "visual-test-vault-envelope:";
    const sealVisualVaultValue = (plaintext: string): string => {
      const bytes = new TextEncoder().encode(plaintext);
      let binary = "";
      for (const byte of bytes) binary += String.fromCharCode(byte ^ 0x5a);
      return `${visualVaultPrefix}${btoa(binary)}`;
    };
    const openVisualVaultValue = (envelope: string): string | null => {
      if (!envelope.startsWith(visualVaultPrefix)) return null;
      try {
        const binary = atob(envelope.slice(visualVaultPrefix.length));
        const bytes = Uint8Array.from(
          binary,
          (character) => character.charCodeAt(0) ^ 0x5a,
        );
        return new TextDecoder().decode(bytes);
      } catch {
        return null;
      }
    };
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      value: {
        invoke: async (cmd: string, args?: Record<string, unknown>) => {
          // AuthShowcase is the one visual route that intentionally boots
          // without a session. Exercise the same native cookie-transport
          // boundary as the installed app: a reachable /auth/me returns an
          // authoritative 401, while other quiet probes remain reachable.
          // The opt-in marker is installed by that spec before app code runs,
          // so authenticated visual fixtures keep their existing behavior.
          if (visualRuntime.__authShowcaseNativeSignedOut) {
            if (cmd === "session_broker_initialize") {
              return { baseUrl: String(args?.baseUrl ?? "") };
            }
            if (cmd === "session_broker_stream_request") {
              const request = args?.request as { url?: string } | undefined;
              const pathname = new URL(
                request?.url ?? window.location.href,
                window.location.href,
              ).pathname;
              const signedOut = pathname === "/api/v1/auth/me";
              if (signedOut) {
                visualRuntime.__authShowcaseAuthChecks =
                  (visualRuntime.__authShowcaseAuthChecks ?? 0) + 1;
              }
              const payload = signedOut
                ? JSON.stringify({ error: { code: "unauthorized" } })
                : JSON.stringify({});
              const onEvent = args?.onEvent as
                | {
                    onmessage?: (
                      event:
                        | number[]
                        | { event: "complete" | "error"; message?: string },
                    ) => void;
                  }
                | undefined;
              queueMicrotask(() => {
                onEvent?.onmessage?.(
                  Array.from(new TextEncoder().encode(payload)),
                );
                onEvent?.onmessage?.({ event: "complete" });
              });
              return {
                status: signedOut ? 401 : 200,
                statusText: signedOut ? "Unauthorized" : "OK",
                headers: { "content-type": "application/json" },
              };
            }
            if (cmd === "session_broker_cancel") return null;
          }
          if (cmd === "session_broker_initialize") {
            return { baseUrl: String(args?.baseUrl ?? "") };
          }
          if (cmd === "session_broker_stream_request") {
            const request = args?.request as
              | {
                  body?: number[];
                  headers?: Record<string, string>;
                  method?: string;
                  url?: string;
                }
              | undefined;
            const nativeTarget = new URL(
              request?.url ?? window.location.href,
              window.location.href,
            );
            // The production broker is not subject to browser CORS. Send its
            // synthetic request through this preview origin while preserving
            // the API path/query so Playwright's route fixtures exercise the
            // same request contract without probing the compiled API host.
            const fixtureTarget = new URL(
              `${nativeTarget.pathname}${nativeTarget.search}`,
              window.location.origin,
            );
            const onEvent = args?.onEvent as
              | {
                  onmessage?: (
                    event:
                      | number[]
                      | { event: "complete" | "error"; message?: string },
                  ) => void;
                }
              | undefined;
            const response = await fetch(fixtureTarget, {
              method: request?.method ?? "GET",
              headers: request?.headers,
              body:
                request?.body && request.body.length > 0
                  ? new Uint8Array(request.body)
                  : undefined,
            });
            const payload = new Uint8Array(await response.arrayBuffer());
            const responseHeaders: Record<string, string> = {};
            response.headers.forEach((value, name) => {
              responseHeaders[name] = value;
            });
            queueMicrotask(() => {
              onEvent?.onmessage?.(Array.from(payload));
              onEvent?.onmessage?.({ event: "complete" });
            });
            return {
              status: response.status,
              statusText: response.statusText,
              headers: responseHeaders,
            };
          }
          if (
            cmd === "session_broker_cancel" ||
            cmd === "session_broker_clear" ||
            cmd === "session_broker_clear_all"
          ) {
            return null;
          }
          if (cmd === "vault_seal") {
            const plaintext = args?.plaintext;
            return typeof plaintext === "string"
              ? sealVisualVaultValue(plaintext)
              : null;
          }
          if (cmd === "vault_open") {
            const envelope = args?.envelope;
            return typeof envelope === "string"
              ? openVisualVaultValue(envelope)
              : null;
          }
          const value = (stubsLiteral as Record<string, unknown>)[cmd];
          if (value === undefined) {
            // Surface unstubbed commands so missing handlers are obvious
            // when extending tests.
            visualRuntime.__visualUnexpectedTauriCommands?.push(cmd);
            // eslint-disable-next-line no-console
            console.warn(`[visual-test] unstubbed Tauri command: ${cmd}`);
            return null;
          }
          return value;
        },
        transformCallback: (_cb: unknown, _once?: boolean) => {
          cbCounter += 1;
          return cbCounter;
        },
        unregisterListener: () => undefined,
      },
      writable: false,
      configurable: true,
    });
    // The event API also expects this hook for setting up listeners.
    // We resolve immediately with a fake unsubscribe function — no
    // events will ever fire, which is what we want for static
    // screenshots.
    (
      window as unknown as { __TAURI_EVENT_PLUGIN_INTERNALS__?: unknown }
    ).__TAURI_EVENT_PLUGIN_INTERNALS__ = {
      unregisterListener: () => undefined,
    };

    // Keep live-data consumers deterministic. A real EventSource against the
    // generic JSON route stub closes immediately and creates a reconnect
    // storm that can starve Vite's lazy module requests. This test transport
    // opens once, emits no data, and stays open until the app closes it.
    class VisualEventSource {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSED = 2;
      readonly url: string;
      readonly withCredentials = false;
      readyState = VisualEventSource.OPEN;
      onopen: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;

      constructor(url: string | URL) {
        this.url = String(url);
        queueMicrotask(() => this.onopen?.(new Event("open")));
      }

      addEventListener(): void {
        // No server events in deterministic renderer tests.
      }

      removeEventListener(): void {
        // No server events in deterministic renderer tests.
      }

      dispatchEvent(): boolean {
        return true;
      }

      close(): void {
        this.readyState = VisualEventSource.CLOSED;
      }
    }
    (
      window as unknown as { EventSource: typeof VisualEventSource }
    ).EventSource = VisualEventSource;
  }, stubs);
}

async function installLocalStorageBootstrap(page: Page): Promise<void> {
  await page.addInitScript(() => {
    try {
      window.localStorage.setItem("postwave_api_url", "http://localhost:8080");
      window.localStorage.setItem("postwave_api_key", "test-key");
      window.localStorage.setItem("postwave_session", "1");
      // Skip the onboarding wizard and product tour for a clean shell.
      // The wizard checks a per-tenant dismissal key (see
      // OnboardingWizard.tsx#dismissalKey); we set both the global and
      // the tenant-specific variants so the gate falls through whichever
      // path the wizard takes. Tests that want to screenshot the wizard
      // should clear these in their own beforeEach.
      window.localStorage.setItem("postwave_onboarded", "1");
      window.localStorage.setItem(
        "postwave_onboarding_dismissed_at",
        new Date().toISOString(),
      );
      window.localStorage.setItem(
        "postwave_onboarding_dismissed_at:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        new Date().toISOString(),
      );
      // Dismiss the dashboard tour too (it gates on these keys).
      window.localStorage.setItem(
        "postwave_tour_dashboard_completed_at",
        new Date().toISOString(),
      );
      window.localStorage.setItem(
        "postwave_tour_dashboard_dismissed_at",
        new Date().toISOString(),
      );
      // Don't pre-set the theme here — individual tests do that so
      // each test starts from a clean theme decision.
    } catch {
      /* ignore */
    }
  });
}

async function installApiStubs(page: Page): Promise<void> {
  await page.route(/^https?:\/\/[^/]+\/api\/.*$/u, async (route) => {
    const url = new URL(route.request().url());
    const handler = apiRouteStubs[url.pathname];
    if (handler !== undefined) {
      const body =
        url.pathname === "/api/v1/dashboard/stats" &&
        typeof handler === "object" &&
        handler !== null
          ? {
              ...handler,
              range: url.searchParams.get("range") ?? "30d",
            }
          : handler;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(body),
      });
      return;
    }
    // Unknown endpoints: return empty 200 so loaders don't hang.
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({}),
    });
  });
}

/**
 * Wait for the lazy primary-navigation module, not only the eager Sidebar
 * shell. The Suspense fallback is also a visible `navigation` named Primary,
 * so the stable Dashboard destination is the semantic readiness signal.
 */
export async function waitForPrimaryNavigation(
  page: Page,
  timeout = 20_000,
): Promise<void> {
  await page
    .getByRole("navigation", { name: "Primary" })
    .locator('button[data-section="dashboard"]')
    .first()
    .waitFor({ state: "visible", timeout });
}

/** Commands observed by the shared native boundary without a fixture stub. */
export async function unexpectedTauriCommands(page: Page): Promise<string[]> {
  if (page.isClosed()) return [];
  return page.evaluate(
    () =>
      (
        window as typeof window & {
          __visualUnexpectedTauriCommands?: string[];
        }
      ).__visualUnexpectedTauriCommands ?? [],
  );
}

interface VisualFixture {
  bootApp: (page: Page) => Promise<void>;
  setTheme: (page: Page, theme: "system" | "dark" | "light") => Promise<void>;
}

/**
 * The exported test() wraps Playwright's base test() and injects our
 * helpers. Use it instead of `import { test } from "@playwright/test"`
 * in spec files.
 */
export const test = base.extend<VisualFixture>({
  bootApp: async ({}, use) => {
    await use(async (page: Page) => {
      await installTauriStub(page);
      await installLocalStorageBootstrap(page);
      await installApiStubs(page);
    });
  },
  setTheme: async ({}, use) => {
    await use(async (page: Page, theme: "system" | "dark" | "light") => {
      await page.addInitScript((t: "system" | "dark" | "light") => {
        try {
          window.localStorage.setItem("postwave_theme", t);
        } catch {
          /* ignore */
        }
      }, theme);
    });
  },
});

export { expect } from "@playwright/test";
