/**
 * Moosewave Desktop frontend shell — native productivity-app layout.
 *
 * Boot pipeline:
 *   1. Detect we're inside Tauri (else NotInTauri screen).
 *   2. Detect offline boot only when we have no remembered local session.
 *   3. If no API URL is configured yet → Welcome (first-run setup).
 *   4. Otherwise render the AppShell with the active section.
 *
 * We render every screen ourselves — no remote redirects. Deep-links and
 * tray events route to the in-memory store and switch the active section.
 */

import {
  Component,
  Suspense,
  lazy,
  type Dispatch,
  type ErrorInfo,
  type ReactElement,
  type ReactNode,
  type SetStateAction,
  useCallback,
  useEffect,
  useState,
} from "react";

import { listen } from "@tauri-apps/api/event";

import { AppShell } from "./components/AppShell";
import { StepUpPrompt } from "./components/StepUpPrompt";
import { BootScreen } from "./components/BootScreen";
import { ErrorScreen } from "./components/ErrorScreen";
import { NotInTauri } from "./components/NotInTauri";
import { OfflineScreen } from "./components/OfflineScreen";
import { RecoverableSuspense } from "./components/RecoverableSuspense";
/* Product education surfaces share one versioned, identity-scoped state
 * machine. The provider retains spotlight presentation only. */
import { TourLauncher } from "./components/tour/TourLauncher";
import { TourProvider } from "./components/tour/TourProvider";
import { ShortcutChordHud } from "./components/ShortcutChordHud";
/* OnboardingWizard is lazy-loaded and derives eligibility from the shared
 * server-backed onboarding state. We mount it
 * unconditionally at the shell level once the boot pipeline reaches
 * "ready"; paying for the chunk is fine because the actual decision is
 * cheap (three already-cached probes) and the wizard chunk is small. */
const OnboardingWizard = lazy(() =>
  import("./components/OnboardingWizard").then((m) => ({
    default: m.OnboardingWizard,
  })),
);
import {
  detectSession,
  extractAuthToken,
  hasRememberedSession,
  type DesktopAuthLinkProof,
} from "./lib/auth";
import { consumeAuthReturnState } from "./lib/auth-flow-state";
import {
  authStateFailureToRecovery,
  type AuthLinkRecoveryReason,
} from "./lib/auth-link-recovery";
import {
  flushQueuedMutations,
  onApiUnauthorized,
  rememberSession,
} from "./lib/api-client";
import { getOfflineIdentity, hydrateOfflineStores } from "./lib/offline-store";
import { AppEventNotifier } from "./lib/app-notifier";
import { ResumeCursorRecorder } from "./lib/activity-cursor";
import { NotificationFeedSync } from "./lib/notification-feed-sync";
import { AppCacheInvalidator } from "./lib/cache-invalidator";
import { onDeepLink, onDeepLinkRejection } from "./lib/deep-link";
import { mapDeepLinkToPath } from "./lib/dashboard-url";
import {
  armDesktopHealthySession,
  captureRendererIncident,
  isDesktopSafeMode,
  type DesktopIncident,
} from "./lib/desktop-diagnostics";
import { EventBusProvider } from "./lib/event-bus";
import {
  parseMigrationApiKeyReturn,
  setPendingMigrationApiKeyReturn,
} from "./lib/migration-deep-link";
import { subscribeOnlineStatus } from "./lib/online-manager";
import {
  buildCacheBuster,
  clearPersistedQueryCache,
  idbPersister,
  queryClient,
  wireContextEpochCacheReset,
  wireTanstackOnlineManager,
} from "./lib/query-client";
import { navigateDesktopRoute, parseDesktopRoute } from "./lib/desktop-router";
import {
  identifyWorkspace as identifyTelemetry,
  track as trackTelemetry,
} from "./lib/telemetry";
import {
  createDesktopShortcutDispatcher,
  type ShortcutChordState,
} from "./lib/desktop-shortcut-dispatcher";
import type { DesktopShortcutIntent } from "./lib/desktop-shortcuts";
import { topDialog } from "./lib/dialogStack";
import { requestHelpLauncherToggle } from "./lib/help-launcher";
import { requestOnboardingWizardRestart } from "./hooks/useOnboardingState";
import {
  type Section,
  eventToSection,
  loadMe,
  setConn,
  setSection,
  toggleCommand,
  useMe,
  useSection,
} from "./lib/store";
import { isTauri } from "./lib/tauri";
import { setPendingCampaignDraft } from "./lib/template-handoff";
import { PersistQueryClientProvider } from "@tanstack/react-query-persist-client";

