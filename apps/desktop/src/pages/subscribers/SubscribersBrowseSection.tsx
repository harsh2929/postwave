import type { ReactElement } from "react";

import { Notice } from "../../components/Notice";
import {
  SubscribersBrowseToolbar,
  SubscribersTable,
} from "../../components/subscribers/SubscribersBrowsePanel";
import { SubscriberStatusConsentModal } from "../../components/subscribers/SubscriberStatusConsentModal";
import { subscriberKey } from "./subscribers-page-utils";
import type { SubscribersPageController } from "./useSubscribersPageController";

export function SubscribersBrowseSection({
  controller,
}: {
  controller: SubscribersPageController;
}): ReactElement {
  const { data, live, saved, selection, state, view } = controller;
  return (
    <div className="subscribers-directory-workspace">
      {data.stale && data.rows ? (
        <Notice
          tone="warning"
          announcement="polite"
          title="Showing last-confirmed subscribers"
          action={
            <button
              type="button"
              className="btn btn-sm"
              onClick={data.reload}
              disabled={data.refreshing}
            >
              {data.refreshing ? "Retrying…" : "Try again"}
            </button>
          }
          style={{ marginBottom: 10 }}
        >
          Refresh failed. The directory remains at its last confirmed state
          {data.lastConfirmedAt
            ? ` from ${data.lastConfirmedAt.toLocaleTimeString([], {
                hour: "2-digit",
                minute: "2-digit",
              })}`
            : ""}
          .
        </Notice>
      ) : null}
      {!data.stale && data.rows && live.status !== "live" ? (
        <Notice
          tone={live.status === "offline" ? "warning" : "info"}
          announcement="polite"
          title={
            live.status === "offline"
              ? "Live subscriber updates are paused"
              : live.status === "paused"
                ? "Live updates pause while Moosewave is in the background"
                : "Reconnecting subscriber updates"
          }
          style={{ marginBottom: 10 }}
        >
          {live.status === "offline"
            ? "The directory remains at its last confirmed state. Moosewave will verify this view once the connection is restored."
            : live.status === "paused"
              ? "The current view is retained without background reshuffling and will be verified when the window is active again."
              : "The current view is retained while the event stream reconnects; an authoritative refresh will follow automatically."}
        </Notice>
      ) : null}
      {controller.deepLinks.routeOpenError ? (
        <Notice
          tone="warning"
          announcement="polite"
          title="Subscriber details were not opened"
          action={
            <button
              type="button"
              className="btn btn-sm"
              onClick={controller.deepLinks.retryRouteOpen}
            >
              Retry
            </button>
          }
          style={{ marginBottom: 10 }}
        >
          {controller.deepLinks.routeOpenError}
        </Notice>
      ) : null}
      {view.preferencesError ? (
        <Notice
          tone="warning"
          announcement="polite"
          title="Column layout is not synced"
          action={
            <button
              type="button"
              className="btn btn-sm"
              onClick={view.retryPreferences}
              disabled={view.preferencesLoading}
            >
              {view.preferencesLoading ? "Retrying…" : "Try again"}
            </button>
          }
          style={{ marginBottom: 10 }}
        >
          {view.preferencesError} The current safe default layout remains
          available.
        </Notice>
      ) : null}
      <SubscribersBrowseToolbar
        searchRef={controller.keyboard.searchRef}
        query={state.query}
        onQueryChange={state.setQuery}
        filter={state.filter}
        matchTotal={data.matchTotal}
        onFilterChange={controller.changeFilter}
        showArchived={state.showArchived}
        onToggleArchived={controller.toggleArchived}
        savedSegments={saved.savedSegments}
        activeSavedSegmentId={saved.activeSavedSegmentId}
        savedSegmentsLoading={saved.savedSegmentsLoading}
        savedSegmentsError={saved.savedSegmentsError}
        savedSegmentsAtLimit={saved.saveCurrentAtLimit}
        savedSegmentsMax={saved.savedSegmentsMax}
        savedPreviews={saved.savedPreviews}
        savedDropdownOpen={saved.savedDropdownOpen}
        onToggleSavedDropdown={() =>
          saved.setSavedDropdownOpen((current) => !current)
        }
        onApplySavedSegment={(segment) => void saved.applySavedSegment(segment)}
        onRemoveSavedSegment={saved.setPendingSegmentDelete}
        onOpenSaveCurrent={saved.openSaveCurrent}
        onRetrySavedSegments={() => void saved.loadSavedSegments()}
        onRequestSavedPreview={saved.requestSavedPreview}
        canMutate={controller.canMutate}
        visibleColumnKeys={view.visibleColumnKeys}
        onVisibleColumnsChange={controller.updateVisibleColumns}
        loading={data.loading || data.refreshing}
        onReload={data.reload}
      />
      <SubscribersTable
        recentSearchScope={controller.recentSearchScope}
        rows={data.rows}
        setRows={data.setRows}
        selectedRows={selection.selectedRows}
        onClearSelection={() => state.setSelectedKeys(new Set())}
        onBulkDone={controller.completeBulkAction}
        onOpenDedupeReview={() => state.setDedupeOpen(true)}
        canMutate={controller.canMutate}
        canImport={controller.canAdmin}
        error={data.stale ? null : data.error}
        listRef={live.listRef}
        liveEligible={live.liveEligible}
        listScrolled={live.listScrolled}
        bufferedNew={live.bufferedNew}
        bufferOverflow={live.bufferOverflow}
        onFlushBufferedNew={live.flushBufferedNew}
        gridTemplateColumns={view.gridTemplateColumns}
        visibleColumnKeys={view.visibleColumnKeys}
        allPageSelected={selection.allPageSelected}
        onTogglePage={selection.togglePage}
        pageRows={data.pageRows}
        sortColumn={state.sortColumn}
        sortOrder={state.sortOrder}
        onToggleSort={controller.toggleSort}
        onReload={data.reload}
        loading={data.loading}
        query={state.query}
        filter={state.filter}
        showArchived={state.showArchived}
        onQueryChange={state.setQuery}
        onResetView={controller.resetView}
        onOpenImport={controller.openImport}
        onOpenCreate={controller.openCreate}
        selectedKeys={state.selectedKeys}
        focusedRowIndex={state.focusedRowIndex}
        onFocusedRowChange={state.setFocusedRowIndex}
        focusedRowKey={state.focusId}
        onFocusedRowKeyChange={state.setFocusId}
        subscriberKey={subscriberKey}
        onSelectRow={(subscriber, index, modifiers) => {
          state.setFocusedRowIndex(index);
          selection.selectRow(subscriber, modifiers);
        }}
        onRenameEmail={controller.mutations.renameEmailWithUndo}
        onStatusChange={controller.mutations.setRowStatus}
        onRemoveTag={controller.mutations.removeTagFromRow}
        onAddTag={controller.mutations.addTagToRow}
        onOpenSubscriber={controller.deepLinks.openSubscriber}
        pager={data.pager}
        onPreviousPage={() =>
          void state.requestViewChange((current) => ({
            ...current,
            page: Math.max(1, current.page - 1),
          }))
        }
        onNextPage={() =>
          void state.requestViewChange((current) => ({
            ...current,
            page: current.page + 1,
          }))
        }
      />
      <SubscriberStatusConsentModal
        target={controller.mutations.statusConsentTarget}
        defaultJurisdiction={
          controller.mutations.statusConsentTarget?.detected_jurisdiction ??
          controller.mutations.statusConsentTarget?.country
        }
        onClose={controller.mutations.closeStatusConsentReview}
        onEnabled={controller.mutations.applyEnabledSubscriber}
      />
    </div>
  );
}
