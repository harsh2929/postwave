import { type ReactElement } from "react";

import { Icon, type IconName } from "../components/Icon";
import { Notice } from "../components/Notice";
import { ModerationTab } from "../components/reviews/ModerationTab";
import { WidgetsTab } from "../components/reviews/WidgetsTab";
import { useRemoteResource } from "../hooks/useRemoteResource";
import { useTabsInteraction } from "../hooks/useTabsInteraction";
import { reviewsApi } from "../lib/api-client";
import {
  navigateDesktopRoute,
  useDesktopRouteTab,
} from "../lib/desktop-router";
import { parseReviewsCatalog } from "../lib/reviews-helpers";
import { useCanAdmin } from "../lib/store";

import "../styles-reviews.css";
import "../styles-reviews-detail.css";
import "../styles-reviews-widgets.css";

const TABS = [
  {
    id: "moderation",
    label: "Moderation inbox",
    eyebrow: "Decision layer",
    description: "Inspect complete evidence before anything becomes public.",
    icon: "shield-check",
  },
  {
    id: "widgets",
    label: "Storefront widgets",
    eyebrow: "Delivery layer",
    description:
      "Inspect reported deployment material separately from inactive inventory.",
    icon: "chart-bars",
  },
] as const satisfies ReadonlyArray<{
  id: string;
  label: string;
  eyebrow: string;
  description: string;
  icon: IconName;
}>;

type TabId = (typeof TABS)[number]["id"];

