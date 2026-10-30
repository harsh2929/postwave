import { type ReactElement, useEffect, useMemo, useState } from "react";

import { useAuditScopes } from "../lib/auditScopes";
import type { CapabilityAccessDecision } from "../lib/capability-access";
import {
  capabilityReadinessLabel,
  capabilityForSection,
  DESKTOP_NAV_DOMAINS,
} from "../lib/desktop-capabilities";
import { type PersistentDesktopSection } from "../lib/desktop-routes";
import { desktopRouteIdentityScope } from "../lib/desktop-router";
import {
  desktopShortcutById,
  formatShortcutBinding,
  loadShortcutPreferences,
  shortcutAriaKeyShortcuts,
  shortcutBindingFor,
  subscribeShortcutPreferences,
} from "../lib/desktop-shortcuts";
import type { NavigationPreferences } from "../lib/navigation-preferences";
import { useOnline } from "../lib/online-manager";
import {
  setSection,
  useMe,
  useRole,
  useRoleStatus,
  useSection,
} from "../lib/store";
import { NewBadge } from "./NewBadge";
import { ALL_NAV_ITEMS, type SidebarNavItem } from "./SidebarNavigationCatalog";

interface Props {
  onCollapsedChange: (collapsed: boolean) => void;
}

const ITEM_BY_SECTION = new Map(
  ALL_NAV_ITEMS.map((item) => [item.id, item] as const),
);

const EMPTY_NAVIGATION_PREFERENCES: NavigationPreferences = {
  favorites: [],
  collapsedDomains: [],
  sidebarCollapsed: false,
};

function sameAccessDecisions(
  current: ReadonlyMap<PersistentDesktopSection, CapabilityAccessDecision>,
  next: ReadonlyMap<PersistentDesktopSection, CapabilityAccessDecision>,
): boolean {
  if (current.size !== next.size) return false;
  for (const [section, decision] of next) {
    const previous = current.get(section);
    if (
      !previous ||
      previous.state !== decision.state ||
      previous.canEnter !== decision.canEnter ||
      previous.label !== decision.label ||
      previous.reason !== decision.reason ||
      previous.recoverySection !== decision.recoverySection
    ) {
      return false;
    }
  }
  return true;
}

const Chevron = ({ className }: { className?: string }): ReactElement => (
  <svg
    className={className}
    width="12"
    height="12"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="m6 9 6 6 6-6" />
  </svg>
);

interface SidebarNavigationItemProps {
  item: SidebarNavItem;
  active: boolean;
  resolvedAccess: CapabilityAccessDecision | undefined;
  favorite: boolean;
  shortcutPreferences: ReturnType<typeof loadShortcutPreferences>;
  onToggleFavorite: () => void;
}

function SidebarNavigationItem({
  item,
  active,
  resolvedAccess,
  favorite,
  shortcutPreferences,
  onToggleFavorite,
}: SidebarNavigationItemProps): ReactElement {
  const Icon = item.icon;
  const itemCapability = capabilityForSection(item.id);
  const access =
    resolvedAccess ??
    ({
      state: "available",
      canEnter: true,
      label: capabilityReadinessLabel(itemCapability.readiness),
      reason: itemCapability.limitation ?? null,
    } satisfies CapabilityAccessDecision);
  const shortcut = item.shortcutId
    ? desktopShortcutById(item.shortcutId)
    : null;
  const shortcutBinding = shortcut
    ? shortcutBindingFor(shortcut, shortcutPreferences)
    : null;
  const shortcutLabel = shortcutBinding
    ? formatShortcutBinding(shortcutBinding)
    : null;
  const accessReasonId = access.reason
    ? `sidebar-item-${item.id}-access-reason`
    : undefined;
  return (
    <div className="sidebar-item-row">
      <button
        type="button"
        className={`sidebar-item${active ? " is-active" : ""}${
          !access.canEnter ? " is-restricted" : ""
        }`}
        onClick={() => setSection(item.id)}
        aria-current={active ? "page" : undefined}
        aria-label={
          access.label ? `${item.label} — ${access.label}` : item.label
        }
        aria-describedby={accessReasonId}
        aria-keyshortcuts={
          shortcutBinding
            ? shortcutAriaKeyShortcuts(shortcutBinding)
            : undefined
        }
        data-testid={item.id === "audit" ? "sidebar-audit" : undefined}
        data-tour={`nav-${item.id}`}
        data-section={item.id}
      >
        <Icon className="sidebar-item-icon" />
        <span className="sidebar-item-label">{item.label}</span>
        {access.label ? (
          <span className="sidebar-item-status">{access.label}</span>
        ) : null}
        <NewBadge section={item.id} />
        {shortcutLabel ? (
          <span className="sidebar-item-kbd">{shortcutLabel}</span>
        ) : null}
      </button>
      {access.reason ? (
        <span id={accessReasonId} className="visually-hidden">
          {access.reason}
        </span>
      ) : null}
      <button
        type="button"
        className={`sidebar-favorite${favorite ? " is-favorite" : ""}`}
        aria-label={`${favorite ? "Remove" : "Add"} ${item.label} ${
          favorite ? "from" : "to"
        } favorites`}
        aria-pressed={favorite}
        onClick={onToggleFavorite}
      >
        <span aria-hidden="true">{favorite ? "★" : "☆"}</span>
      </button>
    </div>
  );
}

