/**
 * Moosewave Desktop Sentry wiring — lazy, DSN-gated.
 *
 * `@sentry/react` adds ~77KB raw / ~26KB gzipped to the cold-start critical
 * path; we only pay for it when the build actually has a DSN. Both
 * `initSentry()` and the `SentryErrorBoundary` component dynamic-import
 * `@sentry/react` only when `VITE_SENTRY_DSN_DESKTOP` is set, so on builds
 * without a DSN the SDK chunk is never fetched.
 *
 * The savings land on the cold-start entry chunk (`dist/assets/index-*.js`)
 * which is synchronously loaded before first paint. The bundle-size guard
 * in `apps/desktop/scripts/check-bundle-size.mjs` enforces the invariant
 * in CI so we don't silently regress.
 *
 * Sentry redaction is the SHARED scrubber from `@postwave/telemetry`
 * (redactEvent / redactBreadcrumb) — the single source of truth that also
 * mirrors the Go-side scrubber (apps/api/internal/observability/sentry.go),
 * so a single Sentry org sees consistent shape regardless of surface:
 *
 *   - request bodies cleared (event.request.data)
 *   - Authorization / Cookie / X-Postwave-Token request headers stripped
 *   - request cookies cleared
 *   - secret, OAuth, session, and email-ish query parameters redacted
 *     (in query_string + url, and in fetch/xhr/navigation breadcrumb URLs)
 *
 * Previously this file hand-rolled an equivalent local scrubber; that copy
 * was deleted in favour of the shared package so the rules can't drift.
 *
 * --- PII discipline (matches lib/telemetry.ts) ---
 *
 *   - subscriber email addresses, list-member PII
 *   - email body content (HTML, MJML, rendered text)
 *   - subject lines (may contain personalization tokens)
 *   - free-form user-typed strings
 *   - API keys, session tokens, OAuth tokens, signed URLs
 */
import {
  type RedactableBreadcrumb,
  type RedactableEvent,
  redactBreadcrumb,
  redactEvent,
} from "@postwave/telemetry";
import {
  Component,
  createElement,
  type ErrorInfo,
  type ReactElement,
  type ReactNode,
} from "react";

// Type-only import. `@sentry/react` itself is dynamic-imported below; the
// `import type` form is fully erased by tsc and never appears in the
// emitted JS — preserving the lazy-chunk invariant.
import type * as SentryReact from "@sentry/react";

interface ImportMetaEnv {
  VITE_SENTRY_DSN_DESKTOP?: string;
  VITE_POSTWAVE_RELEASE?: string;
  MODE?: string;
}

function readEnv(): ImportMetaEnv {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return ((import.meta as any).env ?? {}) as ImportMetaEnv;
}

function readDsn(): string {
  return (readEnv().VITE_SENTRY_DSN_DESKTOP ?? "").trim();
}

let initialized = false;
let initPromise: Promise<typeof SentryReact | null> | null = null;
let sentryModule: typeof SentryReact | null = null;

// Exceptions captured before `initSentry()` resolves are queued
// (bounded) and flushed once the SDK is live, instead of being dropped.
const MAX_PRE_INIT_CAPTURE_QUEUE = 20;
let preInitCaptureQueue: unknown[] = [];

function flushPreInitCaptureQueue(mod: typeof SentryReact): void {
  const queued = preInitCaptureQueue;
  preInitCaptureQueue = [];
  for (const err of queued) {
    try {
      mod.captureException(err);
    } catch {
      /* best-effort */
    }
  }
}

/**
 * Idempotent. Safe to call multiple times. Resolves immediately when no DSN
 * is set (dev / local / unit tests) — in that mode `@sentry/react` is never
 * imported and the lazy chunk is never fetched.
 */
