"use client";

import Link from "next/link";
import type { Route } from "next";
import {
  type KeyboardEvent,
  type MutableRefObject,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  ArrowRightLeft,
  BadgeCheck,
  BarChart3,
  ClipboardCheck,
  ClipboardList,
  Building2,
  ChevronDown,
  CreditCard,
  Gavel,
  GitBranch,
  Handshake,
  Inbox,
  LayoutDashboard,
  LayoutTemplate,
  Mail,
  MessageSquareText,
  PanelTop,
  ShieldBan,
  TicketPercent,
  UserCog,
  Users,
  Webhook,
  Workflow,
} from "lucide-react";
import {
  DASHBOARD_NAV,
  DASHBOARD_NAV_COLLECTIONS,
  DASHBOARD_NAV_GROUP_LABELS,
  DASHBOARD_NAV_GROUP_ORDER,
} from "@/lib/dashboard-nav";
import type {
  DashboardNavGroup,
  DashboardRouteIcon,
} from "@/lib/dashboard-routes";
import type { RoleKey } from "@/lib/query-keys";
import { isRetentionOffersRoute } from "@/lib/retention-offers-access";
import { cn } from "@/lib/utils";

// Icons stay local (lucide is a client concern); the shared route manifest
// carries presentation-neutral icon keys for tests and non-React consumers.
const NAV_ICONS: Partial<Record<DashboardRouteIcon, typeof LayoutDashboard>> = {
  layoutDashboard: LayoutDashboard,
  users: Users,
  mail: Mail,
  barChart3: BarChart3,
  arrowRightLeft: ArrowRightLeft,
  clipboardCheck: ClipboardCheck,
  badgeCheck: BadgeCheck,
  messageSquareText: MessageSquareText,
  inbox: Inbox,
  workflow: Workflow,
  gitBranch: GitBranch,
  clipboardList: ClipboardList,
  panelTop: PanelTop,
  layoutTemplate: LayoutTemplate,
  webhook: Webhook,
  creditCard: CreditCard,
  handshake: Handshake,
  ticketPercent: TicketPercent,
  building2: Building2,
  gavel: Gavel,
  shieldBan: ShieldBan,
  userCog: UserCog,
};

interface DashboardNavItemView {
  label: string;
  href: Route;
  icon: typeof LayoutDashboard;
  group: DashboardNavGroup;
  scope: "member" | "admin";
}

const RAW_NAV_ITEMS: DashboardNavItemView[] = DASHBOARD_NAV.map((item) => ({
  label: item.label,
  href: item.href as Route,
  icon: NAV_ICONS[item.icon] ?? LayoutDashboard,
  group: item.group,
  scope: item.scope,
}));

// Flat list in SECTION order so the keyboard roving index (a single flat
// counter shared with the shell) matches the rendered top-to-bottom order.
export const DASHBOARD_NAV_ITEMS: DashboardNavItemView[] =
  DASHBOARD_NAV_GROUP_ORDER.flatMap((group) =>
    RAW_NAV_ITEMS.filter((item) => item.group === group),
  );

interface NavSection {
  group: DashboardNavGroup;
  label: string;
  items: { item: DashboardNavItemView; index: number }[];
  collections: {
    key: string;
    label: string;
    items: { item: DashboardNavItemView; index: number }[];
  }[];
}

const ITEM_INDEX_BY_HREF = new Map(
  DASHBOARD_NAV_ITEMS.map((item, index) => [item.href, index]),
);
const ITEM_BY_HREF = new Map(
  DASHBOARD_NAV_ITEMS.map((item) => [item.href, item]),
);

// The rail adds a web-only collection layer beneath the four canonical
// manifest groups. Every item retains its flat index so existing shell refs,
// tour anchors, and badges keep the same identity.
const NAV_SECTIONS: NavSection[] = DASHBOARD_NAV_GROUP_ORDER.map((group) => {
  const items = DASHBOARD_NAV_ITEMS.flatMap((item, index) =>
    item.group === group ? [{ item, index }] : [],
  );
  return {
    group,
    label: DASHBOARD_NAV_GROUP_LABELS[group],
    items,
    collections: DASHBOARD_NAV_COLLECTIONS.filter(
      (collection) => collection.group === group,
    ).map((collection) => ({
      key: collection.key,
      label: collection.label,
      items: collection.items.flatMap((collectionItem) => {
        const item = ITEM_BY_HREF.get(collectionItem.href as Route);
        const index = ITEM_INDEX_BY_HREF.get(collectionItem.href as Route);
        return item && index !== undefined ? [{ item, index }] : [];
      }),
    })),
  };
}).filter((section) => section.items.length > 0);