type NavigationDomain = (typeof DESKTOP_NAV_DOMAINS)[number];

interface SidebarDomainSectionProps {
  domain: NavigationDomain;
  items: SidebarNavItem[];
  collapsed: boolean;
  renderItem: (item: SidebarNavItem) => ReactElement;
  onToggle: () => void;
}

function SidebarDomainSection({
  domain,
  items,
  collapsed,
  renderItem,
  onToggle,
}: SidebarDomainSectionProps): ReactElement {
  const headingId = `sidebar-domain-${domain.id}`;
  const descriptionId = `${headingId}-description`;
  return (
    <section
      className="sidebar-section sidebar-domain"
      aria-labelledby={headingId}
    >
      <h2 id={headingId} className="sidebar-section-label">
        <button
          type="button"
          className="sidebar-domain-toggle"
          aria-expanded={!collapsed}
          aria-describedby={descriptionId}
          onClick={onToggle}
        >
          <span>{domain.label}</span>
          <span className="sidebar-domain-count">{items.length}</span>
          <Chevron
            className={`sidebar-domain-chev${collapsed ? " is-collapsed" : ""}`}
          />
        </button>
      </h2>
      <span id={descriptionId} className="visually-hidden">
        {domain.description}
      </span>
      {!collapsed ? items.map(renderItem) : null}
    </section>
  );
}