export async function initSentry(): Promise<void> {
  if (initialized) return;
  if (initPromise) {
    await initPromise;
    return;
  }

  const dsn = readDsn();
  if (!dsn) {
    initialized = true;
    // eslint-disable-next-line no-console
    console.info("[postwave-sentry] no DSN; running without error tracking");
    return;
  }

  initPromise = (async () => {
    try {
      // Dynamic import — Rollup emits this as a separate chunk, and
      // because Vite inlines `import.meta.env.VITE_SENTRY_DSN_DESKTOP`
      // lookups at build time, the no-DSN build never executes this
      // branch. Mirrors the `posthog-js` lazy pattern in lib/telemetry.ts.
      const mod = (await import("@sentry/react")) as typeof SentryReact;
      const env = readEnv();
      mod.init({
        dsn,
        environment: env.MODE ?? "production",
        release: env.VITE_POSTWAVE_RELEASE,
        tracesSampleRate: 0.1,
        sendDefaultPii: false,
        // Strip request bodies + auth headers + cookies and redact
        // secret/PII query params before send, via the SHARED scrubber.
        // Mirrors apps/api/internal/observability/sentry.go::redactSensitiveData.
        // The shared helpers are generic over a structural `Redactable*`
        // shape (with an index signature) that Sentry's nominal
        // ErrorEvent/Breadcrumb don't declare; the runtime shape is
        // compatible (both expose `request` / `data`), so we bridge the
        // nominal gap with a single cast at the boundary. The helpers
        // mutate-and-return, so the original event/breadcrumb is returned.
        beforeSend(event) {
          redactEvent(event as unknown as RedactableEvent);
          return event;
        },
        // fetch/XHR/navigation breadcrumbs carry full URLs in
        // `data.url` / `data.to` / `data.from` — including `stream_token`
        // / `api_key` query params that `beforeSend` never sees. The
        // shared scrubber redacts them with the same rules.
        beforeBreadcrumb(breadcrumb) {
          redactBreadcrumb(breadcrumb as unknown as RedactableBreadcrumb);
          return breadcrumb;
        },
      });
      sentryModule = mod;
      flushPreInitCaptureQueue(mod);
      return mod;
    } catch {
      // Network / CSP / dynamic-import failure: Sentry is best-effort.
      // eslint-disable-next-line no-console
      console.warn("[postwave-sentry] init failed");
      preInitCaptureQueue = [];
      return null;
    } finally {
      initialized = true;
    }
  })();

  await initPromise;
}

/**
 * Log an exception without forcing every caller to import `@sentry/react`
 * directly. When no DSN is set this is a cheap no-op (and the call site
 * holds NO reference to the Sentry SDK, so the bundler can drop it).
 *
 * When a DSN is set but `initSentry()` hasn't finished yet, the
 * exception is queued (bounded) and flushed once init resolves — plus
 * logged to the console as a fallback so the error isn't silently
 * swallowed if init ultimately fails.
 */
export function captureException(err: unknown): void {
  if (!readDsn()) return;
  if (sentryModule) {
    try {
      sentryModule.captureException(err);
      return;
    } catch {
      /* fall through to console */
    }
  }
  if (!initialized && preInitCaptureQueue.length < MAX_PRE_INIT_CAPTURE_QUEUE) {
    preInitCaptureQueue.push(err);
  }
  // eslint-disable-next-line no-console
  console.error("[postwave-sentry] captureException queued before init");
}

interface SentryErrorBoundaryProps {
  children: ReactNode;
  // Constrained to ReactElement to match @sentry/react's ErrorBoundary
  // typing — `null` / fragments aren't supported as fallbacks. Callers
  // wrap text/JSX in a single root element (e.g. <div>...</div>).
  fallback?: ReactElement;
}

interface LazyBoundaryState {
  // Holds the loaded Sentry ErrorBoundary class as `unknown` so the no-DSN
  // build never needs the @sentry/react value-position types at compile
  // time. The render path narrows it back via createElement.
  Loaded: unknown;
}

/**
 * Lazy wrapper around `Sentry.ErrorBoundary`. Acts as a passthrough until
 * the Sentry chunk has loaded (or forever, in the no-DSN case). On its
 * mount path we kick the dynamic import and swap the inner boundary in
 * once available.
 *
 * If you flip this back to importing `@sentry/react` at the module top
 * level, you defeat the lazy-load and re-introduce the ~77KB cold-start
 * cost — which is the whole point of this file and is enforced by the
 * bundle-size guard in apps/desktop/scripts/check-bundle-size.mjs.
 */
export class SentryErrorBoundary extends Component<
  SentryErrorBoundaryProps,
  LazyBoundaryState
> {
  private mounted = false;

  constructor(props: SentryErrorBoundaryProps) {
    super(props);
    this.state = { Loaded: null };
  }

  override componentDidMount(): void {
    this.mounted = true;
    if (!readDsn()) return;
    void this.load();
  }

  override componentWillUnmount(): void {
    this.mounted = false;
  }

  override componentDidCatch(error: unknown, _info: ErrorInfo): void {
    // When Sentry hasn't loaded yet, still surface the exception via
    // our wrapper so the console fallback sees it.
    captureException(error);
  }

  private async load(): Promise<void> {
    try {
      // Reuse the initSentry promise so we don't double-import.
      await initSentry();
      if (sentryModule && this.mounted) {
        this.setState({ Loaded: sentryModule.ErrorBoundary });
      }
    } catch {
      /* keep passthrough; main init already logged */
    }
  }

  override render(): ReactNode {
    const { Loaded } = this.state;
    if (Loaded) {
      // Cast through `any` to dodge the structural mismatch between
      // @sentry/react's ErrorBoundary generic prop shape and our local
      // prop type; the runtime shape is verified by the Sentry SDK itself.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const BoundaryCmp = Loaded as any;
      return createElement(
        BoundaryCmp,
        { fallback: this.props.fallback },
        this.props.children,
      );
    }
    return this.props.children;
  }
}
