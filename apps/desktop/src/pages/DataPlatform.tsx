/**
 * Data Platform — warehouse sync, custom objects, and CDP transforms
 * in one operator surface (#35 / #36 / #37).
 *
 * Four URL-backed, manually activated task sections:
 *   - Warehouse: provider/object catalog, connections (create runs the
 *     server-side validator BEFORE save and renders every error /
 *     warning; the create 400's body IS the validation result and is
 *     recovered into the same panel), per-connection import mappings
 *     (GET/PUT per source object), and sync runs (review → inline server
 *     execution despite HTTP 202, bounded run list, classified evidence).
 *   - Reverse ETL: mapping-contract preparation with execution held until a
 *     real source-row driver and governed write path exist.
 *   - Custom objects: tenant-defined object types (CRUD with a
 *     properties editor that round-trips the validator's JSON-Schema
 *     subset; richer schemas fall back to raw JSON so nothing is
 *     silently dropped) + a records browser (list / upsert / delete,
 *     422 violations rendered field-by-field). camelCase wire.
 *   - CDP transforms: registered-op catalog + a non-persistent preview
 *     playground (input JSON → POST preview → results and errors side
 *     by side). Nothing is persisted by preview.
 *
 * Backend: apps/api/internal/{warehouse,customobjects,cdp_transforms}.
 * Wire shapes per WIRING-WRAPPERS.md #35–#37.
 */

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
} from "react";

import { Icon, type IconName } from "../components/Icon";
import { PageHeader } from "../components/PageHeader";
import { CdpTransformsSection } from "../components/dataplatform/CdpTransformsSection";
import { CustomObjectsSection } from "../components/dataplatform/CustomObjectsSection";
import { ReverseETLSection } from "../components/dataplatform/ReverseETLSection";
import { WarehouseSection } from "../components/dataplatform/WarehouseSection";
import { useTabsInteraction } from "../hooks/useTabsInteraction";
import { useDesktopRouteTab } from "../lib/desktop-router";
import { useCanAdmin } from "../lib/store";

import "../styles-data-platform-control.css";
import "../styles-data-platform.css";

const TABS = [
  {
    id: "warehouse",
    label: "Warehouse",
    shortLabel: "Move data",
    description: "Connections, exports, and run evidence",
    icon: "chart-bars",
    adminOnly: true,
  },
  {
    id: "reverse-etl",
    label: "Reverse ETL",
    shortLabel: "Activate traits",
    description: "Map warehouse columns to profiles",
    icon: "git-branch",
    adminOnly: true,
  },
  {
    id: "objects",
    label: "Custom objects",
    shortLabel: "Model data",
    description: "Schemas and idempotent records",
    icon: "users",
    adminOnly: false,
  },
  {
    id: "transforms",
    label: "CDP transforms",
    shortLabel: "Test safely",
    description: "Dry-run property transformations",
    icon: "shield-check",
    adminOnly: false,
  },
] as const;
type TabId = (typeof TABS)[number]["id"];

const ROUTE_OVERLAY_SELECTOR =
  '.modal-backdrop, .slideover-backdrop, [aria-modal="true"][role="dialog"], [aria-modal="true"][role="alertdialog"]';

const TAB_CONTEXT: Record<
  TabId,
  { eyebrow: string; title: string; description: string; note: string }