function TrustPath(): ReactElement {
  const stages: ReadonlyArray<{
    title: string;
    detail: string;
    icon: IconName;
  }> = [
    {
      title: "Intake",
      detail: "Reported customer evidence",
      icon: "mail",
    },
    {
      title: "Evidence",
      detail: "Full record, source, and trust",
      icon: "eye",
    },
    {
      title: "Decision",
      detail: "Explicit human confirmation",
      icon: "shield-check",
    },
    {
      title: "Storefront",
      detail: "Delivery must be certified",
      icon: "arrow-up-right",
    },
  ];

  return (
    <div className="reviews-trust-path">
      <p className="visually-hidden">
        Review trust path: intake, evidence inspection, explicit human decision,
        then a storefront-delivery gate that still requires certification.
      </p>
      <div className="reviews-trust-path-head" aria-hidden="true">
        <span>Trust path</span>
        <span>
          <i />
          Human decision
        </span>
      </div>
      <ol aria-hidden="true">
        {stages.map((stage, index) => (
          <li key={stage.title}>
            <span className="reviews-trust-step-index">
              {String(index + 1).padStart(2, "0")}
            </span>
            <span className="reviews-trust-step-icon">
              <Icon name={stage.icon} size={17} />
            </span>
            <span>
              <strong>{stage.title}</strong>
              <small>{stage.detail}</small>
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

export function Reviews(): ReactElement {
  const canAdmin = useCanAdmin();
  const [tab, setTab] = useDesktopRouteTab<TabId>(
    "reviews",
    TABS.map((item) => item.id),
    "moderation",
  );
  const tabs = useTabsInteraction({
    activation: "manual",
    value: tab,
    items: TABS.map((item) => ({ value: item.id })),
    onChange: setTab,
  });
  const catalogResource = useRemoteResource(
    async () => {
      const response = await reviewsApi.catalog();
      if (response.error) return { error: response.error };
      const parsed = parseReviewsCatalog(response.data);
      if (!parsed.catalog) {
        return {
          error: {
            message: "The review catalog response was malformed.",
            kind: "parse" as const,
          },
        };
      }
      return { data: parsed };
    },
    { identity: "reviews:catalog" },
  );
  const activeTab = TABS.find((item) => item.id === tab) ?? TABS[0];
  const catalog = catalogResource.data?.catalog ?? null;
  const catalogUnavailable =
    catalogResource.transport === "error" && catalog === null;

  return (
    <div className="page reviews-page">
      <section className="reviews-hero" aria-labelledby="reviews-title">
        <div className="reviews-hero-copy">
          <div className="reviews-hero-kicker">
            <span className="reviews-hero-mark" aria-hidden="true">
              <Icon name="shield-check" size={17} />
            </span>
            <span>Customer proof</span>
            <i aria-hidden="true" />
            <span className="reviews-readiness">Mixed readiness</span>
          </div>

          <h1 id="reviews-title">
            Turn customer proof into trustworthy storefront confidence.
          </h1>
          <p>
            Review the exact evidence, make an explicit publication decision,
            and keep inactive widget inventory separate from reported deployment
            material.
          </p>

          <div
            className="reviews-hero-facts"
            aria-label="Reviews operating facts"
          >
            <span>
              <strong>Immediate</strong>
              <small>approval publishes</small>
            </span>
            <span>
              <strong>Immediate</strong>
              <small>public replies publish</small>
            </span>
            <span>
              <strong>200</strong>
              <small>maximum loaded reviews</small>
            </span>
            <span>
              <strong>Active only</strong>
              <small>deployment review</small>
            </span>
          </div>

          <div className="reviews-hero-actions">
            <button
              type="button"
              className="reviews-manage-sources"
              onClick={() => navigateDesktopRoute({ section: "integrations" })}
            >
              <Icon name="git-branch" size={16} />
              Manage review sources
            </button>
            <span>
              <Icon name={canAdmin ? "key" : "eye"} size={14} />
              {canAdmin
                ? "Administrator decision authority"
                : "Read-only evidence access"}
            </span>
          </div>
        </div>

        <TrustPath />
      </section>

      <div className="reviews-boundary-strip">
        <span>
          <Icon name="lock" size={15} />
          Reviewer contact details are never rendered in this workspace.
        </span>
        <span>
          <Icon name="alert-triangle" size={15} />
          Provider health is owned by Integrations and is not inferred here.
        </span>
      </div>

      {catalogResource.stale && catalogResource.failure ? (
        <Notice
          tone="warning"
          title="Using the last verified review catalog"
          className="reviews-route-notice"
          action={
            <button
              type="button"
              className="reviews-notice-action"
              onClick={() => void catalogResource.reload()}
            >
              Retry
            </button>
          }
        >
          {catalogResource.failure.message} Existing server-defined labels are
          retained and clearly timestamped by each workspace.
        </Notice>
      ) : catalogUnavailable ? (
        <Notice
          tone="warning"
          title="The review catalog could not be verified"
          className="reviews-route-notice"
          action={
            <button
              type="button"
              className="reviews-notice-action"
              onClick={() => void catalogResource.reload()}
            >
              Retry catalog
            </button>
          }
        >
          {catalogResource.failure?.message ??
            "Server-defined review and widget labels are temporarily unavailable."}
          The moderation inbox remains explicitly scoped to Pending.
        </Notice>
      ) : catalogResource.data && catalogResource.data.invalidCount > 0 ? (
        <Notice
          tone="warning"
          title="Some catalog labels were withheld"
          className="reviews-route-notice"
        >
          {catalogResource.data.invalidCount} malformed or duplicate catalog{" "}
          {catalogResource.data.invalidCount === 1
            ? "entry was"
            : "entries were"}{" "}
          excluded from the controls below.
        </Notice>
      ) : null}

      <div
        ref={tabs.listRef}
        className="reviews-tabs"
        {...tabs.listProps}
        aria-label="Reviews workspaces"
      >
        {TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            {...tabs.getTabProps(item.id)}
            className={tab === item.id ? "is-active" : ""}
          >
            <span className="reviews-tab-icon" aria-hidden="true">
              <Icon name={item.icon} size={18} />
            </span>
            <span>
              <small>{item.eyebrow}</small>
              <strong>{item.label}</strong>
              <em>{item.description}</em>
            </span>
            <Icon name="chevron-right" size={16} />
          </button>
        ))}
      </div>

      {TABS.map((item) => (
        <section
          key={item.id}
          {...tabs.getPanelProps(item.id)}
          className="reviews-tab-panel"
          data-reviews-panel={item.id}
        >
          {tab !== item.id ? null : item.id === "moderation" ? (
            <ModerationTab
              statuses={catalog?.statuses ?? null}
              catalogUnavailable={catalogUnavailable}
              canAdmin={canAdmin}
            />
          ) : (
            <WidgetsTab
              widgetTypes={catalog?.widget_types ?? null}
              catalogUnavailable={catalogUnavailable}
              canAdmin={canAdmin}
            />
          )}
        </section>
      ))}

      <p className="visually-hidden" aria-live="polite">
        {activeTab.label} selected. {activeTab.description}
      </p>
    </div>
  );
}