const COLLECTION_KEY_BY_HREF = new Map(
  NAV_SECTIONS.flatMap((section) =>
    section.collections.flatMap((collection) =>
      collection.items.map(({ item }) => [item.href, collection.key] as const),
    ),
  ),
);

export function isActive(pathname: string, href: string): boolean {
  if (href === "/app") return pathname === "/app";
  return pathname === href || pathname.startsWith(`${href}/`);
}

/** Most-specific sidebar destination that owns the current route. */
export function activeDashboardNavItem(
  pathname: string,
): DashboardNavItemView | null {
  return (
    DASHBOARD_NAV_ITEMS.filter((item) => isActive(pathname, item.href)).sort(
      (a, b) => b.href.length - a.href.length,
    )[0] ?? null
  );
}

export function nextDashboardNavIndex(
  key: string,
  index: number,
  total = DASHBOARD_NAV_ITEMS.length,
): number | null {
  if (total <= 0) return null;
  if (key === "ArrowDown") return (index + 1) % total;
  if (key === "ArrowUp") return (index - 1 + total) % total;
  if (key === "Home") return 0;
  if (key === "End") return total - 1;
  return null;
}

export function canAccessDashboardNavItem(
  item: Pick<DashboardNavItemView, "scope">,
  role: RoleKey,
  viewerMode: boolean,
): boolean {
  if (item.scope === "member") return role !== null;
  return !viewerMode && role !== null && (role === "owner" || role === "admin");
}

const TOUR_ANCHORS: Record<string, string> = {
  "/app/campaigns": "dashboard-nav-campaigns",
  "/app/subscribers": "dashboard-nav-subscribers",
  "/app/sequences": "dashboard-nav-sequences",
  "/app/analytics": "dashboard-nav-analytics",
  "/app/settings": "dashboard-nav-settings",
};

const GROUP_ICONS: Record<DashboardNavGroup, typeof LayoutDashboard> = {
  workspace: LayoutDashboard,
  growth: BarChart3,
  deliverability: ShieldBan,
  account: UserCog,
};

const COLLECTION_ICONS: Record<string, typeof LayoutDashboard> = {
  "workspace-core": LayoutDashboard,
  "workspace-operations": ClipboardCheck,
  "workspace-data-automation": GitBranch,
  "growth-create": LayoutTemplate,
  "growth-engage": Handshake,
  "growth-optimize-connect": BarChart3,
  "deliverability-monitor": Inbox,
  "deliverability-protect": ShieldBan,
  "account-workspace-management": Users,
  "account-governance-privacy": Gavel,
  "account-data-infrastructure": Building2,
};

const NAV_CONTROL_SELECTOR = "[data-dashboard-nav-control]";
const PINNED_UTILITY_HREF = "/app/settings" as Route;

function visibleNavControls(nav: HTMLElement): HTMLElement[] {
  return Array.from(
    nav.querySelectorAll<HTMLElement>(NAV_CONTROL_SELECTOR),
  ).filter((control) => control.closest("[hidden]") === null);
}

