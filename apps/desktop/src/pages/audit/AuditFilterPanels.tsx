import type { ReactElement } from "react";

import { AuditFilters } from "../../components/audit/AuditFilters";
import { SavedViewsBar } from "../../components/audit/SavedViewsBar";
import type { AuditPageController } from "./useAuditPageController";

export function AuditFilterPanels({
  controller,
}: {
  controller: AuditPageController;
}): ReactElement {
  const { data, filters } = controller;
  return (
    <section
      className="audit-filter-panel"
      aria-labelledby="audit-filter-panel-title"
    >
      <div className="audit-filter-heading">
        <div>
          <span className="audit-section-kicker">Query builder</span>
          <h2
            ref={controller.filterFocusRef}
            id="audit-filter-panel-title"
            tabIndex={-1}
          >
            Refine evidence
          </h2>
        </div>
        <p>
          Narrow the server result window with actor, resource, action, and UTC
          date filters. Filters are combined; a typed action takes precedence
          over an action-category shortcut.
        </p>
      </div>
      <div className="audit-saved-view-row">
        <span className="audit-saved-view-label">Saved query</span>
        <SavedViewsBar
          canManage={controller.canManageSavedViews}
          currentFilters={{
            actorType: filters.actorType,
            actorLabel: filters.actorLabel,
            actionQuery: filters.actionQuery,
            resourceType: filters.resourceType,
            resourceId: filters.resourceId,
            days: filters.days,
            category: filters.category,
          }}
          onLoad={filters.applySavedView}
        />
      </div>
      <AuditFilters
        actorType={filters.actorType}
        actorLabel={filters.actorLabel}
        actionQuery={filters.actionQuery}
        resourceType={filters.resourceType}
        resourceId={filters.resourceId}
        days={filters.days}
        category={filters.category}
        onActorTypeChange={filters.setActorType}
        onActorLabelChange={filters.setActorLabel}
        onActionQueryChange={filters.setActionQuery}
        onResourceTypeChange={filters.setResourceType}
        onResourceIdChange={filters.setResourceId}
        onDaysChange={filters.setDays}
        onCategoryChange={filters.setCategory}
      />
      {data.phase === "stale-error" ? (
        <div className="notice audit-filter-error" role="alert">
          <span>
            Audit evidence couldn&apos;t be refreshed. The last verified rows
            remain available.
          </span>
          <button
            type="button"
            className="btn btn-xs"
            disabled={data.loading || data.refreshing}
            onClick={() => void data.load()}
          >
            Retry evidence
          </button>
        </div>
      ) : null}
      {!data.error && data.statsError ? (
        <div className="audit-partial-note" role="status">
          Event rows are available, but the optional summary statistics could
          not be verified for this snapshot.
        </div>
      ) : null}
    </section>
  );
}