/* Auth screens stay eagerly imported — they're pre-shell and gating
 * speed matters more than bundle size here (the user can't see anything
 * until SignIn renders). */
import { MagicLinkReturn } from "./pages/MagicLinkReturn";
import { AuthLinkRecovery } from "./pages/AuthLinkRecovery";
import { PasswordReset } from "./pages/PasswordReset";
import { PasswordResetConfirm } from "./pages/PasswordResetConfirm";
import { SignIn } from "./pages/SignIn";
import type { SignInMethod } from "./pages/SignIn";
import { Welcome } from "./pages/Welcome";

/* Section pages are lazy-loaded so each ships as its own chunk. The
 * `.then(m => ({ default: m.Foo }))` shape adapts the named exports
 * (`export function Foo`) to the default-export shape that React.lazy
 * requires. */
const Analytics = lazy(() =>
  import("./pages/Analytics").then((m) => ({ default: m.Analytics })),
);
const Approvals = lazy(() =>
  import("./pages/Approvals").then((m) => ({ default: m.Approvals })),
);
const Archive = lazy(() =>
  import("./pages/Archive").then((m) => ({ default: m.Archive })),
);
const Assets = lazy(() =>
  import("./pages/Assets").then((m) => ({ default: m.Assets })),
);
/* Collections — reference-collection admin (SUB-014). Lives under
 * components/ rather than pages/ but is a full-surface section like any
 * other; lazy-loaded so its chunk only ships when reached. */