> = {
  warehouse: {
    eyebrow: "Warehouse control plane",
    title: "Know what can move before you move it.",
    description:
      "Verify server capabilities, configure destinations, and follow every accepted run through privacy-bounded evidence.",
    note: "HTTP 202 is disclosed as inline execution—not a background queue.",
  },
  "reverse-etl": {
    eyebrow: "Profile activation",
    title: "Turn governed warehouse traits into profile fields.",
    description:
      "Define the source-to-profile contract here, then activate only when a live row-fetch runtime is attached.",
    note: "Mapping availability and execution availability are reported separately.",
  },
  objects: {
    eyebrow: "Tenant data model",
    title: "Give business records a durable, validated shape.",
    description:
      "Model orders, bookings, and other first-class objects, then inspect idempotent records without losing schema detail.",
    note: "Complex JSON Schema constraints stay editable instead of being flattened.",
  },
  transforms: {
    eyebrow: "Non-persistent laboratory",
    title: "Prove a property transform before it reaches a pipeline.",
    description:
      "Compose registered operations against sample JSON and inspect each mutation or failure side by side.",
    note: "Preview is a pure dry run; this workspace never saves the result.",
  },
};

export function DataPlatform(): ReactElement {
  const canAdmin = useCanAdmin();
  const routeRootRef = useRef<HTMLDivElement | null>(null);
  const [tab, setTab] = useDesktopRouteTab<TabId>(
    "dataPlatform",
    TABS.map((item) => item.id),
    "warehouse",
  );
  const tabs = useTabsInteraction({
    activation: "manual",
    value: tab,
    items: TABS.map((item) => ({ value: item.id })),
    onChange: setTab,
  });
  const [visitedTabs, setVisitedTabs] = useState<ReadonlySet<TabId>>(
    () => new Set([tab]),
  );
  const previousTabRef = useRef<TabId>(tab);
  useEffect(() => {
    setVisitedTabs((current) => {
      if (current.has(tab)) return current;
      return new Set([...current, tab]);
    });
  }, [tab]);
  useLayoutEffect(() => {
    const previousTab = previousTabRef.current;
    if (previousTab === tab) return;
    previousTabRef.current = tab;

    const routeRoot = routeRootRef.current;
    const previousPanel = routeRoot?.querySelector<HTMLElement>(
      `[data-data-platform-panel="${previousTab}"]`,
    );
    const overlayOwnedByPreviousPanel = previousPanel?.querySelector(
      ROUTE_OVERLAY_SELECTOR,
    );
    const activeElement = document.activeElement;
    const shouldRestoreTabFocus =
      Boolean(overlayOwnedByPreviousPanel) ||
      (activeElement instanceof HTMLElement &&
        Boolean(previousPanel?.contains(activeElement)));

    // Panels stay mounted after their first visit so editor/filter drafts survive
    // ordinary tab navigation. A dialog is different: Modal isolates the rest of
    // the document and locks body scroll for its mounted lifetime. Browser
    // Back/Forward can change the URL-backed tab without asking that dialog to
    // close, leaving it hidden under the old panel while its isolation leases
    // remain active. Evict only the panel that owns an open overlay; revisiting it
    // mounts a clean surface while every other visited panel keeps its state.
    if (overlayOwnedByPreviousPanel) {
      setVisitedTabs((current) => {
        if (!current.has(previousTab)) return current;
        const next = new Set(current);
        next.delete(previousTab);
        return next;
      });
    }

    if (!shouldRestoreTabFocus) return;
    let frame = 0;
    let remainingAttempts = 4;
    const focusSelectedTab = (): void => {
      const selectedTab = routeRootRef.current?.querySelector<HTMLElement>(
        '.dp-route-tab[role="tab"][aria-selected="true"]',
      );
      const isolationAncestor = selectedTab?.closest(
        '[inert], [aria-hidden="true"]',
      );
      if (selectedTab && !isolationAncestor) {
        selectedTab.focus({ preventScroll: true });
        return;
      }
      remainingAttempts -= 1;
      if (remainingAttempts > 0) {
        frame = window.requestAnimationFrame(focusSelectedTab);
      }
    };
    frame = window.requestAnimationFrame(focusSelectedTab);
    return () => window.cancelAnimationFrame(frame);
  }, [tab]);
  const context = TAB_CONTEXT[tab];

  return (
    <div ref={routeRootRef} className="page dp-page" data-active-tab={tab}>
      <div className="dp-masthead">
        <PageHeader
          eyebrow="Data infrastructure"
          title="Data platform"
          subtitle="A governed workspace for moving, modeling, and validating customer data—from warehouse boundaries to profile-ready records."
          meta={
            <div className="dp-trust-strip" aria-label="Workspace guarantees">
              <span className="dp-trust-pill">
                <Icon name={canAdmin ? "key" : "eye"} size={14} />
                {canAdmin ? "Admin controls enabled" : "View-only access"}
              </span>
              <span className="dp-trust-pill">
                <Icon name="shield-check" size={14} />
                Server-verified capability states
              </span>
              <span className="dp-trust-pill">
                <Icon name="eye-off" size={14} />
                Raw rejected values stay hidden
              </span>
            </div>
          }
        />
        <div className="dp-masthead-graphic" aria-hidden="true">
          <span className="dp-orbit dp-orbit-one" />
          <span className="dp-orbit dp-orbit-two" />
          <span className="dp-data-node dp-data-node-source" />
          <span className="dp-data-node dp-data-node-core" />
          <span className="dp-data-node dp-data-node-target" />
        </div>
      </div>

      <div
        ref={tabs.listRef}
        className="dp-route-tabs"
        {...tabs.listProps}
        aria-label="Data platform sections"
      >
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            {...tabs.getTabProps(t.id)}
            className={`dp-route-tab${tab === t.id ? " is-active" : ""}`}
          >
            <span className="dp-route-tab-icon" aria-hidden="true">
              <Icon name={t.icon as IconName} size={17} />
            </span>
            <span className="dp-route-tab-copy">
              <span className="dp-route-tab-kicker">{t.shortLabel}</span>
              <strong>{t.label}</strong>
              <span className="dp-route-tab-description">{t.description}</span>
              {t.adminOnly ? (
                <span className="dp-route-tab-access">
                  <Icon name="lock" size={10} /> Admin
                </span>
              ) : null}
            </span>
            <Icon
              name="chevron-right"
              size={14}
              className="dp-route-tab-arrow"
            />
          </button>
        ))}
      </div>

      <div className="dp-tab-context">
        <div className="dp-tab-context-copy">
          <span className="dp-tab-context-eyebrow">{context.eyebrow}</span>
          <h2>{context.title}</h2>
          <p>{context.description}</p>
        </div>
        <div className="dp-tab-context-note">
          <Icon name="shield-check" size={17} />
          <span>{context.note}</span>
        </div>
      </div>

      {TABS.map((item) => (
        <section
          key={item.id}
          className="dp-tab-panel"
          data-data-platform-panel={item.id}
          {...tabs.getPanelProps(item.id)}
        >
          {!visitedTabs.has(item.id) ? null : item.adminOnly && !canAdmin ? (
            <DataPlatformAccessBoundary area={item.label} />
          ) : item.id === "warehouse" ? (
            <WarehouseSection canAdmin />
          ) : item.id === "reverse-etl" ? (
            <ReverseETLSection canAdmin />
          ) : item.id === "objects" ? (
            <CustomObjectsSection canAdmin={canAdmin} />
          ) : (
            <CdpTransformsSection canAdmin={canAdmin} />
          )}
        </section>
      ))}
    </div>
  );
}

function DataPlatformAccessBoundary({ area }: { area: string }): ReactElement {
  return (
    <div className="dp-access-boundary" role="note">
      <span className="dp-access-boundary-icon" aria-hidden="true">
        <Icon name="lock" size={24} />
      </span>
      <div>
        <span className="dp-tab-context-eyebrow">Admin-scoped data plane</span>
        <h3>{area} requires administrator access</h3>
        <p>
          This server protects warehouse connection metadata, mappings, and run
          evidence with the admin scope. No request was sent from this view-only
          session.
        </p>
      </div>
      <span className="dp-status-pill">View-only session</span>
    </div>
  );
}
