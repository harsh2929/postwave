// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { Route } from "next";
import { useTheme } from "next-themes";
import {
  ArrowRightLeft,
  BadgeCheck,
  BarChart3,
  ClipboardCheck,
  ClipboardList,
  Clock,
  CreditCard,
  Gavel,
  GitBranch,
  Handshake,
  Inbox,
  ShieldBan,
  TicketPercent,
  KeyRound,
  LayoutDashboard,
  LayoutTemplate,
  Loader2,
  Mail,
  MessageSquareText,
  Mic,
  PanelTop,
  Moon,
  Plug,
  Plus,
  Zap,
  Shield,
  Sun,
  Users,
  UserCog,
  Webhook,
  Workflow,
  Building2,
} from "lucide-react";

import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from "@/components/ui/command";
import { useCommandRegistry } from "@/components/command-registry";
import {
  DASHBOARD_ACTION_ROUTES,
  DASHBOARD_CREATE_ROUTES,
  DASHBOARD_COMMAND_GO_ROUTES,
  DASHBOARD_COMMAND_SETTINGS_ROUTES,
  dashboardRouteScopeForHref,
  type DashboardCreateRoute,
  type DashboardRoute,
  type DashboardRouteIcon,
  type DashboardRouteScope,
} from "@/lib/dashboard-routes";
import {
  searchApi,
  searchHitHref,
  searchHitTypeLabel,
  type GlobalSearchResult,
  type GlobalSearchType,
} from "@/lib/search-api";
import {
  integrationsCatalogApi,
  type CatalogItem,
} from "@/lib/integrations-catalog-api";
import { canNavigateWithUnsavedChanges } from "@/lib/use-unsaved-changes-guard";
import {
  readRecentDestinations,
  type RecentDestination,
} from "@/lib/recent-destinations";
import { isRetentionOffersRoute } from "@/lib/retention-offers-access";

const SEARCH_TYPE_ICONS: Record<GlobalSearchType, typeof Mail> = {
  subscriber: Users,
  list: ClipboardList,
  segment: GitBranch,
  suppression: ShieldBan,
  campaign: Mail,
  flow: Workflow,
  template: LayoutTemplate,
  form: PanelTop,
};

const ROUTE_ICONS: Record<DashboardRouteIcon, typeof Mail> = {
  arrowRightLeft: ArrowRightLeft,
  badgeCheck: BadgeCheck,
  building2: Building2,
  barChart3: BarChart3,
  clipboardCheck: ClipboardCheck,
  clipboardList: ClipboardList,
  creditCard: CreditCard,
  gavel: Gavel,
  gitBranch: GitBranch,
  handshake: Handshake,
  inbox: Inbox,
  keyRound: KeyRound,
  layoutDashboard: LayoutDashboard,
  layoutTemplate: LayoutTemplate,
  mail: Mail,
  messageSquareText: MessageSquareText,
  mic: Mic,
  panelTop: PanelTop,
  plug: Plug,
  settings: UserCog,
  shield: Shield,
  shieldBan: ShieldBan,
  ticketPercent: TicketPercent,
  userCog: UserCog,
  users: Users,
  webhook: Webhook,
  workflow: Workflow,
};

function toCommandRoute(route: DashboardRoute): {
  label: string;
  href: Route;
  icon: typeof Mail;
  keywords?: string[];
  kbd?: string;
  scope: DashboardRouteScope;
} {
  return {
    label: route.label,
    href: route.href as Route,
    icon: ROUTE_ICONS[route.icon],
    keywords: route.keywords ? [...route.keywords] : undefined,
    kbd: route.kbd,
    scope: route.scope ?? "member",
  };
}

function toCreateRoute(route: DashboardCreateRoute): {
  label: string;
  href: Route;
  keywords?: string[];
} {
  return {
    label: route.label,
    href: route.href as Route,
    keywords: route.keywords ? [...route.keywords] : undefined,
  };
}