const Collections = lazy(() =>
  import("./components/Collections").then((m) => ({ default: m.Collections })),
);
const Agency = lazy(() =>
  import("./pages/Agency").then((m) => ({ default: m.Agency })),
);
const Audit = lazy(() =>
  import("./pages/Audit").then((m) => ({ default: m.Audit })),
);
const Consent = lazy(() =>
  import("./pages/Consent").then((m) => ({ default: m.Consent })),
);
const MCP = lazy(() => import("./pages/MCP").then((m) => ({ default: m.MCP })));
const SMSInbox = lazy(() =>
  import("./pages/SMSInbox").then((m) => ({ default: m.SMSInbox })),
);
const Helpdesk = lazy(() =>
  import("./pages/Helpdesk").then((m) => ({ default: m.Helpdesk })),
);
const APIPlayground = lazy(() =>
  import("./pages/APIPlayground").then((m) => ({ default: m.APIPlayground })),
);
const WebhookSimulator = lazy(() =>
  import("./pages/WebhookSimulator").then((m) => ({
    default: m.WebhookSimulator,
  })),
);
const AuditSinks = lazy(() =>
  import("./pages/AuditSinks").then((m) => ({ default: m.AuditSinks })),
);
const AuditAlerts = lazy(() =>
  import("./pages/AuditAlerts").then((m) => ({ default: m.AuditAlerts })),
);
const AuditInvestigation = lazy(() =>
  import("./pages/AuditInvestigation").then((m) => ({
    default: m.AuditInvestigation,
  })),
);
const InboundRoutes = lazy(() =>
  import("./pages/InboundRoutes").then((m) => ({ default: m.InboundRoutes })),
);
const Integrations = lazy(() =>
  import("./pages/Integrations").then((m) => ({ default: m.Integrations })),
);
const Compliance = lazy(() =>
  import("./pages/Compliance").then((m) => ({ default: m.Compliance })),
);
const PrivacyIncidents = lazy(() =>
  import("./pages/PrivacyIncidents").then((m) => ({
    default: m.PrivacyIncidents,
  })),
);
const SCIM = lazy(() =>
  import("./pages/SCIM").then((m) => ({ default: m.SCIM })),
);
const Campaigns = lazy(() =>
  import("./pages/Campaigns").then((m) => ({ default: m.Campaigns })),
);
const CustomDomains = lazy(() =>
  import("./pages/CustomDomains").then((m) => ({ default: m.CustomDomains })),
);
const Dashboard = lazy(() =>
  import("./pages/Dashboard").then((m) => ({ default: m.Dashboard })),
);
const Discounts = lazy(() =>
  import("./pages/Discounts").then((m) => ({ default: m.Discounts })),
);
const DmarcReports = lazy(() =>
  import("./pages/DmarcReports").then((m) => ({ default: m.DmarcReports })),
);
const Forms = lazy(() =>
  import("./pages/Forms").then((m) => ({ default: m.Forms })),
);
const GiftSubscriptions = lazy(() =>
  import("./pages/GiftSubscriptions").then((m) => ({
    default: m.GiftSubscriptions,
  })),
);
// PR 4: a single unified WebhooksHome replaces the two separate
// pages in the nav. WebhooksHome internally imports both pages.
const WebhooksHome = lazy(() =>
  import("./pages/WebhooksHome").then((m) => ({ default: m.WebhooksHome })),
);
const Lists = lazy(() =>
  import("./pages/Lists").then((m) => ({ default: m.Lists })),
);
const Migrations = lazy(() =>
  import("./pages/Migrations").then((m) => ({ default: m.Migrations })),
);
const PostwaveAI = lazy(() =>
  import("./pages/PostwaveAI").then((m) => ({ default: m.PostwaveAI })),
);
const ModelChangelogPanel = lazy(() =>
  import("./components/ai/ModelChangelogPanel").then((m) => ({
    default: m.ModelChangelogPanel,
  })),
);
const Referrals = lazy(() =>
  import("./pages/Referrals").then((m) => ({ default: m.Referrals })),
);
const RetentionOffers = lazy(() =>
  import("./pages/RetentionOffers").then((m) => ({
    default: m.default,
  })),
);
const SendTime = lazy(() =>
  import("./pages/SendTime").then((m) => ({ default: m.SendTime })),
);
const SendingSettings = lazy(() =>
  import("./pages/SendingSettings").then((m) => ({
    default: m.SendingSettings,
  })),
);
const Sequences = lazy(() =>
  import("./pages/Sequences").then((m) => ({ default: m.Sequences })),
);
const Automations = lazy(() =>
  import("./pages/Automations").then((m) => ({ default: m.Automations })),
);
const Affiliates = lazy(() =>
  import("./pages/Affiliates").then((m) => ({ default: m.Affiliates })),
);
const Commerce = lazy(() =>
  import("./pages/Commerce").then((m) => ({ default: m.Commerce })),
);
const Reviews = lazy(() =>
  import("./pages/Reviews").then((m) => ({ default: m.Reviews })),
);
const DataPlatform = lazy(() =>
  import("./pages/DataPlatform").then((m) => ({ default: m.DataPlatform })),
);
const Settings = lazy(() =>
  import("./pages/Settings").then((m) => ({ default: m.Settings })),
);
const Subscribers = lazy(() =>
  import("./pages/Subscribers").then((m) => ({ default: m.Subscribers })),
);
const Suppressions = lazy(() =>
  import("./pages/Suppressions").then((m) => ({ default: m.Suppressions })),
);
// Wave 2/3: SMS + Push suppression surfaces (GAP-LS-014 / GAP-LS-015).
// Lazy-loaded like every other section page so first-paint stays cheap
// for tenants that don't use these channels.
const SmsSuppressions = lazy(() =>
  import("./pages/SmsSuppressions").then((m) => ({
    default: m.SmsSuppressions,
  })),
);
const PushSuppressions = lazy(() =>
  import("./pages/PushSuppressions").then((m) => ({
    default: m.PushSuppressions,
  })),
);
const Segments = lazy(() =>
  import("./pages/Segments").then((m) => ({ default: m.Segments })),
);
const DeliverabilityHub = lazy(() =>
  import("./pages/DeliverabilityHub").then((m) => ({
    default: m.DeliverabilityHub,
  })),
);
const PrivacyPortal = lazy(() =>
  import("./pages/PrivacyPortal").then((m) => ({ default: m.PrivacyPortal })),
);
const AudienceSyncs = lazy(() =>
  import("./pages/AudienceSyncs").then((m) => ({ default: m.AudienceSyncs })),
);
const Tags = lazy(() =>
  import("./pages/Tags").then((m) => ({ default: m.Tags })),
);
const Templates = lazy(() =>
  import("./pages/Templates").then((m) => ({ default: m.Templates })),
);
const Track = lazy(() =>
  import("./pages/Track").then((m) => ({ default: m.Track })),
);

/**
 * Skeleton shown while a section page chunk is being fetched. Matches
 * the standard `.page-header` layout so the swap doesn't cause layout
 * thrash.
 */
function SectionLoading(): ReactElement {
  return (
    <div role="status" aria-live="polite" aria-busy="true">
      <div className="page-header">
        <div style={{ flex: 1 }}>
          <div className="skel" style={{ height: 20, width: 180 }} />
          <div
            className="skel"
            style={{ height: 13, width: 240, marginTop: 6 }}
          />
        </div>
      </div>
      <div
        className="skel"
        style={{ height: 14, margin: "10px 0", width: "92%" }}
      />
      <div
        className="skel"
        style={{ height: 14, margin: "10px 0", width: "78%" }}
      />
      <div
        className="skel"
        style={{ height: 14, margin: "10px 0", width: "85%" }}
      />
    </div>
  );
}

