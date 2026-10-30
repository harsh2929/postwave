import { type ReactElement, useMemo, useState } from "react";

import { useRemoteResource } from "../../hooks/useRemoteResource";
import { reviewsApi } from "../../lib/api-client";
import {
  parseWidgetList,
  widgetStatusLabel,
  widgetTypeLabel,
} from "../../lib/reviews-helpers";
import { Icon } from "../Icon";
import { Notice } from "../Notice";
import { WidgetCard } from "./WidgetCard";

const ALL_WIDGETS = "__all__";

interface Props {
  widgetTypes: string[] | null;
  catalogUnavailable?: boolean;
  canAdmin: boolean;
}

function normalizedQuery(value: string): string {
  return value.trim().toLocaleLowerCase();
}

export function WidgetsTab({
  widgetTypes,
  catalogUnavailable = false,
  canAdmin,
}: Props): ReactElement {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState(ALL_WIDGETS);
  const resource = useRemoteResource(
    async () => {
      const response = await reviewsApi.listWidgets();
      if (response.error) return { error: response.error };
      const parsed = parseWidgetList(response.data);
      if (!parsed.envelopeValid) {
        return {
          error: {
            message: "The widget list response was malformed.",
            kind: "parse" as const,
          },
        };
      }
      return { data: parsed };
    },
    { identity: "reviews:widgets" },
  );

  const snapshot = resource.data;
  const lifecycleStates = useMemo(() => {
    const known = ["active", "draft", "paused", "archived"];
    const observed = (snapshot?.items ?? []).map((widget) => widget.status);
    return [...new Set([...known, ...observed])];
  }, [snapshot]);
  const counts = useMemo(() => {
    const next: Record<string, number> = {};
    for (const widget of snapshot?.items ?? []) {
      next[widget.status] = (next[widget.status] ?? 0) + 1;
    }
    return next;
  }, [snapshot]);
  const visibleWidgets = useMemo(() => {
    const needle = normalizedQuery(query);
    return (snapshot?.items ?? [])
      .filter((widget) => status === ALL_WIDGETS || widget.status === status)
      .filter((widget) => {
        if (!needle) return true;
        return [
          widget.name,
          widget.widget_type,
          widget.language,
          widget.slug,
        ].some((value) => value?.toLocaleLowerCase().includes(needle));
      })
      .sort((left, right) => {
        const stateOrder = ["active", "draft", "paused", "archived"];
        const statusDelta =
          stateOrder.indexOf(left.status) - stateOrder.indexOf(right.status);
        if (statusDelta !== 0) return statusDelta;
        return left.name.localeCompare(right.name);
      });
  }, [query, snapshot, status]);

  const terminalFailure =
    resource.data === null && resource.transport === "error";
  const initialLoading =
    resource.data === null && resource.transport === "loading";
  const refreshing = resource.data !== null && resource.transport === "loading";

  return (
    <div className="reviews-workspace" data-reviews-view="widgets">
      <header className="reviews-section-header">
        <div>
          <span className="reviews-section-eyebrow">Storefront inventory</span>
          <h2>Review widgets</h2>
          <p>
            Inspect lifecycle state and review installation material without
            implying that a draft is publicly available.
          </p>
        </div>
        <div
          className="reviews-widget-summary"
          aria-label="Loaded widget states"
        >
          <span>
            <strong>{counts.active ?? 0}</strong>
            <small>Active</small>
          </span>
          <span>
            <strong>{counts.draft ?? 0}</strong>
            <small>Draft</small>
          </span>
          <span>
            <strong>{counts.paused ?? 0}</strong>
            <small>Paused</small>
          </span>
        </div>
      </header>

      <Notice
        tone="warning"
        title="Widget authoring is review-gated"
        className="reviews-notice reviews-widget-gate"
      >
        The current API accepts a one-shot widget in any lifecycle state,
        including active, but provides no later edit or transition command.
        Authoring is withheld here to prevent immediate, unreviewed publication
        and unrecoverable lifecycle states. Existing inventory remains
        inspectable.
        {canAdmin
          ? " An administrator can monitor the inventory while the complete lifecycle is implemented."
          : " Your current role is read-only."}
      </Notice>

      {catalogUnavailable ? (
        <Notice
          tone="warning"
          title="Renderer catalog unavailable"
          className="reviews-notice"
        >
          Server-advertised widget types are not being inferred. Existing
          records retain their exact reported type labels.
        </Notice>
      ) : widgetTypes && widgetTypes.length > 0 ? (
        <p className="reviews-catalog-note">
          The server reports {widgetTypes.length} renderer{" "}
          {widgetTypes.length === 1 ? "label" : "labels"}. This directory does
          not claim that each label has distinct certified output.
        </p>
      ) : null}

      <div className="reviews-toolbar reviews-widget-toolbar">
        <label className="reviews-search">
          <span className="visually-hidden">Search loaded review widgets</span>
          <Icon name="chart-bars" size={16} />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search widget name, type, language, or slug"
            autoComplete="off"
          />
          {query ? (
            <button
              type="button"
              onClick={() => setQuery("")}
              aria-label="Clear widget search"
            >
              <Icon name="x" size={15} />
            </button>
          ) : null}
        </label>
        <button
          type="button"
          className="reviews-refresh"
          onClick={() => void resource.reload()}
          disabled={resource.transport === "loading"}
        >
          <Icon name="clock" size={16} />
          {refreshing ? "Verifying…" : "Refresh"}
        </button>
      </div>

      <div
        className="reviews-filter-rail"
        role="group"
        aria-label="Filter widgets by lifecycle state"
      >
        <button
          type="button"
          aria-pressed={status === ALL_WIDGETS}
          className={status === ALL_WIDGETS ? "is-active" : ""}
          onClick={() => setStatus(ALL_WIDGETS)}
        >
          All <span>{snapshot?.items.length ?? 0}</span>
        </button>
        {lifecycleStates.map((state) => (
          <button
            key={state}
            type="button"
            aria-pressed={status === state}
            className={status === state ? "is-active" : ""}
            onClick={() => setStatus(state)}
          >
            {widgetStatusLabel(state)} <span>{counts[state] ?? 0}</span>
          </button>
        ))}
      </div>

      {resource.stale && resource.failure ? (
        <Notice
          tone="warning"
          title="Showing the last verified widget inventory"
          className="reviews-notice"
          action={
            <button
              type="button"
              className="reviews-notice-action"
              onClick={() => void resource.reload()}
            >
              Retry
            </button>
          }
        >
          {resource.failure.message} Lifecycle state and deployment controls
          remain tied to the retained snapshot.
        </Notice>
      ) : null}

      {snapshot && snapshot.invalidCount > 0 ? (
        <Notice
          tone="warning"
          title={`${snapshot.invalidCount} malformed widget ${
            snapshot.invalidCount === 1 ? "record was" : "records were"
          } withheld`}
          className="reviews-notice"
        >
          Only widgets with stable identity, name, type, and lifecycle state are
          shown.
        </Notice>
      ) : null}

      <section
        className="reviews-widget-results"
        aria-label="Review widget directory"
        aria-busy={resource.transport === "loading"}
      >
        {terminalFailure ? (
          <div className="reviews-terminal-state">
            <span className="reviews-state-icon" aria-hidden="true">
              <Icon name="alert-triangle" size={22} />
            </span>
            <h3>The widget inventory could not be verified</h3>
            <p>
              {resource.failure?.message ??
                "The service did not return a usable widget list."}
            </p>
            <button type="button" onClick={() => void resource.reload()}>
              Try again
            </button>
          </div>
        ) : initialLoading ? (
          <div className="reviews-widget-grid" aria-label="Loading widgets">
            {Array.from({ length: 3 }, (_, index) => (
              <div className="reviews-widget-skeleton" key={index}>
                <span />
                <span />
                <span />
              </div>
            ))}
          </div>
        ) : (snapshot?.items.length ?? 0) === 0 ? (
          <div className="reviews-empty-state">
            <span className="reviews-state-icon" aria-hidden="true">
              <Icon name="chart-bars" size={22} />
            </span>
            <h3>No widget records were returned</h3>
            <p>
              Creation remains withheld until the service exposes a complete,
              reversible lifecycle.
            </p>
          </div>
        ) : visibleWidgets.length === 0 ? (
          <div className="reviews-empty-state">
            <span className="reviews-state-icon" aria-hidden="true">
              <Icon name="users" size={22} />
            </span>
            <h3>No widgets match this view</h3>
            <p>
              Clear the search or choose another lifecycle state to inspect the
              loaded inventory.
            </p>
            <button
              type="button"
              onClick={() => {
                setQuery("");
                setStatus(ALL_WIDGETS);
              }}
            >
              Reset view
            </button>
          </div>
        ) : (
          <div className="reviews-widget-grid">
            {visibleWidgets.map((widget) => (
              <WidgetCard key={widget.id} widget={widget} />
            ))}
          </div>
        )}
      </section>

      <p className="visually-hidden" role="status" aria-live="polite">
        {visibleWidgets.length}{" "}
        {visibleWidgets.length === 1 ? "widget" : "widgets"} shown.{" "}
        {status === ALL_WIDGETS
          ? "All loaded lifecycle states."
          : `${widgetStatusLabel(status)} lifecycle state.`}
      </p>

      <div
        className="reviews-widget-truth-table"
        aria-label="Widget lifecycle truth"
      >
        <h3>Lifecycle truth</h3>
        <dl>
          <div>
            <dt>Active</dt>
            <dd>
              Reported endpoint and installation material may be inspectable;
              working storefront delivery is not certified.
            </dd>
          </div>
          <div>
            <dt>Draft</dt>
            <dd>Not public. Deployment controls are intentionally withheld.</dd>
          </div>
          <div>
            <dt>Paused or archived</dt>
            <dd>Not treated as storefront-ready by this desktop surface.</dd>
          </div>
          <div>
            <dt>Renderer type</dt>
            <dd>
              {widgetTypeLabel("product_reviews")} is a reported label, not a
              certification.
            </dd>
          </div>
        </dl>
      </div>
    </div>
  );
}