export function DashboardNav({
  pathname,
  collapsed,
  itemRefs,
  onNavKeyDown,
  onNavigate,
  railId,
  badges,
  canAccessRetention = true,
  role = "owner",
  viewerMode = false,
}: {
  pathname: string;
  collapsed: boolean;
  itemRefs?: MutableRefObject<Array<HTMLAnchorElement | null>>;
  onNavKeyDown?: (
    event: KeyboardEvent<HTMLAnchorElement>,
    index: number,
  ) => void;
  onNavigate?: () => void;
  railId: string;
  /** Optional per-route actionable count badges, keyed by href (SHELL-023). */
  badges?: Record<string, number>;
  /** Hide the admin-only retention destination for every denied role. */
  canAccessRetention?: boolean;
  /** Exact effective session role; admin manifest entries require owner/admin. */
  role?: RoleKey;
  /** Defence in depth when an owner/admin is explicitly browsing as viewer. */
  viewerMode?: boolean;
}) {
  const canShowItem = useCallback(
    (item: DashboardNavItemView): boolean =>
      canAccessDashboardNavItem(item, role, viewerMode) &&
      (canAccessRetention || !isRetentionOffersRoute(item.href)),
    [canAccessRetention, role, viewerMode],
  );
  const visibleSections = useMemo(
    () =>
      NAV_SECTIONS.map((section) => ({
        ...section,
        items: section.items.filter(({ item }) => canShowItem(item)),
        collections: section.collections.map((collection) => ({
          ...collection,
          items: collection.items.filter(({ item }) => canShowItem(item)),
        })),
      })).filter((section) => section.items.length > 0),
    [canShowItem],
  );
  const resolvedActiveItem = activeDashboardNavItem(pathname);
  const activeItem =
    resolvedActiveItem && canShowItem(resolvedActiveItem)
      ? resolvedActiveItem
      : null;
  const activeGroup = activeItem?.group ?? null;
  const activeCollection = activeItem
    ? (COLLECTION_KEY_BY_HREF.get(activeItem.href) ?? null)
    : null;
  const defaultGroup = activeGroup ?? "workspace";
  const defaultCollection =
    activeCollection ??
    visibleSections.find((section) => section.group === defaultGroup)
      ?.collections[0]?.key;
  const [openGroups, setOpenGroups] = useState<Set<DashboardNavGroup>>(
    () => new Set([defaultGroup]),
  );
  const [openCollections, setOpenCollections] = useState<Set<string>>(
    () => new Set(defaultCollection ? [defaultCollection] : []),
  );

  // The shell persists across Next.js soft navigations. Reset disclosure to
  // the new route's hierarchy so the current page is never hidden inside a
  // section the user closed on the previous route.
  useEffect(() => {
    setOpenGroups(new Set([defaultGroup]));
    setOpenCollections(new Set(defaultCollection ? [defaultCollection] : []));
  }, [defaultCollection, defaultGroup, pathname]);

  const toggleGroup = (group: DashboardNavGroup): void => {
    setOpenGroups((current) => {
      // The active route must remain perceivable in the navigation tree.
      if (group === activeGroup && current.has(group)) return current;
      const next = new Set(current);
      if (next.has(group)) next.delete(group);
      else next.add(group);
      return next;
    });
  };

  const toggleCollection = (key: string): void => {
    setOpenCollections((current) => {
      if (key === activeCollection && current.has(key)) return current;
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const onTreeKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    const target =
      event.target instanceof HTMLElement
        ? event.target.closest<HTMLElement>(NAV_CONTROL_SELECTOR)
        : null;
    if (!target) return;

    if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
      if (!target.hasAttribute("data-dashboard-nav-disclosure")) return;
      const expanded = target.getAttribute("aria-expanded") === "true";
      const shouldToggle =
        (event.key === "ArrowRight" && !expanded) ||
        (event.key === "ArrowLeft" && expanded);
      if (shouldToggle) {
        event.preventDefault();
        target.click();
      }
      return;
    }

    if (
      event.key !== "ArrowDown" &&
      event.key !== "ArrowUp" &&
      event.key !== "Home" &&
      event.key !== "End"
    ) {
      return;
    }

    const controls = visibleNavControls(event.currentTarget);
    const currentIndex = controls.indexOf(target);
    if (currentIndex < 0 || controls.length === 0) return;
    event.preventDefault();
    const nextIndex = nextDashboardNavIndex(
      event.key,
      currentIndex,
      controls.length,
    );
    if (nextIndex !== null) controls[nextIndex]?.focus();
  };

  const renderNavItem = (
    item: DashboardNavItemView,
    index: number,
    nested: boolean,
  ) => {
    const Icon = item.icon;
    const active = isActive(pathname, item.href);
    const badge = badges?.[item.href] ?? 0;
    return (
      <li key={item.href}>
        <Link
          ref={(element) => {
            if (itemRefs) itemRefs.current[index] = element;
          }}
          href={item.href}
          data-dashboard-nav-control
          data-tour={TOUR_ANCHORS[item.href]}
          title={item.label}
          aria-label={collapsed ? item.label : undefined}
          aria-current={active ? "page" : undefined}
          onClick={onNavigate}
          onKeyDown={(event) => {
            if (!event.defaultPrevented) onNavKeyDown?.(event, index);
          }}
          className={cn(
            "group relative flex min-h-11 w-full items-center gap-3 rounded-lg px-3 py-2 text-sm transition-[color,background-color,transform] duration-150 ease-pw-out active:scale-[0.99] md:min-h-9 [@media(pointer:coarse)]:min-h-11",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            active
              ? "bg-mw-pink-soft font-semibold text-mw-blue"
              : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
            collapsed && "justify-center px-0",
            !collapsed && nested && "pl-5",
          )}
        >
          {active ? (
            <span
              data-nav-rail={railId}
              className="absolute left-0 top-1/2 -mt-2.5 h-5 w-1 -rotate-2 rounded-r-full bg-mw-blue transition-opacity duration-150 motion-reduce:transition-none"
              aria-hidden
            />
          ) : null}
          <Icon
            className={cn(
              "h-4 w-4 shrink-0 transition-colors",
              active
                ? "text-mw-blue"
                : "text-muted-foreground group-hover:text-foreground",
            )}
            aria-hidden
          />
          {!collapsed && (
            <span className="min-w-0 flex-1 truncate">{item.label}</span>
          )}
          {!collapsed && active && (
            <span className="sr-only"> (current page)</span>
          )}
          {badge > 0 ? (
            collapsed ? (
              <span
                aria-hidden
                className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-primary ring-2 ring-card"
              />
            ) : (
              <span
                className="ml-auto min-w-5 rounded-full bg-primary/15 px-1.5 text-center text-[11px] font-semibold leading-5 text-primary"
                aria-label={`${badge} pending`}
              >
                {badge > 99 ? "99+" : badge}
              </span>
            )
          ) : null}
        </Link>
      </li>
    );
  };

  return (
    <nav
      role="navigation"
      aria-label="Primary"
      className="flex min-h-0 flex-1 flex-col p-2"
      onKeyDownCapture={onTreeKeyDown}
    >
      <div className="min-h-0 flex-1 space-y-1 overflow-y-auto overscroll-contain">
        {visibleSections.map((section) => {
          const GroupIcon = GROUP_ICONS[section.group];
          const groupOpen = openGroups.has(section.group);
          const groupContainsCurrent = section.group === activeGroup;
          const groupPanelId = `${railId}-${section.group}-section`;
          const groupTriggerId = `${groupPanelId}-trigger`;
          const groupBadge = section.items.reduce(
            (total, { item }) => total + (badges?.[item.href] ?? 0),
            0,
          );

          return (
            <div key={section.group} className="space-y-1">
              <button
                id={groupTriggerId}
                type="button"
                data-dashboard-nav-control
                data-dashboard-nav-disclosure
                data-dashboard-nav-group={section.group}
                aria-expanded={groupOpen}
                aria-controls={groupPanelId}
                aria-disabled={groupContainsCurrent || undefined}
                aria-label={
                  collapsed
                    ? `${section.label}, ${section.items.length} destinations${
                        groupContainsCurrent ? ", contains current page" : ""
                      }${groupBadge > 0 ? `, ${groupBadge} pending` : ""}`
                    : undefined
                }
                title={
                  collapsed
                    ? `${section.label} — ${groupOpen ? "hide" : "show"} section`
                    : groupContainsCurrent
                      ? "Contains the current page"
                      : undefined
                }
                onClick={() => toggleGroup(section.group)}
                className={cn(
                  "group relative flex min-h-11 w-full items-center gap-2 rounded-lg px-2.5 text-sm font-semibold text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:min-h-9 [@media(pointer:coarse)]:min-h-11",
                  groupOpen && "bg-mw-yellow/45 text-foreground",
                  collapsed && "justify-center px-0",
                )}
              >
                <GroupIcon
                  className={cn(
                    "h-4 w-4 shrink-0",
                    groupContainsCurrent && "text-mw-blue",
                  )}
                  aria-hidden
                />
                {collapsed && groupBadge > 0 ? (
                  <span
                    className="absolute left-1.5 top-1.5 h-2 w-2 rounded-full bg-primary ring-2 ring-card"
                    aria-hidden
                  />
                ) : null}
                {!collapsed && (
                  <>
                    <span className="min-w-0 flex-1 text-left">
                      {section.label}
                    </span>
                    <span
                      className="rounded-full bg-muted px-1.5 text-[10px] font-medium tabular-nums text-muted-foreground"
                      aria-hidden
                    >
                      {section.items.length}
                    </span>
                    {groupBadge > 0 ? (
                      <span
                        className="rounded-full bg-primary/15 px-1.5 text-[10px] font-semibold tabular-nums text-primary"
                        aria-label={`${groupBadge} pending in ${section.label}`}
                      >
                        {groupBadge > 99 ? "99+" : groupBadge}
                      </span>
                    ) : null}
                    <span className="sr-only">
                      {section.items.length} destinations
                      {groupContainsCurrent ? ", contains current page" : ""}
                    </span>
                  </>
                )}
                <ChevronDown
                  className={cn(
                    "h-3.5 w-3.5 shrink-0 transition-transform duration-150 motion-reduce:transition-none",
                    groupOpen ? "rotate-0" : "-rotate-90",
                    collapsed && "absolute right-1 h-3 w-3",
                  )}
                  aria-hidden
                />
              </button>

              <div
                id={groupPanelId}
                role="group"
                aria-labelledby={groupTriggerId}
                hidden={!groupOpen}
                className={cn(
                  !collapsed && "ml-2 border-l border-border/70 pl-1",
                )}
              >
                {collapsed ? (
                  <div className="space-y-1">
                    {section.collections.map((collection) => {
                      const CollectionIcon =
                        COLLECTION_ICONS[collection.key] ?? LayoutDashboard;
                      const collectionOpen = openCollections.has(
                        collection.key,
                      );
                      const collectionContainsCurrent =
                        collection.key === activeCollection;
                      const collectionPanelId = `${railId}-${collection.key}-collection`;
                      const collectionTriggerId = `${collectionPanelId}-trigger`;
                      const collectionItems = collection.items.filter(
                        ({ item }) => item.href !== PINNED_UTILITY_HREF,
                      );
                      const collectionBadge = collectionItems.reduce(
                        (total, { item }) => total + (badges?.[item.href] ?? 0),
                        0,
                      );
                      return (
                        <div key={collection.key} className="space-y-1">
                          <button
                            id={collectionTriggerId}
                            type="button"
                            data-dashboard-nav-control
                            data-dashboard-nav-disclosure
                            data-dashboard-nav-collection={collection.key}
                            aria-expanded={collectionOpen}
                            aria-controls={collectionPanelId}
                            aria-disabled={
                              collectionContainsCurrent || undefined
                            }
                            aria-label={`${collection.label}, ${collectionItems.length} destinations${
                              collectionContainsCurrent
                                ? ", contains current page"
                                : ""
                            }${
                              collectionBadge > 0
                                ? `, ${collectionBadge} pending`
                                : ""
                            }`}
                            title={`${collection.label} — ${
                              collectionOpen ? "hide" : "show"
                            } destinations`}
                            onClick={() => toggleCollection(collection.key)}
                            className={cn(
                              "relative flex min-h-11 w-full items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:min-h-9 [@media(pointer:coarse)]:min-h-11",
                              collectionOpen && "text-foreground",
                            )}
                          >
                            <CollectionIcon
                              className={cn(
                                "h-3.5 w-3.5",
                                collectionContainsCurrent && "text-primary",
                              )}
                              aria-hidden
                            />
                            {collectionBadge > 0 ? (
                              <span
                                className="absolute left-1.5 top-1.5 h-2 w-2 rounded-full bg-primary ring-2 ring-card"
                                aria-hidden
                              />
                            ) : null}
                            <ChevronDown
                              className={cn(
                                "absolute right-1 h-3 w-3 transition-transform duration-150 motion-reduce:transition-none",
                                collectionOpen ? "rotate-0" : "-rotate-90",
                              )}
                              aria-hidden
                            />
                          </button>
                          <div
                            id={collectionPanelId}
                            role="group"
                            aria-labelledby={collectionTriggerId}
                            hidden={!collectionOpen}
                            className="min-w-0"
                          >
                            <ul className="space-y-1" role="list">
                              {collectionItems.map(({ item, index }) =>
                                renderNavItem(item, index, false),
                              )}
                            </ul>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <div className="space-y-1">
                    {section.collections.map((collection) => {
                      const collectionOpen = openCollections.has(
                        collection.key,
                      );
                      const collectionContainsCurrent =
                        collection.key === activeCollection;
                      const collectionPanelId = `${railId}-${collection.key}-collection`;
                      const collectionTriggerId = `${collectionPanelId}-trigger`;
                      const collectionItems = collection.items.filter(
                        ({ item }) => item.href !== PINNED_UTILITY_HREF,
                      );
                      const collectionBadge = collectionItems.reduce(
                        (total, { item }) => total + (badges?.[item.href] ?? 0),
                        0,
                      );

                      return (
                        <div key={collection.key} className="space-y-1">
                          <button
                            id={collectionTriggerId}
                            type="button"
                            data-dashboard-nav-control
                            data-dashboard-nav-disclosure
                            data-dashboard-nav-collection={collection.key}
                            aria-expanded={collectionOpen}
                            aria-controls={collectionPanelId}
                            aria-disabled={
                              collectionContainsCurrent || undefined
                            }
                            title={
                              collectionContainsCurrent
                                ? "Contains the current page"
                                : undefined
                            }
                            onClick={() => toggleCollection(collection.key)}
                            className={cn(
                              "flex min-h-11 w-full items-center gap-2 rounded-md px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:min-h-9 [@media(pointer:coarse)]:min-h-11",
                              collectionOpen && "text-foreground",
                            )}
                          >
                            <ChevronDown
                              className={cn(
                                "h-3.5 w-3.5 shrink-0 transition-transform duration-150 motion-reduce:transition-none",
                                collectionOpen ? "rotate-0" : "-rotate-90",
                              )}
                              aria-hidden
                            />
                            <span className="min-w-0 flex-1 text-left">
                              {collection.label}
                            </span>
                            <span
                              className="text-[10px] tabular-nums text-muted-foreground"
                              aria-hidden
                            >
                              {collectionItems.length}
                            </span>
                            {collectionBadge > 0 ? (
                              <span
                                className="rounded-full bg-primary/15 px-1 text-[10px] font-semibold tabular-nums text-primary"
                                aria-label={`${collectionBadge} pending in ${collection.label}`}
                              >
                                {collectionBadge > 99 ? "99+" : collectionBadge}
                              </span>
                            ) : null}
                            <span className="sr-only">
                              {collectionItems.length} destinations
                              {collectionContainsCurrent
                                ? ", contains current page"
                                : ""}
                            </span>
                          </button>
                          <div
                            id={collectionPanelId}
                            role="group"
                            aria-labelledby={collectionTriggerId}
                            hidden={!collectionOpen}
                            className="min-w-0"
                          >
                            <ul className="space-y-1" role="list">
                              {collectionItems.map(({ item, index }) =>
                                renderNavItem(item, index, true),
                              )}
                            </ul>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
      {(() => {
        const pinned = ITEM_BY_HREF.get(PINNED_UTILITY_HREF);
        const index = ITEM_INDEX_BY_HREF.get(PINNED_UTILITY_HREF);
        if (!pinned || index === undefined) return null;
        return (
          <div className="mt-2 shrink-0 border-t bg-card pt-2">
            <ul role="list">{renderNavItem(pinned, index, false)}</ul>
          </div>
        );
      })()}
    </nav>
  );
}