const TRAY_MENU_EVENTS = [
  "menu:new-campaign",
  "menu:settings",
  "menu:approvals",
  "menu:dashboard",
  "tray:open",
  "tray:new-campaign",
  "tray:settings",
];

type BootKind =
  | "loading"
  | "not-in-tauri"
  | "offline"
  | "signin" // primary email-auth surface
  | "welcome" // legacy API-key first-run (opt-in via SignIn fallback)
  | "password-reset" // user clicked "Forgot password"
  | "reset-confirm" // arrived via signed moosewave://auth/reset envelope
  | "magic-return" // arrived via signed moosewave://auth/magic envelope
  | "auth-link-recovery" // rejected/expired/mismatched native auth intent
  | "ready";

interface AuthLinkRecoveryState {
  flow: "magic" | "reset" | null;
  reason: AuthLinkRecoveryReason;
}

type StateSetter<T> = Dispatch<SetStateAction<T>>;

interface SessionLifecycleOptions {
  boot: BootKind;
  setBoot: StateSetter<BootKind>;
  finishBoot: (next: BootKind) => void;
}

function useSessionLifecycle({
  boot,
  setBoot,
  finishBoot,
}: SessionLifecycleOptions): void {
  /* Initial gating: tauri / online / session-cookie OR API key. */
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!isTauri()) {
      const isDev =
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ((import.meta as any).env as { DEV?: boolean } | undefined)?.DEV ===
        true;
      if (!isDev) {
        setBoot("not-in-tauri");
        return;
      }
    }
    void (async () => {
      await hydrateOfflineStores();
      const status = await detectSession();
      if (status.kind === "session") {
        finishBoot("ready");
        trackTelemetry("auth_method", { method: "session" });
        void loadMe();
        return;
      }
      if (status.kind === "api-key") {
        finishBoot("ready");
        trackTelemetry("auth_method", { method: "api_key" });
        void loadMe();
        return;
      }
      if (status.kind === "offline") {
        if (hasRememberedSession() || getOfflineIdentity() != null) {
          finishBoot("ready");
          void loadMe();
        } else {
          setConn("offline");
          finishBoot("offline");
        }
        return;
      }
      finishBoot("signin");
    })();
  }, [finishBoot, setBoot]);

  /* Route a mid-session expiry back through the local sign-in surface. */
  useEffect(
    () =>
      onApiUnauthorized(() => {
        rememberSession(null);
        void clearPersistedQueryCache();
        setBoot((current) => (current === "ready" ? "signin" : current));
      }),
    [setBoot],
  );

  useEffect(() => {
    const handleOnline = (): void => {
      setConn("connecting");
      void flushQueuedMutations();
      if (boot !== "offline") return;
      void (async () => {
        const status = await detectSession();
        if (status.kind === "session" || status.kind === "api-key") {
          setBoot("ready");
          void loadMe();
        } else if (status.kind === "offline") {
          if (hasRememberedSession()) {
            setBoot("ready");
            void loadMe();
          }
        } else {
          setBoot("signin");
        }
      })();
    };
    const handleOffline = (): void => {
      setConn("offline");
      if (boot === "welcome" || boot === "signin") setBoot("offline");
    };
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, [boot, setBoot]);
}

interface NativeIntentRoutingOptions {
  boot: BootKind;
  setBoot: StateSetter<BootKind>;
  setAuthLinkProof: StateSetter<DesktopAuthLinkProof | null>;
  setAuthLinkRecovery: StateSetter<AuthLinkRecoveryState | null>;
  setComposeNonce: StateSetter<number>;
  setShortcutChord: StateSetter<ShortcutChordState | null>;
}

