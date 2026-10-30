// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import Link from "next/link";
import dynamic from "next/dynamic";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  lazy,
  Suspense,
  useEffect,
  useCallback,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type MutableRefObject,
  type ReactNode,
} from "react";
import {
  ChevronsLeft,
  ChevronsRight,
  Loader2,
  Menu,
  Search,
  X,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { AUTH_SESSION_EXPIRED_EVENT } from "@/lib/auth-session-events";
import { clearOfflineStorage } from "@/lib/offline-storage-identity";
import { clearQueryState } from "@/lib/query-client";
import type { MeResponse } from "@/lib/auth-api";
import { firstFocusable, trapFocus } from "@/lib/focus-trap";
import { recordRecentDestination } from "@/lib/recent-destinations";
import {
  canAccessRetentionOffers,
  isRetentionOffersRoute,
} from "@/lib/retention-offers-access";
import { useNavBadges } from "@/lib/use-nav-badges";
import { PageTransition } from "@/components/motion/page-transition";
import { SampleDataNotice } from "@/components/dashboard/sample-data-notice";
import { MoosewaveWordmark } from "@/components/brand/moosewave-mark";
import { CommandRegistryProvider } from "@/components/command-registry";
import { QueryProvider } from "@/components/query-provider";
import { ThemeProvider } from "@/components/theme-provider";

import {
  DASHBOARD_NAV_ITEMS,
  DashboardNav,
  nextDashboardNavIndex,
} from "./dashboard-nav-shell";

const CommandPalette = dynamic(
  () =>
    import("@/components/command-palette").then((mod) => mod.CommandPalette),
  { ssr: false },
);

const OfflineBanner = dynamic(
  () => import("@/components/offline-banner").then((mod) => mod.OfflineBanner),
  { ssr: false },
);

const DashboardTourIsland = dynamic(
  () =>
    import("@/components/tour/dashboard-tour-island").then(
      (mod) => mod.DashboardTourIsland,
    ),
  { ssr: false, loading: () => null },
);

// Start fetching the interactive header controls as soon as the small shell
// chunk evaluates, while keeping their implementation out of every route's
// render-blocking graph. The shared promise also prevents four duplicate
// chunk requests and lets the controls be ready by the time hydration unlocks
// the shell in the normal case.
const dashboardHeaderControlsPromise = import("./dashboard-header-controls");

const TenantSwitcher = lazy(() =>
  dashboardHeaderControlsPromise.then((mod) => ({
    default: mod.TenantSwitcher,
  })),
);

const UserMenu = lazy(() =>
  dashboardHeaderControlsPromise.then((mod) => ({
    default: mod.UserMenu,
  })),
);

const CreateMenu = lazy(() =>
  dashboardHeaderControlsPromise.then((mod) => ({
    default: mod.CreateMenu,
  })),
);

const ThemeToggle = lazy(() =>
  dashboardHeaderControlsPromise.then((mod) => ({
    default: mod.ThemeToggle,
  })),
);

function HeaderControlLoading({ label }: { label: string }) {
  return (
    <span
      role="status"
      aria-live="polite"
      className="inline-flex h-11 w-11 items-center justify-center rounded-md text-muted-foreground sm:h-9 sm:w-9 [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-11"
    >
      <Loader2
        className="h-4 w-4 animate-spin motion-reduce:animate-none"
        aria-hidden
      />
      <span className="sr-only">{label}</span>
    </span>
  );
}

function WorkspaceControlLoading() {
  return (
    <span
      role="status"
      aria-live="polite"
      className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-muted-foreground md:h-9 md:w-40 md:justify-start md:gap-2 md:px-3"
    >
      <Loader2
        className="h-4 w-4 animate-spin motion-reduce:animate-none"
        aria-hidden
      />
      <span className="hidden text-sm md:inline">Loading workspace…</span>
      <span className="sr-only md:hidden">Loading workspace actions…</span>
    </span>
  );
}

const PresenceIndicator = dynamic(
  () =>
    import("@/components/presence-indicator").then(
      (mod) => mod.PresenceIndicator,
    ),
  { ssr: false, loading: () => null },
);

const QueueTrayLauncher = dynamic(
  () =>
    import("@/components/queue-tray-launcher").then(
      (mod) => mod.QueueTrayLauncher,
    ),
  { ssr: false, loading: () => null },
);

const NotificationBell = dynamic(
  () =>
    import("@/components/notification-bell").then(
      (mod) => mod.NotificationBell,
    ),
  {
    ssr: false,
    loading: () => <HeaderControlLoading label="Loading notifications…" />,
  },
);

const StepUpPrompt = dynamic(
  () =>
    import("@/components/auth/step-up-prompt").then((mod) => mod.StepUpPrompt),
  { ssr: false, loading: () => null },
);

const SIDEBAR_COLLAPSED_KEY = "pw:sidebar-collapsed";

/** Upper bound on how long sign-out waits for the push revocation. */
const WEB_PUSH_REVOKE_TIMEOUT_MS = 2_000;

/** Resolve a pathname to the longest matching dashboard section (href+label). */
function resolveDestination(
  pathname: string,
  routes: readonly { href: string; label: string }[],
): { href: string; label: string } | null {
  let best: { href: string; label: string } | null = null;
  for (const route of routes) {
    const match =
      pathname === route.href || pathname.startsWith(`${route.href}/`);
    if (!match) continue;
    if (!best || route.href.length > best.href.length) {
      best = { href: route.href, label: route.label };
    }
  }
  return best;
}

/**
 * Drop this browser's web-push subscription, best effort.
 *
 * Loaded on demand so the push client stays out of the shell chunk that every
 * dashboard route pays for. Every failure mode — unsupported browser, no
 * subscription, a 401 on the server revoke — is swallowed: a sign-out must
 * never be blocked by a revocation that did not land.
 */
async function revokeWebPushQuietly(): Promise<void> {
  try {
    const { unsubscribeFromWebPush } = await import("@/lib/web-push");
    // `navigator.serviceWorker.ready` never settles when no worker was ever
    // registered, so the revoke is raced against a deadline. Signing out is
    // the user's instruction; it does not wait on this.
    await Promise.race([
      unsubscribeFromWebPush(),
      new Promise<void>((resolve) =>
        setTimeout(resolve, WEB_PUSH_REVOKE_TIMEOUT_MS),
      ),
    ]);
  } catch {
    /* best-effort: the local unsubscribe is attempted first inside the lib */
  }
}

export function DashboardShell({
  children,
  initialMe,
  nonce,
}: {
  children?: ReactNode;
  initialMe: MeResponse;
  /**
   * The request's CSP script nonce. next-themes renders an inline script to
   * apply the saved theme before first paint; under the dashboard's nonce +
   * 'strict-dynamic' policy that script runs only if it carries this nonce.
   */
  nonce?: string;
}) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const router = useRouter();
  const serializedSearch = searchParams.toString();
  const recoveryHref = serializedSearch
    ? `${pathname}?${serializedSearch}`
    : pathname;
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [account, setAccount] = useState<MeResponse | null>(initialMe);
  const accountCanAccessRetention = canAccessRetentionOffers(account);
  // Keep the role projection local to the always-loaded shell. Importing the
  // auth client here also pulled its mutation and session-cleanup graph into
  // every dashboard route even though sign-out is already loaded on demand.
  const accountEffectiveRole = account
    ? (account.effective_role ?? account.role)
    : null;
  const accountViewerMode = account?.viewer_mode === true;
  const accountCanAccessAdminNavigation =
    !accountViewerMode &&
    (accountEffectiveRole === "owner" || accountEffectiveRole === "admin");

  // Refs to each nav link so arrow keys can shift focus.
  const itemRefs = useRef<Array<HTMLAnchorElement | null>>([]);
  const mainRef = useRef<HTMLElement | null>(null);
  const firstNavRef = useRef(true);

  // Mobile drawer a11y refs.
  const mobileDrawerRef = useRef<HTMLElement | null>(null);
  const mobileCloseRef = useRef<HTMLButtonElement | null>(null);
  const mobilePrevFocusRef = useRef<HTMLElement | null>(null);
  const mobileDrawerId = useId();

  const handleIdentityChange = useCallback((me: MeResponse | null) => {
    setAccount(me);
  }, []);

  // Restore the persisted collapse preference after mount (SHELL-009). Starting
  // from `false` keeps SSR and the first client render identical (hydration-safe);
  // the stored value is applied one tick later.
  useEffect(() => {
    try {
      if (window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "1") {
        setCollapsed(true);
      }
    } catch {
      /* private-mode / disabled storage — keep the default */
    }
  }, []);

  const toggleCollapsed = useCallback(() => {
    // Persist outside the updater — React may invoke an updater more than once
    // per update, and a discarded render would still leave the write behind.
    const next = !collapsed;
    setCollapsed(next);
    try {
      window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, next ? "1" : "0");
    } catch {
      /* best-effort persistence */
    }
  }, [collapsed]);

  useEffect(() => {
    let redirecting = false;
    const onSessionExpired = (): void => {
      if (redirecting) return;
      redirecting = true;
      const next = `${window.location.pathname}${window.location.search}`;
      // Same teardown as an explicit sign-out. The server call will 401 here
      // (the session is already gone) but the local PushManager unsubscribe
      // still lands, so the browser stops receiving the old identity's pushes.
      void revokeWebPushQuietly();
      void clearQueryState().finally(() => {
        clearOfflineStorage();
        router.replace(`/login?next=${encodeURIComponent(next)}`);
        router.refresh();
      });
    };
    window.addEventListener(AUTH_SESSION_EXPIRED_EVENT, onSessionExpired);
    return () =>
      window.removeEventListener(AUTH_SESSION_EXPIRED_EVENT, onSessionExpired);
  }, [router]);

  // On client navigation: reset the inner scroll container to the top (Next's
  // scroll restoration targets the document, not our overflow-auto <main>, so
  // long pages could otherwise land mid-scroll — SHELL-011) and move focus to
  // <main> so keyboard/AT users land on the new page (SHELL-026). Also record
  // the destination for the palette's Recent group (SHELL-032). Skip the focus
  // move on first mount so we don't steal focus on initial paint.
  useEffect(() => {
    if (mainRef.current) mainRef.current.scrollTop = 0;
    // Recent destinations include detail/settings routes the visible rail does
    // not need. Load that larger catalogue after hydration instead of charging
    // every dashboard route for it in the render-blocking shell graph.
    let active = true;
    void import("@/lib/dashboard-shell-routes").then(
      ({ DASHBOARD_SHELL_ROUTES, dashboardShellRouteRequiresAdmin }) => {
        if (!active) return;
        const dest = resolveDestination(pathname, DASHBOARD_SHELL_ROUTES);
        if (
          dest &&
          account?.tenant_id &&
          (accountCanAccessAdminNavigation ||
            !dashboardShellRouteRequiresAdmin(dest.href)) &&
          (accountCanAccessRetention || !isRetentionOffersRoute(dest.href))
        ) {
          recordRecentDestination(account.tenant_id, dest);
        }
      },
    );
    if (firstNavRef.current) {
      firstNavRef.current = false;
      return () => {
        active = false;
      };
    }
    const main = mainRef.current;
    const activeElement = document.activeElement;
    // A route can provide a more useful focus target (for example a detail
    // heading or the originating gallery card). Preserve that deliberate
    // handoff instead of replacing it with the generic page container.
    if (
      main &&
      activeElement instanceof HTMLElement &&
      activeElement !== main &&
      main.contains(activeElement)
    ) {
      return () => {
        active = false;
      };
    }
    main?.focus({ preventScroll: true });
    return () => {
      active = false;
    };
  }, [
    account?.tenant_id,
    accountCanAccessAdminNavigation,
    accountCanAccessRetention,
    pathname,
  ]);

  // Mobile nav drawer: dialog semantics, focus trap, Escape, initial focus, and
  // body scroll-lock while open (SHELL-007).
  useEffect(() => {
    if (!mobileOpen) return;
    mobilePrevFocusRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const initial =
      mobileCloseRef.current ?? firstFocusable(mobileDrawerRef.current);
    initial?.focus({ preventScroll: true });
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const onKey = (event: globalThis.KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        setMobileOpen(false);
        return;
      }
      if (event.key === "Tab") trapFocus(event, mobileDrawerRef.current);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = previousOverflow;
      const previous = mobilePrevFocusRef.current;
      mobilePrevFocusRef.current = null;
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, [mobileOpen]);

  // The shell persists across soft navigation. A route change that originates
  // outside the drawer (browser history, command palette, notification) must not
  // leave the previous route's modal navigation orphaned over the new page.
  useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);

  async function handleLogout() {
    // Revoke the browser's push subscription BEFORE the session cookie goes
    // away: the server half of the revocation (`POST
    // /api/v1/notifications/web-push/unsubscribe`) needs a live session. The
    // row is identity-bound, not session-bound, so skipping this leaves the
    // previous user's tenant notifications rendering on a shared browser
    // forever. Sign-out is never blocked by a failed revocation — mirrors
    // apps/mobile/src/lib/push.ts::unregisterPushThenSignOut().
    await revokeWebPushQuietly();
    try {
      // Sign-out is the only path that needs the auth mutation runtime. Keep it
      // out of the authenticated shell's initial graph, but await it before
      // clearing local identity exactly as before.
      const { logout } = await import("@/lib/auth-api");
      await logout();
    } finally {
      await clearQueryState();
      clearOfflineStorage();
      router.push("/login");
      router.refresh();
    }
  }

  function onNavKeyDown(e: KeyboardEvent<HTMLAnchorElement>, index: number) {
    if (
      e.key !== "ArrowDown" &&
      e.key !== "ArrowUp" &&
      e.key !== "Home" &&
      e.key !== "End"
    ) {
      return;
    }
    e.preventDefault();
    const computed = nextDashboardNavIndex(
      e.key,
      index,
      DASHBOARD_NAV_ITEMS.length,
    );
    if (computed === null) return;
    itemRefs.current[computed]?.focus();
  }

  return (
    <ThemeProvider
      attribute="class"
      nonce={nonce}
      defaultTheme="light"
      // System/Auto is an available choice (SHELL-033) so users can follow their
      // OS preference. The default stays "light" so a first visit is never
      // surprised into dark; picking "System" is an explicit opt-in.
      enableSystem
      disableTransitionOnChange
    >
      <QueryProvider
        initialMe={initialMe}
        onIdentityChange={handleIdentityChange}
      >
        <ShellChrome
          account={account}
          collapsed={collapsed}
          toggleCollapsed={toggleCollapsed}
          mobileOpen={mobileOpen}
          setMobileOpen={setMobileOpen}
          pathname={pathname}
          recoveryHref={recoveryHref}
          itemRefs={itemRefs}
          onNavKeyDown={onNavKeyDown}
          mainRef={mainRef}
          mobileDrawerRef={mobileDrawerRef}
          mobileCloseRef={mobileCloseRef}
          mobileDrawerId={mobileDrawerId}
          onLogout={handleLogout}
        >
          {children}
        </ShellChrome>
        <DashboardTourIsland
          tenantId={account?.tenant_id}
          userId={account?.user_id}
          role={account ? (account.effective_role ?? account.role) : null}
          viewerMode={account?.viewer_mode === true}
        />
      </QueryProvider>
    </ThemeProvider>
  );
}

