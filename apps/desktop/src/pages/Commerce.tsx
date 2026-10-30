/**
 * Commerce — operator surface for the ~20-route commerce suite (#33).
 *
 * Four tabs, each cohesive on its own:
 *   - Integrations: store connections (bare-array wire), per-integration
 *     sync/backfill (202 + verbatim summary toast), a per-integration
 *     analytics strip, and paged customers / products / orders / events
 *     browsing with variants / inventory / price-history drilldowns.
 *   - Catalogs: product catalogs (list/create), JSON product import
 *     (202 + verbatim summary), and product feeds with a resolve
 *     preview (columns + rows exactly as the resolver returned them).
 *   - Recovery & alerts: cart-recovery links, back-in-stock
 *     subscriptions, and price-drop watchers (lists + creates; the
 *     create routes for BIS/price-drop are nested under
 *     /integrations/{id}/products/{product_id}/…).
 *   - Lifecycle: evaluate eligibility (admin) + the lifecycle report.
 *
 * Honest-UI rules: load failures render the backend's error (404 →
 * "not enabled on this server"), 202 responses toast as accepted-not-
 * finished, and admin-only mutations are RBAC-gated via useCanAdmin.
 *
 * Backend: apps/api/internal/commerce. Wire shapes per
 * WIRING-WRAPPERS.md #33 (`{items, total, page, per_page}` envelopes
 * everywhere except the integrations list, which is a bare array).
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactElement,
} from "react";

import { Icon, type IconName } from "../components/Icon";
import { CatalogsTab } from "../components/commerce/CatalogsTab";
import { IntegrationsTab } from "../components/commerce/IntegrationsTab";
import { LifecycleTab } from "../components/commerce/LifecycleTab";
import { RecoveryTab } from "../components/commerce/RecoveryTab";
import { type CommerceIntegration, commerceApi } from "../lib/api-client";
import { useCapabilityReporter } from "../lib/capability-observations";
import { useTabsInteraction } from "../hooks/useTabsInteraction";
import { parseCommerceAdministrationIntent } from "../lib/commerce-owner-intents";
import {
  navigateDesktopRoute,
  useDesktopRoute,
  useDesktopRouteTab,
} from "../lib/desktop-router";
import { useCanAdmin } from "../lib/store";

import "../styles-commerce.css";

const TABS = [
  {
    id: "integrations",
    label: "Stores",
    eyebrow: "Connection layer",
    description: "Connect, verify, and browse storefront data.",
    icon: "git-branch",
  },
  {
    id: "catalogs",
    label: "Catalogs & feeds",
    eyebrow: "Product layer",
    description: "Shape catalog sources into reusable feeds.",
    icon: "chart-bars",
  },
  {
    id: "recovery",
    label: "Recovery",
    eyebrow: "Moment layer",
    description: "Review cart, inventory, and price signals.",
    icon: "megaphone",
  },
  {
    id: "lifecycle",
    label: "Lifecycle health",
    eyebrow: "Eligibility layer",
    description: "Evaluate demand without implying delivery.",
    icon: "clock",
  },
] as const;
type TabId = (typeof TABS)[number]["id"];

function HeroWorkflow(): ReactElement {
  const stages: ReadonlyArray<{
    label: string;
    detail: string;
    icon: IconName;
  }> = [
    {
      label: "Store signal",
      detail: "Provider event",
      icon: "git-branch",
    },
    {
      label: "Commerce context",
      detail: "Canonical record",
      icon: "chart-bars",
    },
    {
      label: "Message moment",
      detail: "Review first",
      icon: "mail",
    },
  ];

  return (
    <div className="commerce-hero-workflow">
      <p className="visually-hidden">
        Commerce workflow: a provider-reported store signal becomes canonical
        commerce context, then a review-first message opportunity.
      </p>
      <div className="commerce-workflow-head" aria-hidden="true">
        <span>Signal path</span>
        <span className="commerce-workflow-live">
          <span />
          Review first
        </span>
      </div>
      <div className="commerce-workflow-track" aria-hidden="true">
        {stages.map((stage, index) => (
          <div className="commerce-workflow-stage-wrap" key={stage.label}>
            <article className="commerce-workflow-stage">
              <span className="commerce-workflow-icon">
                <Icon name={stage.icon} size={18} />
              </span>
              <span>
                <strong>{stage.label}</strong>
                <small>{stage.detail}</small>
              </span>
            </article>
            {index < stages.length - 1 ? (
              <span className="commerce-workflow-connector">
                <span />
                <Icon name="chevron-right" size={13} />
              </span>
            ) : null}
          </div>
        ))}
      </div>
      <div className="commerce-workflow-foot" aria-hidden="true">
        <Icon name="shield-check" size={14} />
        No mutation runs when this workspace opens.
      </div>
    </div>
  );
}

function latestRecordedSync(
  integrations: CommerceIntegration[] | null,
): string {
  if (!integrations) return "—";
  const timestamps = integrations
    .map((integration) => integration.last_sync_at)
    .filter((value): value is string => Boolean(value))
    .map((value) => Date.parse(value))
    .filter((value) => Number.isFinite(value));
  if (timestamps.length === 0) return "Not recorded";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(Math.max(...timestamps)));
}

export function Commerce(): ReactElement {
  const canAdmin = useCanAdmin();
  const route = useDesktopRoute();
  const administrationIntent = parseCommerceAdministrationIntent(route);
  const { available, fromApiError } = useCapabilityReporter(
    "commerce",
    "commerce-suite",
  );
  const [tab, setTab] = useDesktopRouteTab<TabId>(
    "commerce",
    TABS.map((item) => item.id),
    "integrations",
  );

  // Integrations are shared context: the recovery + lifecycle tabs and
  // the browse tables all key off an integration id.
  const [integrations, setIntegrations] = useState<
    CommerceIntegration[] | null
  >(null);
  const [intErr, setIntErr] = useState<string | null>(null);
  const [intLoading, setIntLoading] = useState(false);
  const integrationsRef = useRef<CommerceIntegration[] | null>(null);
  // Generation counter: a double-Refresh race must not let a stale
  // (e.g. errored) response overwrite the fresher one.
  const intGen = useRef(0);

  const loadIntegrations = useCallback(async (): Promise<void> => {
    const gen = ++intGen.current;
    setIntLoading(true);
    setIntErr(null);
    const res = await commerceApi.listIntegrations();
    if (gen !== intGen.current) return; // stale
    setIntLoading(false);
    if (res.error) {
      fromApiError(res.error, {
        endpointAbsenceMeansNotConfigured: true,
      });
      setIntErr(
        res.error.status === 404 || res.error.status === 405
          ? "Commerce isn't enabled on this Moosewave server. Update the API and try again."
          : res.error.status === 403
            ? "This server restricts store discovery to administrators, so read-only Commerce reports cannot be safely scoped from this account."
            : res.error.message,
      );
      if (integrationsRef.current === null) {
        integrationsRef.current = [];
        setIntegrations([]);
      }
      return;
    }
    if (!Array.isArray(res.data)) {
      const retained = integrationsRef.current !== null;
      setIntErr(
        retained
          ? "Commerce returned an invalid store-connection response. Previously verified connections remain visible."
          : "Commerce returned an invalid store-connection response. No connections are shown as verified.",
      );
      if (integrationsRef.current === null) {
        integrationsRef.current = [];
        setIntegrations([]);
      }
      return;
    }
    available();
    integrationsRef.current = res.data;
    setIntegrations(res.data);
  }, [available, fromApiError]);

  useEffect(() => {
    void loadIntegrations();
  }, [loadIntegrations]);

  const resolveAdministrationIntent = useCallback((): void => {
    navigateDesktopRoute(
      { section: "commerce" },
      { replace: true, source: "navigation" },
    );
  }, []);

  const selectTab = (next: TabId): void => {
    if (!administrationIntent) {
      setTab(next);
      return;
    }
    navigateDesktopRoute({
      section: "commerce",
      ...(next === "integrations" ? {} : { tab: next }),
    });
  };
  const tabs = useTabsInteraction({
    activation: "manual",
    value: tab,
    items: TABS.map((item) => ({ value: item.id })),
    onChange: selectTab,
  });
  const healthyConnections =
    integrations?.filter((integration) => {
      const status = integration.status.toLowerCase();
      return (
        (status === "active" || status === "connected") &&
        !integration.error_message &&
        !integration.sync_state?.last_error
      );
    }).length ?? null;
  const attentionConnections =
    integrations?.filter((integration) => {
      const status = integration.status.toLowerCase();
      return (
        !["active", "connected"].includes(status) ||
        Boolean(integration.error_message) ||
        Boolean(integration.sync_state?.last_error)
      );
    }).length ?? null;
  const summaryUnavailable = Boolean(intErr && !integrations?.length);
  const workspaceStatus = intLoading
    ? "Verifying workspace"
    : intErr
      ? integrations?.length
        ? "Refresh failed · retained states"
        : "Verification unavailable"
      : integrations === null
        ? "Loading connections"
        : integrations.length === 0
          ? "Ready to connect"
          : attentionConnections
            ? "Review needed"
            : "Recorded states verified";
  const activeTab = TABS.find((item) => item.id === tab) ?? TABS[0];

  return (
    <div className="page commerce-page">
      <section className="commerce-hero" aria-labelledby="commerce-title">
        <div className="commerce-hero-copy">
          <div className="commerce-hero-eyebrow">
            <span>
              <Icon name="chart-bars" size={14} />
            </span>
            Commerce operations
          </div>
          <div
            className={`commerce-hero-status${intErr ? " is-unavailable" : attentionConnections ? " needs-review" : ""}`}
            role="status"
            aria-live="polite"
          >
            <span aria-hidden="true" />
            {workspaceStatus}
          </div>
          <h1 id="commerce-title">
            <span className="visually-hidden">Commerce — </span>
            Turn storefront signals into timely customer moments.
          </h1>
          <p>
            Connect store data, shape products into reusable feeds, and inspect
            recovery eligibility from one operator workspace.
          </p>

          <div
            className="commerce-hero-facts"
            aria-label="Commerce connection snapshot"
          >
            <span>
              <strong>Connections</strong>
              {summaryUnavailable
                ? "Unavailable"
                : integrations
                  ? integrations.length.toLocaleString()
                  : "—"}
            </span>
            <span>
              <strong>Healthy</strong>
              {summaryUnavailable
                ? "Unavailable"
                : healthyConnections === null
                  ? "—"
                  : healthyConnections.toLocaleString()}
            </span>
            <span>
              <strong>Needs review</strong>
              {summaryUnavailable
                ? "Unavailable"
                : attentionConnections === null
                  ? "—"
                  : attentionConnections.toLocaleString()}
            </span>
            <span>
              <strong>Last recorded sync</strong>
              {summaryUnavailable
                ? "Unavailable"
                : latestRecordedSync(integrations)}
            </span>
          </div>

          <div className="commerce-hero-actions">
            <button
              type="button"
              className="btn btn-sm commerce-refresh"
              aria-busy={intLoading || undefined}
              aria-disabled={intLoading || undefined}
              onClick={() => {
                if (!intLoading) void loadIntegrations();
              }}
            >
              {intLoading ? "Refreshing store states…" : "Refresh store states"}
            </button>
            <span>
              Store states only; each dataset owns its refresh. Provider
              capability is partial and certification-pending.
            </span>
          </div>

          <p className="commerce-authority-note">
            <Icon name="shield-check" size={15} />
            <span>
              Recorded connection state is not proof of complete provider
              reconciliation or message delivery. Imported commerce records may
              remain after a store is paused or disconnected.
            </span>
          </p>
        </div>
        <HeroWorkflow />
      </section>

      <div
        ref={tabs.listRef}
        className="commerce-mode-tabs"
        {...tabs.listProps}
        aria-label="Commerce sections"
      >
        {TABS.map((item, index) => (
          <button
            key={item.id}
            type="button"
            {...tabs.getTabProps(item.id)}
            className={`commerce-mode-tab${tab === item.id ? " is-active" : ""}`}
          >
            <span className="commerce-mode-index" aria-hidden="true">
              {String(index + 1).padStart(2, "0")}
            </span>
            <span className="commerce-mode-icon" aria-hidden="true">
              <Icon name={item.icon} size={17} />
            </span>
            <span className="commerce-mode-copy">
              <small>{item.eyebrow}</small>
              <strong>{item.label}</strong>
              <span>{item.description}</span>
            </span>
            <Icon
              name="chevron-right"
              size={14}
              className="commerce-mode-arrow"
            />
          </button>
        ))}
      </div>

      {TABS.map((item) => (
        <section
          key={item.id}
          {...tabs.getPanelProps(item.id)}
          className="commerce-tab-panel"
          aria-labelledby={tabs.getTabProps(item.id).id}
          data-commerce-view={item.id}
        >
          {tab !== item.id ? null : (
            <>
              <h2 className="visually-hidden">{item.label} workspace</h2>
              {item.id === "integrations" ? (
                <IntegrationsTab
                  integrations={integrations}
                  err={intErr}
                  canAdmin={canAdmin}
                  onReload={loadIntegrations}
                  administrationIntent={administrationIntent}
                  onAdministrationIntentResolved={resolveAdministrationIntent}
                />
              ) : item.id === "catalogs" ? (
                <CatalogsTab canAdmin={canAdmin} integrations={integrations} />
              ) : item.id === "recovery" ? (
                <RecoveryTab
                  integrations={integrations}
                  integrationsErr={intErr}
                  canAdmin={canAdmin}
                />
              ) : (
                <LifecycleTab
                  integrations={integrations}
                  integrationsErr={intErr}
                  canAdmin={canAdmin}
                />
              )}
            </>
          )}
        </section>
      ))}

      <p className="visually-hidden" aria-live="polite">
        {activeTab.label} workspace selected. {activeTab.description}
      </p>
    </div>
  );
}