function useNativeIntentRouting({
  boot,
  setBoot,
  setAuthLinkProof,
  setAuthLinkRecovery,
  setComposeNonce,
  setShortcutChord,
}: NativeIntentRoutingOptions): void {
  useEffect(() => {
    const unsubscribeOpened = onDeepLink((url) => {
      const proof = extractAuthToken(url);
      if (proof) {
        const verified = consumeAuthReturnState(proof.link_flow, proof.state);
        if (!verified.ok) {
          setAuthLinkProof(null);
          setAuthLinkRecovery({
            flow: proof.link_flow,
            reason: authStateFailureToRecovery(verified.reason),
          });
          setBoot("auth-link-recovery");
          return;
        }
        setAuthLinkRecovery(null);
        setAuthLinkProof(proof);
        setBoot(proof.link_flow === "magic" ? "magic-return" : "reset-confirm");
        return;
      }
      const path = mapDeepLinkToPath(url);
      if (!path) return;
      const migrationApiKeyReturn = parseMigrationApiKeyReturn(path);
      if (migrationApiKeyReturn) {
        setPendingMigrationApiKeyReturn(migrationApiKeyReturn);
      }
      const routeInput = migrationApiKeyReturn
        ? new URL(path, "https://postwave.local").pathname
        : path;
      const parsed = parseDesktopRoute(routeInput);
      if (parsed.ok) {
        navigateDesktopRoute(parsed.route, { source: "deep-link" });
      }
    });
    const unsubscribeRejected = onDeepLinkRejection((rejection) => {
      setAuthLinkProof(null);
      setAuthLinkRecovery(rejection);
      setBoot("auth-link-recovery");
    });
    return () => {
      unsubscribeOpened();
      unsubscribeRejected();
    };
  }, [setAuthLinkProof, setAuthLinkRecovery, setBoot]);

  useEffect(() => {
    if (!isTauri()) return;
    const disposers: Array<() => void> = [];
    let cancelled = false;
    for (const event of TRAY_MENU_EVENTS) {
      void listen(event, () => {
        if (cancelled) return;
        if (event === "menu:new-campaign" || event === "tray:new-campaign") {
          setPendingCampaignDraft({});
          setComposeNonce((nonce) => nonce + 1);
          setSection("campaigns");
          return;
        }
        const nextSection = eventToSection(event);
        if (nextSection) setSection(nextSection);
      })
        .then((unlisten) => {
          if (cancelled) unlisten();
          else disposers.push(unlisten);
        })
        .catch(() => {
          // eslint-disable-next-line no-console
          console.warn(`[postwave-desktop] failed to subscribe to ${event}`);
        });
    }
    return () => {
      cancelled = true;
      for (const dispose of disposers) {
        try {
          dispose();
        } catch {
          /* ignore */
        }
      }
    };
  }, [setComposeNonce]);

  useEffect(() => {
    if (!isTauri() || boot !== "ready") return;
    let cancelled = false;
    let dispose: (() => void) | null = null;
    void listen("quick-compose", () => {
      if (cancelled) return;
      setPendingCampaignDraft({});
      setComposeNonce((nonce) => nonce + 1);
      setSection("campaigns");
      trackTelemetry("quick_compose_shortcut");
    })
      .then((unlisten) => {
        if (cancelled) unlisten();
        else dispose = unlisten;
      })
      .catch(() => {
        // eslint-disable-next-line no-console
        console.warn("[postwave-desktop] failed to subscribe to quick-compose");
      });
    return () => {
      cancelled = true;
      try {
        dispose?.();
      } catch {
        /* ignore */
      }
    };
  }, [boot, setComposeNonce]);

  useEffect(() => {
    if (boot !== "ready") return;
    const runIntent = (intent: DesktopShortcutIntent): void => {
      switch (intent.kind) {
        case "command-palette.toggle":
          toggleCommand();
          trackTelemetry("command_palette_opened");
          return;
        case "help.toggle":
          requestHelpLauncherToggle();
          return;
        case "onboarding.restart":
          requestOnboardingWizardRestart();
          return;
        case "section.open":
          setSection(intent.section);
          return;
        case "campaign.create":
        case "window.close":
        case "app.quit":
        case "settings.open":
        case "native.quick-compose":
          return;
      }
    };
    const dispatcher = createDesktopShortcutDispatcher({
      onIntent: runIntent,
      onChordChange: setShortcutChord,
      overlayActive: () => topDialog() !== null,
    });
    const onKey = (event: KeyboardEvent): void => {
      dispatcher.handle(event);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      dispatcher.dispose();
    };
  }, [boot, setShortcutChord]);
}

// Bridge TanStack's onlineManager to the Moosewave unified online signal
// so paused queries resume on the SAME criterion the rest of the app uses
// (navigator.onLine + heartbeat + real-request success window). Idempotent.
wireTanstackOnlineManager(subscribeOnlineStatus);
// Drop cached answers when the server reports the caller's context moved. The
// QueryClient here is a module singleton created once at launch, so nothing
// else rebuilds it when a role or plan changes under a window that stays open.
wireContextEpochCacheReset();