function ShellChrome({
  account,
  collapsed,
  toggleCollapsed,
  mobileOpen,
  setMobileOpen,
  pathname,
  recoveryHref,
  itemRefs,
  onNavKeyDown,
  mainRef,
  mobileDrawerRef,
  mobileCloseRef,
  mobileDrawerId,
  onLogout,
  children,
}: {
  account: MeResponse | null;
  collapsed: boolean;
  toggleCollapsed: () => void;
  mobileOpen: boolean;
  setMobileOpen: (open: boolean) => void;
  pathname: string;
  recoveryHref: string;
  itemRefs: MutableRefObject<Array<HTMLAnchorElement | null>>;
  onNavKeyDown: (e: KeyboardEvent<HTMLAnchorElement>, index: number) => void;
  mainRef: MutableRefObject<HTMLElement | null>;
  mobileDrawerRef: MutableRefObject<HTMLElement | null>;
  mobileCloseRef: MutableRefObject<HTMLButtonElement | null>;
  mobileDrawerId: string;
  onLogout: () => void;
  children?: ReactNode;
}) {
  // Actionable count badges (e.g. pending Approvals). Inside the QueryProvider
  // so the query has a client; exact principal/viewer scope (SHELL-023).
  const [hydrated, setHydrated] = useState(false);
  const badges = useNavBadges(account);
  const canAccessRetention = canAccessRetentionOffers(account);
  const role = account ? (account.effective_role ?? account.role) : null;
  const viewerMode = account?.viewer_mode === true;
  const canAccessAdminNavigation =
    !viewerMode && (role === "owner" || role === "admin");
  const canWrite =
    !viewerMode && (role === "owner" || role === "admin" || role === "editor");

  // Server-rendered controls are visible before React has attached their event
  // handlers. Without a guard, a fast click during that window is accepted by
  // the browser and then silently lost. Native `inert` makes the truthful state
  // explicit. Keep it in place until the dynamically loaded step-up listener
  // is mounted too: otherwise a fast sensitive action could receive a server
  // challenge in the gap after hydration and before anything can claim it.
  // The recovery UI deliberately sits OUTSIDE that inert subtree, so either a
  // hydration or listener-chunk failure remains perceivable and recoverable.
  const handleStepUpReady = useCallback(() => setHydrated(true), []);

  return (
    <CommandRegistryProvider>
      <div
        className="relative h-dvh min-h-0 overflow-hidden bg-mw-paper"
        data-dashboard-hydrated={hydrated ? "true" : "false"}
      >
        {!hydrated && (
          <div className="fixed inset-x-3 top-3 z-[110] flex justify-center sm:inset-x-6">
            <div className="flex w-full max-w-xl flex-wrap items-center justify-between gap-3 rounded-xl border bg-card px-4 py-3 text-card-foreground shadow-lg">
              <div
                role="status"
                aria-live="polite"
                aria-atomic="true"
                className="flex min-w-0 items-center gap-3"
              >
                <span
                  className="h-2.5 w-2.5 shrink-0 animate-pulse rounded-full bg-primary motion-reduce:animate-none"
                  aria-hidden="true"
                />
                <span className="text-sm font-medium">
                  Preparing your workspace…
                </span>
              </div>
              <a
                href={recoveryHref || "/app"}
                className="inline-flex min-h-11 items-center rounded-md px-2 text-sm font-semibold text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              >
                Reload workspace
              </a>
            </div>
          </div>
        )}
        <div
          className="flex h-full min-h-0 w-full overflow-hidden"
          aria-busy={!hydrated}
          inert={hydrated ? undefined : true}
        >
          {/* Skip-to-content: visually hidden until focused. WCAG 2.4.1. */}
          <a
            href="#main-content"
            className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-[100] focus:rounded-md focus:bg-primary focus:px-3 focus:py-2 focus:text-sm focus:font-medium focus:text-primary-foreground focus:shadow-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Skip to main content
          </a>
          <aside
            data-tour="dashboard-sidebar"
            data-tour-step="0"
            className={cn(
              "hidden h-full min-h-0 shrink-0 border-r border-mw-ink/15 bg-card text-foreground transition-all duration-150 md:flex md:flex-col",
              collapsed ? "w-16" : "w-60",
            )}
            aria-label="Dashboard sidebar"
          >
            <div className="h-14 px-4 flex items-center border-b justify-between">
              {!collapsed && (
                <Link
                  href="/app"
                  aria-label="Moosewave dashboard"
                  className="rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <MoosewaveWordmark
                    markClassName="size-7"
                    labelClassName="text-[1.25rem]"
                  />
                </Link>
              )}
              <button
                type="button"
                onClick={toggleCollapsed}
                className="ml-auto inline-flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-11"
                aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
                aria-expanded={!collapsed}
              >
                {collapsed ? (
                  <ChevronsRight className="h-4 w-4" />
                ) : (
                  <ChevronsLeft className="h-4 w-4" />
                )}
              </button>
            </div>
            <DashboardNav
              pathname={pathname}
              collapsed={collapsed}
              itemRefs={itemRefs}
              onNavKeyDown={onNavKeyDown}
              railId="nav-rail-desktop"
              badges={badges}
              canAccessRetention={canAccessRetention}
              role={role}
              viewerMode={viewerMode}
            />
          </aside>
          {mobileOpen && (
            <div className="fixed inset-0 z-40 md:hidden" role="presentation">
              <div
                aria-hidden="true"
                className="absolute inset-0 bg-background/80 backdrop-blur-sm"
                onClick={() => setMobileOpen(false)}
              />
              <aside
                id={mobileDrawerId}
                ref={mobileDrawerRef}
                className="relative z-10 flex h-dvh min-h-0 w-[min(20rem,calc(100vw-3rem))] flex-col border-r bg-background text-foreground shadow-xl"
                role="dialog"
                aria-modal="true"
                aria-label="Dashboard mobile navigation"
              >
                <div className="h-14 px-4 flex items-center border-b justify-between">
                  <Link
                    href="/app"
                    aria-label="Moosewave dashboard"
                    className="inline-flex min-h-11 items-center rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    onClick={() => setMobileOpen(false)}
                  >
                    <MoosewaveWordmark
                      markClassName="size-7"
                      labelClassName="text-[1.25rem]"
                    />
                  </Link>
                  <button
                    ref={mobileCloseRef}
                    type="button"
                    onClick={() => setMobileOpen(false)}
                    className="inline-flex h-11 w-11 items-center justify-center rounded-md text-muted-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    aria-label="Close navigation"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
                <DashboardNav
                  pathname={pathname}
                  collapsed={false}
                  onNavigate={() => setMobileOpen(false)}
                  railId="nav-rail-mobile"
                  badges={badges}
                  canAccessRetention={canAccessRetention}
                  role={role}
                  viewerMode={viewerMode}
                />
              </aside>
            </div>
          )}
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            {/* Offline banner: surfaces when we're offline AND have a non-empty
            outbox. Sits above the topbar so it's the first thing the user
            sees on every dashboard route. Reconnect-side replay + toast
            lives in PwaRegistrar (mounted in the root layout). */}
            <OfflineBanner />
            <header
              role="banner"
              className="flex min-h-14 min-w-0 shrink-0 flex-wrap items-center gap-1 border-b border-mw-ink/15 bg-card px-2 py-1 shadow-[0_2px_0_rgb(32_32_30_/_0.035)] sm:gap-2 sm:px-4 md:h-14 md:flex-nowrap md:gap-3 md:px-6 md:py-0 max-[359px]:gap-y-1"
            >
              <button
                type="button"
                onClick={() => setMobileOpen(true)}
                className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:hidden"
                aria-label="Open navigation"
                aria-expanded={mobileOpen}
                aria-controls={mobileDrawerId}
                aria-haspopup="dialog"
              >
                <Menu className="h-4 w-4" />
              </button>
              <Suspense fallback={<WorkspaceControlLoading />}>
                <TenantSwitcher account={account} />
              </Suspense>
              {/* Mobile priority: navigation, workspace identity, search, create,
                queue attention, notifications and account always fit at 320px.
                Ambient presence and the duplicate theme shortcut return at md;
                theme remains available from Account at every width. */}
              <div
                data-slot="dashboard-header-actions"
                className="ml-auto flex min-w-0 shrink-0 items-center gap-0.5 sm:gap-1 md:gap-2 max-[359px]:ml-0 max-[359px]:basis-full max-[359px]:justify-end"
              >
                <PresenceIndicator className="hidden shrink-0 md:block" />
                <MobileSearchButton />
                <CommandTrigger />
                {canWrite ? (
                  <Suspense
                    fallback={
                      <HeaderControlLoading label="Loading create actions…" />
                    }
                  >
                    <CreateMenu />
                  </Suspense>
                ) : null}
                <div className="shrink-0">
                  <QueueTrayLauncher />
                </div>
                <div className="shrink-0">
                  <NotificationBell
                    tenantId={account?.tenant_id ?? "anon"}
                    role={account?.role ?? null}
                  />
                </div>
                <div className="hidden shrink-0 md:block">
                  <Suspense
                    fallback={
                      <HeaderControlLoading label="Loading theme control…" />
                    }
                  >
                    <ThemeToggle />
                  </Suspense>
                </div>
                <Suspense
                  fallback={
                    <HeaderControlLoading label="Loading account actions…" />
                  }
                >
                  <UserMenu account={account} onLogout={onLogout} />
                </Suspense>
              </div>
            </header>
            <SampleDataNotice account={account} />
            <main
              ref={mainRef}
              id="main-content"
              data-slot="dashboard-main"
              tabIndex={-1}
              className="mw-dashboard-main min-h-0 min-w-0 flex-1 overflow-auto overscroll-contain focus:outline-none"
            >
              <PageTransition>{children}</PageTransition>
            </main>
          </div>
          {/* Step-up re-authentication (ECO-01). Mounted beside the shell's other
          always-on listeners because the challenge can arrive from any route:
          the transport awaits a prompt, and an unmounted one resolves "no",
          which would put the 401 back in front of the user. */}
          <StepUpPrompt onReady={handleStepUpReady} />
          <CommandPalette
            tenantId={account?.tenant_id}
            canAccessRetention={canAccessRetention}
            canAccessAdmin={canAccessAdminNavigation}
            canWrite={canWrite}
          />
        </div>
      </div>
    </CommandRegistryProvider>
  );
}