const NAV = DASHBOARD_COMMAND_GO_ROUTES.map(toCommandRoute);
const CREATE = DASHBOARD_CREATE_ROUTES.map(toCreateRoute);
const ACTIONS = DASHBOARD_ACTION_ROUTES.map(toCreateRoute);
const SETTINGS = DASHBOARD_COMMAND_SETTINGS_ROUTES.map(toCommandRoute);

/**
 * A header disclosure is not an ARIA dialog, but it still owns keyboard focus
 * while open. Treat it like the shell's modal surfaces when deciding whether
 * the global palette may open; otherwise Cmd/Ctrl-K can stack a Radix focus
 * trap over the workspace/Create/account disclosure and one Escape dismisses
 * both layers.
 */
function hasBlockingShellSurface(): boolean {
  return Boolean(
    document.querySelector('[role="dialog"], [data-header-menu-panel]'),
  );
}

/**
 * App-wide command palette. Cmd/Ctrl-K toggles it from anywhere in the
 * dashboard; the content only mounts while open (Radix unmounts closed dialog
 * content), so there is no SSR of theme-dependent labels and no hydration
 * concern. Mounted once in the dashboard layout.
 */
export function CommandPalette({
  tenantId,
  canAccessRetention = true,
  canAccessAdmin = true,
  canWrite = true,
}: {
  tenantId?: string;
  canAccessRetention?: boolean;
  canAccessAdmin?: boolean;
  canWrite?: boolean;
} = {}) {
  const [open, setOpen] = useState(false);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const wasOpenRef = useRef(false);
  const router = useRouter();
  const { resolvedTheme, setTheme } = useTheme();
  const isDark = resolvedTheme === "dark";

  // Entity-aware search. The query is controlled so it can drive the debounced
  // global-search fetch; results are kept in component-local state (never in
  // the react-query cache) so ephemeral search hits are not persisted across
  // sessions/tenants — a deliberate identity-hygiene choice for a palette.
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [results, setResults] = useState<GlobalSearchResult[]>([]);
  const [resultsQuery, setResultsQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState(false);
  const [recent, setRecent] = useState<RecentDestination[]>([]);

  useEffect(() => {
    const t = window.setTimeout(() => setDebouncedQuery(query), 200);
    return () => window.clearTimeout(t);
  }, [query]);

  useEffect(() => {
    const q = debouncedQuery.trim();
    // Min 2 chars (mirrors desktop) so a single keystroke isn't a round-trip.
    if (!open || q.length < 2) {
      setResults([]);
      setResultsQuery("");
      setSearching(false);
      setSearchError(false);
      return;
    }
    const ctrl = new AbortController();
    setSearching(true);
    setSearchError(false);
    searchApi
      .global(q, { limit: 8, signal: ctrl.signal })
      .then((r) => {
        if (ctrl.signal.aborted) return;
        setResults(r.results ?? []);
        setResultsQuery(q);
        setSearching(false);
      })
      .catch(() => {
        // A superseded query aborts this fetch; the newer effect owns the
        // loading state, so don't clear it here. Other failures end the spinner.
        if (ctrl.signal.aborted) return;
        setResults([]);
        setResultsQuery(q);
        setSearchError(true);
        setSearching(false);
      });
    return () => ctrl.abort();
  }, [debouncedQuery, open]);

  // Load the Recent destinations for the empty-query state on open (SHELL-032).
  useEffect(() => {
    if (!open) return;
    setRecent(readRecentDestinations(tenantId ?? "anon"));
  }, [open, tenantId]);

  // Reset the query when the palette closes so it opens fresh next time.
  useEffect(() => {
    if (!open) {
      setQuery("");
      setDebouncedQuery("");
      setResults([]);
      setResultsQuery("");
      setSearching(false);
      setSearchError(false);
    }
  }, [open]);

  // True while a server search for the CURRENT input is still resolving —
  // including the debounce gap — so we show "Searching…" instead of the
  // misleading "No matches" (SHELL-010).
  const trimmedQuery = query.trim();
  const isSearchPending =
    open &&
    trimmedQuery.length >= 2 &&
    (searching || trimmedQuery !== debouncedQuery.trim());
  const visibleResults =
    resultsQuery === trimmedQuery &&
    trimmedQuery === debouncedQuery.trim() &&
    !searchError
      ? results
      : [];
  const currentSearchFailed =
    searchError &&
    resultsQuery === trimmedQuery &&
    trimmedQuery === debouncedQuery.trim();
  const visibleRecent = useMemo(
    () =>
      recent.filter(
        (destination) =>
          (canAccessRetention || !isRetentionOffersRoute(destination.href)) &&
          (canAccessAdmin ||
            dashboardRouteScopeForHref(destination.href) !== "admin"),
      ),
    [canAccessAdmin, canAccessRetention, recent],
  );
  const visibleNav = useMemo(
    () =>
      NAV.filter(
        (destination) =>
          (canAccessRetention || !isRetentionOffersRoute(destination.href)) &&
          (canAccessAdmin || destination.scope !== "admin"),
      ),
    [canAccessAdmin, canAccessRetention],
  );
  const visibleSettings = useMemo(
    () =>
      SETTINGS.filter(
        (destination) => canAccessAdmin || destination.scope !== "admin",
      ),
    [canAccessAdmin],
  );
  const showRecent =
    open && trimmedQuery.length === 0 && visibleRecent.length > 0;

  // Catalog providers are indexed into the palette so a specific integration is
  // reachable from ⌘K, not only the three top-level pages (INTG-050). Kept in
  // component-local state (not react-query) matching the palette's ephemeral
  // fetch idiom; loaded once, on the first real (2+ char) search.
  const [catalogItems, setCatalogItems] = useState<CatalogItem[]>([]);
  const catalogLoadedRef = useRef(false);
  useEffect(() => {
    if (!open || catalogLoadedRef.current) return;
    if (debouncedQuery.trim().length < 2) return;
    const ctrl = new AbortController();
    integrationsCatalogApi
      .get({ signal: ctrl.signal })
      .then((c) => {
        catalogLoadedRef.current = true;
        setCatalogItems(c.items ?? []);
      })
      .catch(() => {
        // Best-effort: a failed catalog load must never disrupt the palette.
      });
    return () => ctrl.abort();
  }, [open, debouncedQuery]);
  const providerMatches = useMemo(() => {
    const q = debouncedQuery.trim().toLowerCase();
    if (q.length < 2) return [];
    return catalogItems
      .filter((i) => `${i.name} ${i.slug}`.toLowerCase().includes(q))
      .slice(0, 8);
  }, [debouncedQuery, catalogItems]);
  const visibleProviderMatches =
    trimmedQuery === debouncedQuery.trim() ? providerMatches : [];

  const rememberFocus = useCallback(() => {
    if (restoreFocusRef.current?.isConnected) return;
    const active = document.activeElement;
    restoreFocusRef.current =
      active instanceof HTMLElement && active !== document.body ? active : null;
  }, []);

  const restoreFocus = useCallback(() => {
    const target = restoreFocusRef.current;
    restoreFocusRef.current = null;
    if (!target) return;
    if (target.isConnected) target.focus();
    requestAnimationFrame(() => {
      window.setTimeout(() => {
        if (target.isConnected) target.focus();
      }, 0);
    });
  }, []);

  const onOpenChange = useCallback(
    (next: boolean) => {
      if (next) {
        rememberFocus();
        setOpen(true);
      } else {
        setOpen(false);
      }
    },
    [rememberFocus],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.key === "k" || e.key === "K") && (e.metaKey || e.ctrlKey)) {
        if (e.repeat) return;
        // Don't hijack Cmd/Ctrl-K while the user is typing — inputs and the
        // rich-text editor (TipTap binds Cmd-K to link insertion) own the
        // shortcut. Let it propagate untouched in those contexts, except when
        // the palette itself is already open: its documented toggle must also
        // close from its own search field.
        const t = e.target as HTMLElement | null;
        if (
          !open &&
          t &&
          (t.isContentEditable ||
            t instanceof HTMLInputElement ||
            t instanceof HTMLTextAreaElement ||
            t instanceof HTMLSelectElement)
        ) {
          return;
        }
        e.preventDefault();
        if (open) {
          setOpen(false);
          return;
        }
        // A second modal shell surface (mobile navigation / offline queue) owns
        // keyboard focus until it closes. Opening a Radix dialog above it would
        // create nested focus traps and one Escape would dismiss both.
        if (hasBlockingShellSurface()) return;
        rememberFocus();
        setOpen(true);
      }
    };
    // Header affordance (and any other UI) can open the palette by dispatching
    // this event — avoids prop-drilling open state through the layout tree.
    const onOpen = () => {
      if (hasBlockingShellSurface()) return;
      rememberFocus();
      setOpen(true);
    };
    document.addEventListener("keydown", onKey);
    window.addEventListener("pw:open-command-palette", onOpen);
    return () => {
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("pw:open-command-palette", onOpen);
    };
  }, [open, rememberFocus]);

  useEffect(() => {
    if (wasOpenRef.current && !open) restoreFocus();
    wasOpenRef.current = open;
  }, [open, restoreFocus]);

  // Close first, then defer the side-effect one frame so Radix's
  // requestAnimationFrame focus-restore resolves against the still-attached
  // trigger before we navigate (avoids focus landing on <body> — WCAG 2.4.3).
  const go = useCallback(
    (href: Route) => {
      if (!canNavigateWithUnsavedChanges()) return;
      setOpen(false);
      restoreFocus();
      requestAnimationFrame(() => router.push(href));
    },
    [restoreFocus, router],
  );

  const run = useCallback(
    (fn: () => void) => {
      setOpen(false);
      restoreFocus();
      requestAnimationFrame(fn);
    },
    [restoreFocus],
  );

  // GOV-056: contextual actions the current route registered.
  const pageCommands = useCommandRegistry();

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      restoreFocusRef={restoreFocusRef}
    >
      <CommandInput
        placeholder="Search subscribers, segments, pages…"
        value={query}
        onValueChange={setQuery}
      />
      {isSearchPending ? (
        <div
          role="status"
          aria-live="polite"
          aria-atomic="true"
          className="flex min-h-11 items-center gap-2 border-b px-4 text-xs text-muted-foreground"
        >
          <Loader2
            className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none"
            aria-hidden
          />
          Searching…
        </div>
      ) : currentSearchFailed ? (
        <div
          role="alert"
          className="border-b border-destructive/30 bg-destructive/10 px-4 py-2 text-xs text-destructive-emphasis"
        >
          Search is temporarily unavailable. Pages and actions still work.
        </div>
      ) : null}
      {!isSearchPending && !currentSearchFailed ? (
        // cmdk renders CommandEmpty as role="presentation". Keep that status
        // outside its role="listbox": a presentational direct child violates
        // the listbox ownership contract even though the text is useful.
        <div role="status" aria-live="polite" aria-atomic="true">
          <CommandEmpty>No matches. Try a page or “new …”.</CommandEmpty>
        </div>
      ) : null}
      <CommandList>
        {pageCommands.length > 0 ? (
          <>
            <CommandGroup heading="On this page">
              {pageCommands.map((cmd) => (
                <CommandItem
                  key={`page-${cmd.id}`}
                  value={`page ${cmd.label} ${cmd.keywords ?? ""}`}
                  onSelect={() => run(cmd.run)}
                >
                  <Zap aria-hidden />
                  <span className="truncate">{cmd.label}</span>
                </CommandItem>
              ))}
            </CommandGroup>
            <CommandSeparator />
          </>
        ) : null}

        {showRecent ? (
          <>
            <CommandGroup heading="Recent">
              {visibleRecent.map((dest) => (
                <CommandItem
                  key={`recent-${dest.href}`}
                  value={`recent ${dest.href}`}
                  onSelect={() => go(dest.href as Route)}
                >
                  <Clock aria-hidden />
                  <span className="truncate">{dest.label}</span>
                </CommandItem>
              ))}
            </CommandGroup>
            <CommandSeparator />
          </>
        ) : null}

        {visibleResults.length > 0 ? (
          <>
            <CommandGroup heading="Results">
              {visibleResults.map((hit) => {
                const Icon = SEARCH_TYPE_ICONS[hit.type];
                const href = searchHitHref(hit) as Route;
                return (
                  <CommandItem
                    // Prefix the cmdk value with the live query so the client
                    // filter always keeps server rows (they're already
                    // server-matched); the suffix keeps each row's value unique.
                    key={`hit-${hit.type}-${hit.id}`}
                    value={`${query} ${hit.type}:${hit.id}`}
                    onSelect={() => go(href)}
                  >
                    <Icon aria-hidden />
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate">{hit.title}</span>
                      {hit.detail ? (
                        <span className="truncate text-xs text-muted-foreground">
                          {hit.detail}
                        </span>
                      ) : null}
                    </span>
                    <CommandShortcut>
                      {searchHitTypeLabel(hit.type)}
                    </CommandShortcut>
                  </CommandItem>
                );
              })}
            </CommandGroup>
            <CommandSeparator />
          </>
        ) : null}

        {visibleProviderMatches.length > 0 ? (
          <>
            <CommandGroup heading="Integrations">
              {visibleProviderMatches.map((item) => (
                <CommandItem
                  key={`catalog-${item.slug}`}
                  // Prefix with the live query so cmdk keeps these already-
                  // matched rows; the slug suffix keeps each value unique.
                  value={`${query} integration:${item.slug}`}
                  onSelect={() =>
                    go(`/app/integrations/catalog/${item.slug}` as Route)
                  }
                >
                  <Plug aria-hidden />
                  <span className="truncate">{item.name}</span>
                  <CommandShortcut>Integration</CommandShortcut>
                </CommandItem>
              ))}
            </CommandGroup>
            <CommandSeparator />
          </>
        ) : null}

        <CommandGroup heading="Go to">
          {visibleNav.map((item) => {
            const Icon = item.icon;
            return (
              <CommandItem
                key={item.href}
                value={item.label}
                keywords={item.keywords}
                onSelect={() => go(item.href)}
              >
                <Icon aria-hidden />
                <span>{item.label}</span>
                {item.kbd ? (
                  // Display-only manifest hint (⌘1…). NOT bound on web — the
                  // browser reserves ⌘1-9 for tab switching (SHELL-031).
                  <CommandShortcut>{item.kbd}</CommandShortcut>
                ) : null}
              </CommandItem>
            );
          })}
        </CommandGroup>

        <CommandSeparator />

        {canWrite ? (
          <>
            <CommandGroup heading="Create">
              {CREATE.map((item) => (
                <CommandItem
                  key={`create-${item.label}`}
                  value={item.label}
                  keywords={item.keywords}
                  onSelect={() => go(item.href)}
                >
                  <Plus aria-hidden />
                  <span>{item.label}</span>
                </CommandItem>
              ))}
            </CommandGroup>

            <CommandSeparator />

            <CommandGroup heading="Actions">
              {ACTIONS.map((item) => (
                <CommandItem
                  key={`action-${item.label}`}
                  value={item.label}
                  keywords={item.keywords}
                  onSelect={() => go(item.href)}
                >
                  <Zap aria-hidden />
                  <span>{item.label}</span>
                </CommandItem>
              ))}
            </CommandGroup>

            <CommandSeparator />
          </>
        ) : null}

        <CommandGroup heading="Settings">
          {visibleSettings.map((item) => {
            const Icon = item.icon;
            return (
              <CommandItem
                key={`set-${item.href}`}
                value={item.label}
                keywords={item.keywords}
                onSelect={() => go(item.href)}
              >
                <Icon aria-hidden />
                <span>{item.label}</span>
              </CommandItem>
            );
          })}
        </CommandGroup>

        <CommandSeparator />

        <CommandGroup heading="Preferences">
          <CommandItem
            value="Toggle theme dark light mode"
            keywords={["dark", "light", "appearance"]}
            onSelect={() => run(() => setTheme(isDark ? "light" : "dark"))}
          >
            {isDark ? <Sun aria-hidden /> : <Moon aria-hidden />}
            <span>
              {isDark ? "Switch to light mode" : "Switch to dark mode"}
            </span>
            <CommandShortcut>theme</CommandShortcut>
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