export function App(): ReactElement {
  const [boot, setBoot] = useState<BootKind>("loading");
  const [signInMethod, setSignInMethod] = useState<SignInMethod>("password");
  const [passwordResetEmail, setPasswordResetEmail] = useState("");
  const [authLinkProof, setAuthLinkProof] =
    useState<DesktopAuthLinkProof | null>(null);
  const [authLinkRecovery, setAuthLinkRecovery] =
    useState<AuthLinkRecoveryState | null>(null);
  /* Quick-compose remount nonce — bumped on every global-shortcut
     trigger so the Campaigns page remounts (and re-runs its mount-time
     pending-draft consumption) even when it is already the active
     section. See the quick-compose effect below. */
  const [composeNonce, setComposeNonce] = useState(0);
  const [shortcutChord, setShortcutChord] = useState<ShortcutChordState | null>(
    null,
  );
  const section = useSection();
  const me = useMe();
  // Per-identity cache buster: changing user OR tenant nukes the persisted
  // cache so a re-login can never reveal another identity's data.
  const buster = buildCacheBuster(me?.user, me?.tenant);

  /* Async session-detection completions must NOT clobber an auth deep-
     link screen ("magic-return"/"reset-confirm") that arrived while the
     detection was in flight — cold-start magic links race detectSession()
     and used to dump the user on SignIn with the token lost. */
  const finishBoot = useCallback((next: BootKind): void => {
    setBoot((cur) =>
      cur === "magic-return" ||
      cur === "reset-confirm" ||
      cur === "auth-link-recovery"
        ? cur
        : next,
    );
  }, []);

  useSessionLifecycle({ boot, setBoot, finishBoot });
  useNativeIntentRouting({
    boot,
    setBoot,
    setAuthLinkProof,
    setAuthLinkRecovery,
    setComposeNonce,
    setShortcutChord,
  });

  /* Telemetry: fire `app_opened` exactly once when the boot pipeline
     reaches "ready". `section_viewed` fires on each distinct section
     a session lands on (the Set guards against double-fires from the
     keyboard nav re-render storms). */
  useEffect(() => {
    if (boot !== "ready") return;
    trackTelemetry("app_opened");
  }, [boot]);

  useEffect(() => {
    if (boot !== "ready") return;
    trackTelemetry("section_viewed", { section });
  }, [boot, section]);

  /* Telemetry identity lifecycle: only the provenance-qualified pair created
     from /auth/me may identify. API-key actor labels are caller-controlled
     display text (and may even look like UUIDs), so they never populate this
     pair. The telemetry boundary also validates UUIDs defense-in-depth. The
     matching `reset()` runs in fullSignOut. */
  useEffect(() => {
    const identity = me?.telemetryIdentity;
    void identifyTelemetry(
      identity?.user ?? null,
      identity?.tenant ?? null,
      identity?.apiBaseUrl ?? null,
    );
  }, [
    me?.telemetryIdentity?.apiBaseUrl,
    me?.telemetryIdentity?.tenant,
    me?.telemetryIdentity?.user,
  ]);

  /* First-run onboarding reads the shared identity-scoped state machine and
     server progress, then renders only when its role/eligibility policy wins.
     Mounting it here does not independently trigger an overlay. */

  const onWelcomeDone = useCallback(() => {
    setBoot("ready");
    void loadMe();
  }, []);

  const retry = useCallback(() => {
    void (async () => {
      const status = await detectSession();
      if (status.kind === "session" || status.kind === "api-key") {
        setBoot("ready");
        void loadMe();
      } else if (status.kind === "offline") {
        if (hasRememberedSession()) {
          setBoot("ready");
          void loadMe();
        } else {
          setConn("offline");
          setBoot("offline");
        }
      } else {
        setBoot("signin");
      }
    })();
  }, []);

  if (boot === "loading") {
    // Branded boot screen (D15#11: was an inline duplicate that dropped the
    // seasonal-wordmark treatment BootScreen provides).
    return <BootScreen />;
  }
  if (boot === "not-in-tauri") return <NotInTauri />;
  if (boot === "offline") return <OfflineScreen onRetry={retry} />;
  if (boot === "signin")
    return (
      <SignIn
        initialMethod={signInMethod}
        onSignedIn={() => {
          setBoot("ready");
          void loadMe();
        }}
        onUseApiKey={() => setBoot("welcome")}
        onForgotPassword={(email) => {
          setPasswordResetEmail(email);
          setBoot("password-reset");
        }}
      />
    );
  if (boot === "password-reset")
    return (
      <PasswordReset
        initialEmail={passwordResetEmail}
        onBack={() => setBoot("signin")}
      />
    );
  if (boot === "auth-link-recovery") {
    const recovery = authLinkRecovery ?? {
      flow: null,
      reason: "invalid_link" as const,
    };
    return (
      <AuthLinkRecovery
        flow={recovery.flow}
        reason={recovery.reason}
        onRequestNewLink={() => {
          setAuthLinkRecovery(null);
          if (recovery.flow !== "reset") setSignInMethod("magic");
          setBoot(recovery.flow === "reset" ? "password-reset" : "signin");
        }}
        onUseAnotherMethod={() => {
          setAuthLinkRecovery(null);
          setSignInMethod("password");
          setBoot("signin");
        }}
      />
    );
  }
  if (boot === "reset-confirm")
    return (
      <PasswordResetConfirm
        proof={authLinkProof!}
        onRequestNewLink={() => {
          setAuthLinkProof(null);
          setBoot("password-reset");
        }}
        onDone={() => {
          setAuthLinkProof(null);
          setSignInMethod("password");
          setBoot("signin");
        }}
      />
    );
  if (boot === "magic-return")
    return (
      <MagicLinkReturn
        proof={authLinkProof!}
        onRequestNewLink={() => {
          setAuthLinkProof(null);
          setSignInMethod("magic");
          setBoot("signin");
        }}
        onSignedIn={() => {
          setAuthLinkProof(null);
          setBoot("ready");
          void loadMe();
        }}
        onCancel={() => {
          setAuthLinkProof(null);
          setSignInMethod("password");
          setBoot("signin");
        }}
      />
    );
  if (boot === "welcome") return <Welcome onDone={onWelcomeDone} />;

  const safeMode = isDesktopSafeMode();
  const productShell = (topbarAccessory?: ReactNode): ReactElement => (
    <>
      <AppShell topbarAccessory={topbarAccessory}>
        <RecoverableSuspense fallback={<SectionLoading />}>
          {renderSection(section, composeNonce)}
        </RecoverableSuspense>
      </AppShell>
      <ShortcutChordHud state={shortcutChord} />
    </>
  );

  return (
    <PersistQueryClientProvider
      key={buster}
      client={queryClient}
      persistOptions={{
        persister: idbPersister,
        buster,
        maxAge: 8 * 60 * 60 * 1000,
      }}
    >
      <EventBusProvider>
        {/* App-level OS-notification router: fires for notify-worthy
            server events (approval.requested / campaign.sent / bounce)
            no matter which page is mounted. Reuses the shared SSE
            event-bus — no new transport. */}
        {!safeMode && <AppEventNotifier />}
        {/* App-level event-bus cache invalidation (initiative #2): the
            SAME shared SSE event-bus refreshes TanStack Query caches on
            campaign.* / subscriber.* / list.* / approval.* / sequence.*
            so the UI tracks live server state instead of waiting out
            staleTime. Additive to AppEventNotifier — does not replace it. */}
        {!safeMode && <AppCacheInvalidator queryClient={queryClient} />}
        {/* Cross-device continuity (Phase 1): record the entity behind the
            current route so the user's OTHER devices can offer "Continue".
            Mounted at the shell and driven off the parsed route, so every
            detail destination the registry knows is covered without each page
            remembering to opt in. Off in safe mode with the rest of the
            network-touching shell. */}
        {!safeMode && <ResumeCursorRecorder />}
        {/* Keeps the bell's read/unread in agreement with the server feed, so
            marking something read on a phone clears it here and vice versa.
            Desktop was the only client with a private notification store. */}
        {!safeMode && <NotificationFeedSync />}
        {/* The dialog a step-up challenge raises instead of a logout. Mounted
            unconditionally — including in safe mode — because the transport
            gives up on any challenge nobody claims, and "safe mode" must not
            silently mean "rotating an API key signs you out". Renders null
            until a challenge actually arrives. */}
        <StepUpPrompt />
        {safeMode ? (
          productShell()
        ) : (
          <TourProvider>
            {productShell(<TourLauncher />)}
            <Suspense fallback={null}>
              <OnboardingWizard />
            </Suspense>
          </TourProvider>
        )}
      </EventBusProvider>
    </PersistQueryClientProvider>
  );
}