function MobileSearchButton() {
  return (
    <button
      type="button"
      onClick={() => window.dispatchEvent(new Event("pw:open-command-palette"))}
      className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:hidden"
      aria-label="Open search"
    >
      <Search className="h-4 w-4" aria-hidden />
    </button>
  );
}

function CommandTrigger() {
  // The ⌘ vs Ctrl hint depends on the OS, which the server can't know. Default
  // to ⌘ so SSR and the first client render agree, then correct after mount.
  const [mac, setMac] = useState(true);
  useEffect(() => {
    // navigator.platform is deprecated; the UA string is sufficient and
    // contains "Macintosh"/"iPhone"/etc. on Apple devices.
    setMac(/Mac|iPhone|iPad|iPod/.test(navigator.userAgent));
  }, []);
  return (
    <button
      type="button"
      onClick={() => window.dispatchEvent(new Event("pw:open-command-palette"))}
      className="hidden h-9 shrink-0 items-center gap-2 rounded-[8px_11px_8px_11px] border border-mw-ink/20 bg-mw-paper pl-3 pr-2 text-sm text-muted-foreground shadow-[1px_2px_0_rgb(32_32_30_/_0.06)] transition-colors hover:border-mw-blue hover:text-mw-blue focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:flex"
      aria-label="Open command palette"
      aria-keyshortcuts="Meta+K Control+K"
    >
      <Search className="h-4 w-4" aria-hidden />
      <span className="hidden md:inline">Search</span>
      <kbd className="inline-flex items-center rounded border bg-background px-1.5 py-0.5 font-sans text-[10px] font-medium text-muted-foreground">
        {mac ? "⌘K" : "Ctrl K"}
      </kbd>
    </button>
  );
}
