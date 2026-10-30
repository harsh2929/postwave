import { type ReactElement, useRef } from "react";

import { HeroEmptyState } from "../../components/HeroEmptyState";
import { AuditRowItem } from "../../components/audit/AuditRowItem";
import { DataTableLoadMore } from "../../components/table/DataTable";
import { HERO } from "../../lib/heroAssets";
import type { AuditPageController } from "./useAuditPageController";

function AuditListLoading(): ReactElement {
  return (
    <div style={{ padding: 4 }}>
      {[0, 1, 2, 3, 4, 5].map((index) => (
        <div
          key={index}
          className="skel-row"
          style={{ gridTemplateColumns: "180px 1.4fr 1.4fr 1.4fr 140px" }}
        >
          <div className="skel skel-cell sm" />
          <div className="skel skel-cell" />
          <div className="skel skel-cell" />
          <div className="skel skel-cell" />
          <div className="skel skel-cell sm" />
        </div>
      ))}
    </div>
  );
}

function AuditListEmpty({ hasFilters }: { hasFilters: boolean }): ReactElement {
  if (hasFilters) {
    return (
      <div className="list-empty">
        <div className="empty-state">
          <div className="empty-state-icon">·</div>
          <h3>No matching events</h3>
          <p>
            Try widening the date range or clearing one of the filters above.
          </p>
        </div>
      </div>
    );
  }
  return (
    <HeroEmptyState
      tone="blue"
      eyebrow="Audit"
      title="Every action, on the record."
      subtitle="Search by actor, resource, or exact action substring, then inspect each event without leaving the evidence trail."
      imageSrc={HERO.audit}
      imageAlt="A clipboard with a single checkmark"
    />
  );
}

export function AuditListView({
  controller,
}: {
  controller: AuditPageController;
}): ReactElement {
  const { data, filters } = controller;
  const listScrollRef = useRef<HTMLDivElement | null>(null);
  const rows = data.rows;
  const visibleRows = data.visibleRows ?? rows ?? [];
  const hasRows = !data.loading && Boolean(rows) && visibleRows.length > 0;
  const hasFilters = Boolean(
    filters.actionQuery ||
    filters.resourceId ||
    filters.actorLabel ||
    filters.actorType !== "any" ||
    filters.resourceType ||
    filters.category !== "all",
  );
  const renderRow = (row: (typeof visibleRows)[number]): ReactElement => (
    <AuditRowItem
      key={String(row.id)}
      row={row}
      onClick={(opener) => controller.setSelected(row, opener)}
      onFilterActor={controller.filterToActor}
      onFilterResourceId={controller.filterToResource}
    />
  );
  return (
    <>
      <div
        className="list audit-list"
        ref={listScrollRef}
        role={hasRows ? "table" : "region"}
        aria-label={hasRows ? "Audit events" : "Audit events status"}
        aria-busy={data.loading || data.refreshing || undefined}
        aria-rowcount={hasRows ? visibleRows.length + 1 : undefined}
        style={{
          position: "relative",
          overflowY: "auto",
          maxHeight: "70vh",
        }}
      >
        {hasRows ? (
          <>
            <div className="list-header audit-list-header" role="row">
              <div role="columnheader">Time</div>
              <div role="columnheader">Action</div>
              <div role="columnheader">Resource</div>
              <div role="columnheader">Actor</div>
              <div role="columnheader">IP</div>
            </div>
            {visibleRows.map(renderRow)}
          </>
        ) : data.loading ? (
          <AuditListLoading />
        ) : (
          <AuditListEmpty hasFilters={hasFilters} />
        )}
      </div>
      {rows ? (
        <div data-testid="audit-pagination">
          {data.paginationError ? (
            <div className="audit-pagination-error" role="alert">
              <span>{data.paginationError}</span>
              <button
                type="button"
                className="btn btn-xs"
                disabled={data.loadingMore}
                onClick={() => void data.onLoadMore()}
              >
                Retry page
              </button>
            </div>
          ) : null}
          <DataTableLoadMore
            label="Audit log"
            loadedCount={rows.length}
            totalCount={data.totalCount}
            totalIsApproximate={data.totalConfidence === "approximate"}
            hasMore={Boolean(data.nextCursor)}
            busy={data.loadingMore}
            onLoadMore={() => void data.onLoadMore()}
            endLabel={rows.length > 0 ? "End of log" : ""}
          />
        </div>
      ) : null}
    </>
  );
}