const EXTRA_SECTION_RENDERERS: Readonly<Record<string, () => ReactElement>> = {
  smsSuppressions: () => <SmsSuppressions />,
  pushSuppressions: () => <PushSuppressions />,
  segments: () => <Segments />,
  deliverabilityHub: () => <DeliverabilityHub />,
  privacyPortal: () => <PrivacyPortal />,
  audienceSyncs: () => <AudienceSyncs />,
};

const SECTION_RENDERERS = {
  dashboard: () => <Dashboard />,
  subscribers: () => <Subscribers />,
  sequences: () => <Sequences />,
  automations: () => <Automations />,
  forms: () => <Forms />,
  templates: () => <Templates />,
  analytics: () => <Analytics />,
  approvals: () => <Approvals />,
  audit: () => <Audit />,
  consent: () => <Consent />,
  mcp: () => <MCP />,
  smsInbox: () => <SMSInbox />,
  helpdesk: () => <Helpdesk />,
  apiPlayground: () => <APIPlayground />,
  webhookSimulator: () => <WebhookSimulator />,
  ai: () => <PostwaveAI />,
  aiChangelog: () => <ModelChangelogPanel />,
  migrations: () => <Migrations />,
  integrations: () => <Integrations />,
  dataPlatform: () => <DataPlatform />,
  tags: () => <Tags />,
  lists: () => <Lists />,
  suppressions: () => <Suppressions />,
  assets: () => <Assets />,
  collections: () => <Collections />,
  webhooks: () => <WebhooksHome />,
  outboundWebhooks: () => <WebhooksHome />,
  track: () => <Track />,
  sendtime: () => <SendTime />,
  archive: () => <Archive />,
  referrals: () => <Referrals />,
  affiliates: () => <Affiliates />,
  retentionOffers: () => <RetentionOffers />,
  discounts: () => <Discounts />,
  gifts: () => <GiftSubscriptions />,
  commerce: () => <Commerce />,
  reviews: () => <Reviews />,
  domains: () => <CustomDomains />,
  dmarc: () => <DmarcReports />,
  sending: () => <SendingSettings />,
  agency: () => <Agency />,
  inboundRoutes: () => <InboundRoutes />,
  scim: () => <SCIM />,
  hipaa: () => <Compliance />,
  compliance: () => <Compliance />,
  privacyIncidents: () => <PrivacyIncidents />,
  auditSinks: () => <AuditSinks />,
  auditAlerts: () => <AuditAlerts />,
  auditInvestigation: () => <AuditInvestigation />,
  settings: () => <Settings />,
} satisfies Partial<Record<Section, () => ReactElement>>;

