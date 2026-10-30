/**
 * React 19 entry point. Mounts the App tree with an error boundary into the
 * #root element defined in index.html.
 */

import { lazy, StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";

import { App, AppErrorBoundary } from "./App";
import { ErrorScreen } from "./components/ErrorScreen";
import { ToastHost } from "./components/Toast";
import {
  captureRendererIncident,
  initializeDesktopDiagnostics,
} from "./lib/desktop-diagnostics";
import { initSentry, SentryErrorBoundary } from "./lib/sentry";
import { init as initTelemetry } from "./lib/telemetry";
import {
  hydrateSecureApiConfig,
  SecureCredentialStorageError,
} from "./lib/api-client";
import { initEasterEggs } from "./lib/easter-eggs";
import { initializeDesktopWindowLifecycle } from "./lib/desktop-window-lifecycle";
import {
  detectRuntimeCompatibilityIssues,
  REQUIRED_DESKTOP_RUNTIME,
} from "./lib/runtime-compatibility";

import "./styles.css";
// Settings v2 polish — SaveBar, SettingsNav, toggle rows, section
// header meta slot. Same isolation rationale as the templates file.
// This stays global because settings-section primitives are reused by
// dashboard/webhook settings panels outside the Settings route chunk.
import "./styles-settings-v2.css";
import "./styles-segment-builder.css";

const DesktopUpdateService = lazy(() =>
  import("./components/DesktopUpdateService").then((module) => ({
    default: module.DesktopUpdateService,
  })),
);
const DesktopDiagnosticsService = lazy(() =>
  import("./components/DesktopDiagnosticsService").then((module) => ({
    default: module.DesktopDiagnosticsService,
  })),
);
const DesktopLifecycleService = lazy(() =>
  import("./components/DesktopLifecycleService").then((module) => ({
    default: module.DesktopLifecycleService,
  })),
);

// Diagnostics first: root error/rejection listeners and crash-loop state must
// exist before any optional SDK, credential hydration, or React work starts.
const diagnosticsBoot = initializeDesktopDiagnostics();
const lifecycleBoot = initializeDesktopWindowLifecycle().catch((error) => {
  captureRendererIncident("window_error", error, { fatal: false });
});

// Sentry first — we want it to catch errors raised during the synchronous
// init that follows (PostHog dynamic import, createRoot, etc.). No-op when
// VITE_SENTRY_DSN_DESKTOP is unset so dev builds carry no overhead.
//
// `initSentry()` is async and dynamic-imports `@sentry/react` only when a
// DSN is set, keeping the ~77KB Sentry runtime out of the no-DSN critical
// path. The lazy SentryErrorBoundary below installs the real boundary
// once init resolves; until then it acts as a passthrough.
if (!diagnosticsBoot.safeMode) void initSentry();

// Fire-and-forget. init() resolves immediately when VITE_POSTHOG_KEY
// is unset, and is internally idempotent — no need to await before
// rendering.
if (!diagnosticsBoot.safeMode) void initTelemetry();

// Console signature + Konami egg. Synchronous, idempotent, App-tree-free.
if (!diagnosticsBoot.safeMode) initEasterEggs();

void bootstrap().catch((error: unknown) => {
  captureRendererIncident("bootstrap_failure", error, { fatal: true });
});

async function bootstrap(): Promise<void> {
  // Native close/quit/shutdown/sign-out listeners and retained-intent
  // handshake must finish before a potentially slow keychain unlock.
  await lifecycleBoot;
  const container = document.getElementById("root");
  if (!container) {
    throw new Error(
      "Moosewave desktop shell: #root element not found in index.html",
    );
  }

  const compatibilityIssues = detectRuntimeCompatibilityIssues();
  if (compatibilityIssues.length > 0) {
    createRoot(container).render(
      <StrictMode>
        <RuntimeCompatibilityFailure issues={compatibilityIssues} />
      </StrictMode>,
    );
    return;
  }

  // Start the native updater handshake before keychain/API hydration. Rust
  // also retains its last scheduler result, so even a very slow credential
  // unlock cannot lose an available-update event.
  if (!diagnosticsBoot.safeMode) {
    void import("./lib/desktop-update-service")
      .then(({ initializeDesktopUpdateService }) =>
        initializeDesktopUpdateService(),
      )
      .catch(() => undefined);
  }

  try {
    await hydrateSecureApiConfig();
  } catch (error) {
    createRoot(container).render(
      <StrictMode>
        <Suspense fallback={null}>
          <DesktopDiagnosticsService />
        </Suspense>
        <CredentialStorageFailure
          message={
            error instanceof SecureCredentialStorageError
              ? error.message
              : "Moosewave could not initialize secure credential storage."
          }
        />
        <Suspense fallback={null}>
          {!diagnosticsBoot.safeMode && <DesktopUpdateService />}
          <DesktopLifecycleService />
        </Suspense>
        <ToastHost />
      </StrictMode>,
    );
    return;
  }

  createRoot(container).render(
    <StrictMode>
      {/* Outermost Sentry boundary catches anything below; the inner
          AppErrorBoundary still owns the user-visible fallback UI. When
          Sentry is dormant (no DSN) this boundary is functionally a
          passthrough that just re-throws to the next boundary. */}
      <SentryErrorBoundary fallback={<AppErrorFallback />}>
        <Suspense fallback={null}>
          <DesktopDiagnosticsService />
        </Suspense>
        <AppErrorBoundary>
          <App />
          <Suspense fallback={null}>
            {!diagnosticsBoot.safeMode && <DesktopUpdateService />}
            <DesktopLifecycleService />
          </Suspense>
          <ToastHost />
        </AppErrorBoundary>
      </SentryErrorBoundary>
    </StrictMode>,
  );
}

function CredentialStorageFailure({ message }: { message: string }) {
  return (
    <main role="alert" style={{ padding: 24, fontFamily: "system-ui" }}>
      <h1>Secure credential storage is unavailable</h1>
      <p>{message}</p>
      <p>
        Unlock Keychain Access or Windows Credential Manager, then restart and
        enter the API key again. Moosewave will not keep it in local storage.
      </p>
      <button type="button" onClick={() => window.location.reload()}>
        Retry
      </button>
    </main>
  );
}

function RuntimeCompatibilityFailure({ issues }: { issues: string[] }) {
  return (
    <main
      role="alert"
      style={{
        maxWidth: 680,
        margin: "48px auto",
        padding: 24,
        fontFamily: "system-ui, sans-serif",
        lineHeight: 1.5,
      }}
    >
      <h1>Update the system web runtime to open Moosewave</h1>
      <p>
        This device is missing required browser capabilities:{" "}
        {issues.join(", ")}. Moosewave stopped before loading credentials or
        workspace data so it cannot show a misleading or unsafe interface.
      </p>
      <p>
        On macOS, install all available macOS and Safari updates (WebKit{" "}
        {REQUIRED_DESKTOP_RUNTIME.macosWebKit} or later). On Windows, update the
        Microsoft Edge WebView2 Runtime to version{" "}
        {REQUIRED_DESKTOP_RUNTIME.windowsWebView2} or later. Then restart
        Moosewave.
      </p>
      <button type="button" onClick={() => window.location.reload()}>
        Check again
      </button>
    </main>
  );
}

function AppErrorFallback() {
  // This path is intentionally the same recovery surface. It remains usable
  // if the inner application boundary itself fails.
  return <ErrorScreen error={new Error("outer_renderer_boundary")} />;
}