export function SidebarDomainNavigation({
  onCollapsedChange,
}: Props): ReactElement {
  const section = useSection();
  const me = useMe();
  const role = useRole();
  const roleStatus = useRoleStatus();
  const online = useOnline();
  const recentScope = desktopRouteIdentityScope(me?.user, me?.tenant);
  const itemBySection = ITEM_BY_SECTION;
  const [preferences, setPreferences] = useState<NavigationPreferences>(
    EMPTY_NAVIGATION_PREFERENCES,
  );
  const [shortcutRevision, setShortcutRevision] = useState(0);
  const [recentSections, setRecentSections] = useState<
    PersistentDesktopSection[]
  >([]);
  const [accessBySection, setAccessBySection] = useState<
    ReadonlyMap<PersistentDesktopSection, CapabilityAccessDecision>
  >(new Map());
  const auditScopeState = useAuditScopes();

  useEffect(
    () =>
      subscribeShortcutPreferences(() =>
        setShortcutRevision((revision) => revision + 1),
      ),
    [],
  );
  const shortcutPreferences = useMemo(
    () => loadShortcutPreferences(),
    [shortcutRevision],
  );

  useEffect(() => {
    onCollapsedChange(preferences.sidebarCollapsed);
  }, [onCollapsedChange, preferences.sidebarCollapsed]);

  useEffect(() => {
    let cancelled = false;
    setPreferences(EMPTY_NAVIGATION_PREFERENCES);
    setRecentSections([]);
    void import("../lib/navigation-preferences").then((navigation) => {
      if (cancelled) return;
      setPreferences(navigation.loadNavigationPreferences(recentScope));
      setRecentSections(
        navigation.recentDestinationSections(
          navigation.loadNavigationRecents(recentScope),
        ),
      );
    });
    return () => {
      cancelled = true;
    };
  }, [recentScope]);

  useEffect(() => {
    let cancelled = false;
    let unsubscribe = (): void => undefined;
    void Promise.all([
      import("../lib/capability-access"),
      import("../lib/capability-observations"),
    ]).then(([accessModule, observationModule]) => {
      if (cancelled) return;
      const recompute = (): void => {
        const decisions = new Map<
          PersistentDesktopSection,
          CapabilityAccessDecision
        >();
        for (const item of ALL_NAV_ITEMS) {
          decisions.set(
            item.id,
            accessModule.resolveCapabilityAccess(item.id, {
              role,
              roleStatus,
              online,
              audit: {
                loading: auditScopeState.loading,
                isAdmin: auditScopeState.isAdmin,
                scopes: auditScopeState.scopes,
                error: auditScopeState.error,
              },
              observation: observationModule.getCapabilityObservation(
                recentScope,
                item.id,
              ),
            }),
          );
        }
        if (!cancelled) {
          setAccessBySection((current) =>
            sameAccessDecisions(current, decisions) ? current : decisions,
          );
        }
      };
      recompute();
      unsubscribe = observationModule.subscribeCapabilityObservations(
        recentScope,
        recompute,
      );
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [
    auditScopeState.error,
    auditScopeState.isAdmin,
    auditScopeState.loading,
    auditScopeState.scopes,
    online,
    recentScope,
    role,
    roleStatus,
  ]);

  useEffect(() => {
    const item = itemBySection.get(section as PersistentDesktopSection);
    if (!recentScope || !item) return;
    let cancelled = false;
    void import("../lib/navigation-preferences").then((navigation) => {
      if (cancelled) return;
      navigation.pushNavigationRecent(recentScope, {
        id: `nav:${item.id}`,
        label: item.label,
        group: "Navigation",
        kind: "nav",
        section: item.id,
      });
      setRecentSections(
        navigation.recentDestinationSections(
          navigation.loadNavigationRecents(recentScope),
        ),
      );
    });

    const activeDomain = capabilityForSection(item.id).domain;
    setPreferences((current) => {
      if (!current.collapsedDomains.includes(activeDomain)) return current;
      const next = {
        ...current,
        collapsedDomains: current.collapsedDomains.filter(
          (domain) => domain !== activeDomain,
        ),
      };
      void import("../lib/navigation-preferences").then((navigation) =>
        navigation.saveNavigationPreferences(recentScope, next),
      );
      return next;
    });
    return () => {
      cancelled = true;
    };
  }, [itemBySection, recentScope, section]);

  const updatePreferences = (
    update: (current: NavigationPreferences) => NavigationPreferences,
  ): void => {
    setPreferences((current) => {
      const next = update(current);
      void import("../lib/navigation-preferences").then((navigation) =>
        navigation.saveNavigationPreferences(recentScope, next),
      );
      return next;
    });
  };

  const renderItem = (item: SidebarNavItem): ReactElement => {
    const favorite = preferences.favorites.includes(item.id);
    return (
      <SidebarNavigationItem
        key={item.id}
        item={item}
        active={section === item.id}
        resolvedAccess={accessBySection.get(item.id)}
        favorite={favorite}
        shortcutPreferences={shortcutPreferences}
        onToggleFavorite={() =>
          updatePreferences((current) => ({
            ...current,
            favorites: favorite
              ? current.favorites.filter((sectionId) => sectionId !== item.id)
              : [...current.favorites, item.id],
          }))
        }
      />
    );
  };

  return (
    <>
      <nav className="sidebar-scroll" aria-label="Primary">
        {preferences.favorites.length > 0 ? (
          <section
            className="sidebar-section sidebar-section-promoted"
            aria-labelledby="sidebar-favorites-heading"
          >
            <h2
              id="sidebar-favorites-heading"
              className="sidebar-section-label"
            >
              Favorites
            </h2>
            {preferences.favorites
              .map((sectionId) => itemBySection.get(sectionId))
              .filter((item): item is SidebarNavItem => item !== undefined)
              .map(renderItem)}
          </section>
        ) : null}

        {recentSections.some(
          (sectionId) => !preferences.favorites.includes(sectionId),
        ) ? (
          <section
            className="sidebar-section sidebar-section-promoted"
            aria-labelledby="sidebar-recents-heading"
          >
            <h2 id="sidebar-recents-heading" className="sidebar-section-label">
              Recent
            </h2>
            {recentSections
              .filter((sectionId) => !preferences.favorites.includes(sectionId))
              .map((sectionId) => itemBySection.get(sectionId))
              .filter((item): item is SidebarNavItem => item !== undefined)
              .map(renderItem)}
          </section>
        ) : null}

        {DESKTOP_NAV_DOMAINS.map((domain) => {
          const domainItems = ALL_NAV_ITEMS.filter(
            (item) =>
              capabilityForSection(item.id).domain === domain.id,
          );
          if (domainItems.length === 0) return null;
          const containsActive = domainItems.some(
            (item) => item.id === section,
          );
          const collapsed =
            !preferences.sidebarCollapsed &&
            preferences.collapsedDomains.includes(domain.id) &&
            !containsActive;
          return (
            <SidebarDomainSection
              key={domain.id}
              domain={domain}
              items={domainItems}
              collapsed={collapsed}
              renderItem={renderItem}
              onToggle={() =>
                updatePreferences((current) => ({
                  ...current,
                  collapsedDomains: current.collapsedDomains.includes(domain.id)
                    ? current.collapsedDomains.filter(
                        (candidate) => candidate !== domain.id,
                      )
                    : [...current.collapsedDomains, domain.id],
                }))
              }
            />
          );
        })}
      </nav>

      <button
        type="button"
        className="sidebar-collapse"
        aria-label={
          preferences.sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"
        }
        aria-pressed={preferences.sidebarCollapsed}
        onClick={() =>
          updatePreferences((current) => ({
            ...current,
            sidebarCollapsed: !current.sidebarCollapsed,
          }))
        }
      >
        <span aria-hidden="true">
          {preferences.sidebarCollapsed ? "›" : "‹"}
        </span>
        <span className="sidebar-collapse-label">
          {preferences.sidebarCollapsed ? "Expand" : "Collapse"}
        </span>
      </button>
    </>
  );
}