function renderSection(section: Section, composeNonce: number): ReactElement {
  const extraRenderer = EXTRA_SECTION_RENDERERS[section as string];
  if (extraRenderer) return extraRenderer();
  // A nonce remounts Campaigns when quick-compose fires on the active page.
  if (section === "campaigns") {
    return <Campaigns key={`campaigns-${composeNonce}`} />;
  }
  const renderer = SECTION_RENDERERS[section as keyof typeof SECTION_RENDERERS];
  return renderer ? renderer() : <Dashboard />;
}

/* ---------- error boundary ------------------------------------------- */

interface ErrorBoundaryProps {
  children: ReactNode;
}
interface ErrorBoundaryState {
  error: unknown | null;
  incident: DesktopIncident | null;
}

export class AppErrorBoundary extends Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  override state: ErrorBoundaryState = { error: null, incident: null };

  private cancelHealthySession: () => void = () => undefined;

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    return { error, incident: null };
  }

  override componentDidMount(): void {
    this.cancelHealthySession = armDesktopHealthySession();
  }

  override componentWillUnmount(): void {
    this.cancelHealthySession();
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    this.cancelHealthySession();
    const incident = captureRendererIncident("renderer_boundary", error, {
      fatal: true,
      componentStack: info.componentStack,
    });
    this.setState({ incident });
    const isDev =
      ((import.meta as any).env as { DEV?: boolean } | undefined)?.DEV === true;
    if (isDev) {
      // eslint-disable-next-line no-console
      console.error("[postwave-desktop] uncaught:", error, info.componentStack);
    }
  }

  private readonly handleReset = (): void => {
    this.setState({ error: null, incident: null });
    this.cancelHealthySession = armDesktopHealthySession();
  };

  override render(): ReactNode {
    if (this.state.error !== null) {
      return (
        <ErrorScreen
          error={this.state.error}
          incident={this.state.incident}
          onRetry={this.handleReset}
        />
      );
    }
    return this.props.children;
  }
}
