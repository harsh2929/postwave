import {
  type Dispatch,
  type ReactElement,
  type RefObject,
  type SetStateAction,
  useId,
} from "react";

import { HeroEmptyState } from "../HeroEmptyState";
import { Avatar } from "./Avatar";
import { BulkActionBar } from "./BulkActionBar";
import { ColumnPicker } from "./ColumnPicker";
import { FilteredNoMatchEmptyState } from "./FilteredNoMatchEmptyState";
import { InlineEmailEdit } from "./InlineEmailEdit";
import { AddTagButton, InlineTagChip } from "./InlineTagChip";
import { SubscriberCreateMutationRows } from "./SubscriberAddModal";
import { SubscribersNewBanner } from "./SubscribersNewBanner";
import { SubscribersSavedSegmentsMenu } from "./SubscribersSavedSegmentsMenu";
import type { SavedPreviewEntry } from "./saved-segment-preview-state";
import {
  type SubscriberUiStatus,
  UI_STATUS_LABELS,
  engineStatusToUi,
} from "./subscriber-status";
import { HERO } from "../../lib/heroAssets";
import { fmtDate } from "../../lib/format-date";
import type { SavedSegment, Subscriber } from "../../lib/api-client";
import type {
  PagerView,
  ServerSort,
  SortOrder,
} from "../../pages/subscribers-paging";
import {
  SUBSCRIBER_COLUMN_CATALOG,
  subscriberColumnDefinition,
} from "../../pages/subscribers-view-columns";

export type SubscriberFilter = "all" | SubscriberUiStatus;

export type { SavedPreviewEntry } from "./saved-segment-preview-state";

export const SUBSCRIBER_SORTABLE_COLUMNS: Record<
  string,
  ServerSort | "client"
> = {
  email: "email",
  status: "status",
  joined: "created_at",
  engagement: "engagement",
  rating: "rating",
  churn_score: "churn",
  first_name: "first_name",
  last_name: "last_name",
  full_name: "client",
  display_name: "client",
};

const FILTER_CHIPS: readonly SubscriberFilter[] = [
  "all",
  "subscribed",
  "unsubscribed",
  "disabled",
  "unconfirmed",
];

interface SubscribersBrowseToolbarProps {
  searchRef: RefObject<HTMLInputElement | null>;
  query: string;
  onQueryChange: (query: string) => void;
  filter: SubscriberFilter;
  matchTotal: number | null;
  onFilterChange: (filter: SubscriberFilter) => void;
  showArchived: boolean;
  onToggleArchived: () => void;
  savedSegments: SavedSegment[];
  activeSavedSegmentId?: string | null;
  savedSegmentsLoading?: boolean;
  savedSegmentsError?: string | null;
  savedSegmentsAtLimit?: boolean;
  savedSegmentsMax?: number;
  savedPreviews: Record<string, SavedPreviewEntry>;
  savedDropdownOpen: boolean;
  onToggleSavedDropdown: () => void;
  onApplySavedSegment: (segment: SavedSegment) => void;
  onRemoveSavedSegment: (segment: SavedSegment) => void;
  onOpenSaveCurrent: () => void;
  onRetrySavedSegments?: () => void;
  onRequestSavedPreview?: (segmentId: string, force?: boolean) => void;
  canMutate: boolean;
  visibleColumnKeys: readonly string[];
  onVisibleColumnsChange: (columns: string[]) => void;
  loading: boolean;
  onReload: () => void;
}

export function SubscribersBrowseToolbar({
  searchRef,
  query,
  onQueryChange,
  filter,
  matchTotal,
  onFilterChange,
  showArchived,
  onToggleArchived,
  savedSegments,
  activeSavedSegmentId = null,
  savedSegmentsLoading = false,
  savedSegmentsError = null,
  savedSegmentsAtLimit = false,
  savedSegmentsMax = 200,
  savedPreviews,
  savedDropdownOpen,
  onToggleSavedDropdown,
  onApplySavedSegment,
  onRemoveSavedSegment,
  onOpenSaveCurrent,
  onRetrySavedSegments,
  onRequestSavedPreview = () => undefined,
  canMutate,
  visibleColumnKeys,
  onVisibleColumnsChange,
  loading,
  onReload,
}: SubscribersBrowseToolbarProps): ReactElement {
  const archivedGuidanceId = useId();
  return (
    <div
      className="subscribers-directory-toolbar"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        marginBottom: 12,
        flexWrap: "wrap",
      }}
    >
      <input
        ref={searchRef}
        type="search"
        className="input"
        style={{ width: 280, maxWidth: "100%" }}
        aria-label="Search subscribers by email or name"
        placeholder="Search email or name…"
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
        maxLength={256}
        autoComplete="off"
        spellCheck={false}
      />
      <div className="chips" style={{ flexWrap: "wrap" }}>
        {FILTER_CHIPS.map((candidate) => {
          const count =
            filter === candidate && matchTotal != null ? matchTotal : undefined;
          return (
            <button
              key={candidate}
              type="button"
              className={`chip${filter === candidate ? " is-active" : ""}`}
              aria-pressed={filter === candidate}
              onClick={() => onFilterChange(candidate)}
            >
              {filterLabel(candidate, count)}
            </button>
          );
        })}
        <button
          type="button"
          className={`chip${showArchived ? " is-active" : ""}`}
          aria-pressed={showArchived}
          aria-describedby={archivedGuidanceId}
          onClick={onToggleArchived}
        >
          Show archived
        </button>
      </div>
      <span
        id={archivedGuidanceId}
        className="muted"
        style={{ flexBasis: "100%", fontSize: 11 }}
      >
        Archived subscribers are hidden by default. Bounce states are managed in
        Suppressions, not subscriber status.
      </span>
      <SubscribersSavedSegmentsMenu
        segments={savedSegments}
        activeSegmentId={activeSavedSegmentId}
        loading={savedSegmentsLoading}
        error={savedSegmentsError}
        previews={savedPreviews}
        open={savedDropdownOpen}
        atLimit={savedSegmentsAtLimit}
        maxItems={savedSegmentsMax}
        onToggle={onToggleSavedDropdown}
        onApply={onApplySavedSegment}
        onRemove={onRemoveSavedSegment}
        onOpenSaveCurrent={onOpenSaveCurrent}
        onRetry={onRetrySavedSegments}
        onRequestPreview={onRequestSavedPreview}
        canMutate={canMutate}
      />
      <span className="spacer" />
      <ColumnPicker
        catalog={SUBSCRIBER_COLUMN_CATALOG}
        visible={[...visibleColumnKeys]}
        onChange={onVisibleColumnsChange}
      />
      <button
        type="button"
        className="btn"
        disabled={loading}
        onClick={onReload}
      >
        {loading ? "Refreshing…" : "Refresh"}
      </button>
    </div>
  );
}

function filterLabel(filter: SubscriberFilter, count?: number): string {
  const label = filter === "all" ? "All" : UI_STATUS_LABELS[filter];
  return count == null ? label : `${label} (${count.toLocaleString()})`;
}
interface SubscribersTableProps {
  recentSearchScope: string | null;
  rows: Subscriber[] | null;
  setRows: Dispatch<SetStateAction<Subscriber[] | null>>;
  selectedRows: Subscriber[];
  onClearSelection: () => void;
  onBulkDone: (skipReload?: boolean) => void;
  onOpenDedupeReview: () => void;
  canMutate: boolean;
  canImport: boolean;
  error: string | null;
  listRef: RefObject<HTMLDivElement | null>;
  liveEligible: boolean;
  listScrolled: boolean;
  bufferedNew: Subscriber[];
  bufferOverflow?: boolean;
  onFlushBufferedNew: () => void;
  gridTemplateColumns: string;
  visibleColumnKeys: readonly string[];
  allPageSelected: boolean;
  onTogglePage: () => void;
  pageRows: Subscriber[];
  sortColumn: string;
  sortOrder: SortOrder;
  onToggleSort: (column: string) => void;
  onReload: () => void;
  loading: boolean;
  query: string;
  filter: SubscriberFilter;
  showArchived: boolean;
  onQueryChange: (query: string) => void;
  onResetView: () => void;
  onOpenImport: () => void;
  onOpenCreate: () => void;
  selectedKeys: ReadonlySet<string>;
  focusedRowIndex: number;
  onFocusedRowChange: (index: number) => void;
  focusedRowKey?: string | null;
  onFocusedRowKeyChange?: (key: string | null) => void;
  subscriberKey: (subscriber: Subscriber) => string;
  onSelectRow: (
    subscriber: Subscriber,
    index: number,
    modifiers: { meta?: boolean; ctrl?: boolean; shift?: boolean },
  ) => void;
  onRenameEmail: (subscriber: Subscriber, email: string) => void;
  onStatusChange: (subscriber: Subscriber, status: string) => void;
  onRemoveTag: (subscriber: Subscriber, tag: string) => void;
  onAddTag: (subscriber: Subscriber, tag: string) => void;
  onOpenSubscriber: (subscriber: Subscriber) => void;
  pager: PagerView;
  onPreviousPage: () => void;
  onNextPage: () => void;
  statusGuidanceId?: string;
  statusWriteGuidanceId?: string;
  paginationStatusId?: string;
  selectionUnavailableId?: string;
}

export function SubscribersTable(props: SubscribersTableProps): ReactElement {
  const statusGuidanceId = useId();
  const statusWriteGuidanceId = useId();
  const paginationStatusId = useId();
  const selectionUnavailableId = useId();
  const gridInstructionsId = useId();
  const tableProps = {
    ...props,
    statusGuidanceId,
    statusWriteGuidanceId,
    paginationStatusId,
    selectionUnavailableId,
  };
  return (
    <>
      <BulkActionBar
        selected={tableProps.selectedRows}
        onClear={props.onClearSelection}
        rows={props.rows ?? []}
        setRows={props.setRows}
        onDone={props.onBulkDone}
        onOpenDedupeReview={props.onOpenDedupeReview}
        canMutate={props.canMutate}
      />
      {props.error ? (
        <div className="notice">
          <span>Couldn&apos;t load subscribers: {props.error}</span>
        </div>
      ) : null}
      {props.visibleColumnKeys.includes("status") ? (
        <div
          id={statusGuidanceId}
          className="muted"
          style={{ fontSize: 11, marginBottom: 6 }}
        >
          Subscriber status does not include bounces. Review and manage bounce
          states in Suppressions. Choosing Subscribed opens an evidence review;
          it never enables a profile directly.
        </div>
      ) : null}
      {!props.canMutate ? (
        <div
          id={statusWriteGuidanceId}
          className="muted"
          role="status"
          style={{ fontSize: 11, marginBottom: 6 }}
        >
          Viewer access is read-only; subscriber status changes are unavailable.
        </div>
      ) : null}
      {props.pageRows.length === 0 ? (
        <div
          id={selectionUnavailableId}
          className="muted"
          role="status"
          style={{ fontSize: 11, marginBottom: 6 }}
        >
          No subscribers on this page are available to select.
        </div>
      ) : null}
      <div className="list" data-tour="subscribers-list" ref={props.listRef}>
        <NewSubscribersBanner {...tableProps} />
        <span id={gridInstructionsId} className="visually-hidden">
          Use the arrow keys to move between subscribers, Enter to open a
          profile, and Space to select or clear the focused subscriber.
        </span>
        <div
          style={{
            overflowX: "auto",
            overscrollBehaviorX: "contain",
          }}
        >
          <div style={{ minWidth: 720 }}>
            <div
              role="grid"
              aria-label="Subscribers directory"
              aria-describedby={gridInstructionsId}
              aria-busy={props.loading || undefined}
              aria-rowcount={props.pageRows.length + 1}
              aria-colcount={props.visibleColumnKeys.length + 2}
            >
              <SubscribersTableHeader {...tableProps} />
              <SubscribersTableBody {...tableProps} />
            </div>
            <SubscriberCreateMutationRows
              visibleColumnKeys={props.visibleColumnKeys}
              gridTemplateColumns={props.gridTemplateColumns}
              onReload={props.onReload}
            />
          </div>
        </div>
      </div>
      <div className="pagination">
        <button
          type="button"
          className="btn btn-sm"
          aria-disabled={props.loading || !props.pager.hasPrev || undefined}
          aria-describedby={paginationStatusId}
          aria-label="Previous page"
          onClick={() => {
            if (!props.loading && props.pager.hasPrev) props.onPreviousPage();
          }}
        >
          Prev
        </button>
        <span
          id={paginationStatusId}
          role={props.loading ? "status" : undefined}
        >
          {props.pager.label}
          {props.loading ? " · Loading subscribers…" : ""}
        </span>
        <button
          type="button"
          className="btn btn-sm"
          aria-disabled={props.loading || !props.pager.hasNext || undefined}
          aria-describedby={paginationStatusId}
          aria-label="Next page"
          onClick={() => {
            if (!props.loading && props.pager.hasNext) props.onNextPage();
          }}
        >
          Next
        </button>
      </div>
    </>
  );
}

function NewSubscribersBanner(
  props: SubscribersTableProps,
): ReactElement | null {
  if (
    !props.liveEligible ||
    !props.listScrolled ||
    props.bufferedNew.length === 0
  ) {
    return null;
  }
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "center",
        position: "sticky",
        top: 8,
        zIndex: 10,
        pointerEvents: "none",
      }}
    >
      <div style={{ pointerEvents: "auto" }}>
        <SubscribersNewBanner
          count={props.bufferedNew.length}
          atLeast={props.bufferOverflow}
          onClick={props.onFlushBufferedNew}
        />
      </div>
    </div>
  );
}

function SubscribersTableHeader(props: SubscribersTableProps): ReactElement {
  return (
    <div
      className="list-header"
      role="row"
      aria-rowindex={1}
      style={{ gridTemplateColumns: props.gridTemplateColumns }}
    >
      <div role="columnheader" aria-label="Select subscribers">
        <input
          type="checkbox"
          checked={props.allPageSelected}
          onChange={() => {
            if (props.pageRows.length > 0) props.onTogglePage();
          }}
          style={{ accentColor: "var(--pw-accent)" }}
          aria-label={
            props.allPageSelected
              ? "Clear selection on this page"
              : "Select all on this page"
          }
          aria-disabled={props.pageRows.length === 0 || undefined}
          aria-describedby={
            props.pageRows.length === 0
              ? props.selectionUnavailableId
              : undefined
          }
        />
      </div>
      {props.visibleColumnKeys.map((key) => {
        const column = subscriberColumnDefinition(key);
        const label = column?.label ?? key;
        if (key === "avatar") {
          return (
            <div
              key={key}
              role="columnheader"
              aria-label={label}
              className="subscribers-avatar-column-header"
            >
              <span
                className="subscribers-avatar-column-marker"
                aria-hidden="true"
              />
            </div>
          );
        }
        const mapped = SUBSCRIBER_SORTABLE_COLUMNS[key];
        if (!mapped) {
          return (
            <div
              key={key}
              role="columnheader"
              className={column?.numeric ? "col-num" : undefined}
            >
              {label}
            </div>
          );
        }
        const active = props.sortColumn === key;
        const clientScoped = mapped === "client";
        return (
          <div
            key={key}
            role="columnheader"
            aria-sort={
              active
                ? props.sortOrder === "asc"
                  ? "ascending"
                  : "descending"
                : "none"
            }
            className={column?.numeric ? "col-num" : undefined}
          >
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              style={{
                padding: "0 2px",
                font: "inherit",
                color: "inherit",
                fontWeight: active ? 600 : undefined,
              }}
              onClick={() => props.onToggleSort(key)}
              aria-label={`Sort by ${label}${
                active
                  ? props.sortOrder === "asc"
                    ? ", ascending"
                    : ", descending"
                  : ""
              }`}
            >
              {label}
              {active ? (props.sortOrder === "asc" ? " ↑" : " ↓") : ""}
              {clientScoped ? (
                <span className="muted" style={{ fontSize: 10 }}>
                  {" "}
                  · this page
                </span>
              ) : null}
            </button>
          </div>
        );
      })}
      <div role="columnheader" aria-label="Profile actions" />
    </div>
  );
}

function SubscribersTableBody(props: SubscribersTableProps): ReactElement {
  if (props.loading) {
    return (
      <div role="row" aria-rowindex={2}>
        <div
          role="gridcell"
          aria-colspan={props.visibleColumnKeys.length + 2}
          style={{ padding: 12 }}
        >
          {[0, 1, 2, 3, 4, 5].map((index) => (
            <div key={index} className="skel-row" />
          ))}
        </div>
      </div>
    );
  }
  if (props.pageRows.length === 0) {
    if (props.query) {
      return (
        <div role="row" aria-rowindex={2}>
          <div
            role="gridcell"
            aria-colspan={props.visibleColumnKeys.length + 2}
          >
            <FilteredNoMatchEmptyState
              recentSearchScope={props.recentSearchScope}
              query={props.query}
              onApplyQuery={props.onQueryChange}
              onClear={() => props.onQueryChange("")}
            />
          </div>
        </div>
      );
    }
    if (props.filter !== "all" || props.showArchived) {
      const constraints = [
        props.filter !== "all"
          ? `Status: ${UI_STATUS_LABELS[props.filter]}`
          : null,
        props.showArchived ? "Archived contacts included" : null,
      ].filter(Boolean);
      return (
        <div role="row" aria-rowindex={2}>
          <div
            role="gridcell"
            aria-colspan={props.visibleColumnKeys.length + 2}
          >
            <div className="list-empty">
              <div className="empty-state">
                <div className="empty-state-icon" aria-hidden="true">
                  ·
                </div>
                <h3>No contacts match this view</h3>
                <p>
                  Active constraints: {constraints.join(" · ")}. Your workspace
                  may still contain contacts outside this view.
                </p>
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={props.onResetView}
                >
                  Reset view
                </button>
              </div>
            </div>
          </div>
        </div>
      );
    }
    return (
      <div role="row" aria-rowindex={2}>
        <div role="gridcell" aria-colspan={props.visibleColumnKeys.length + 2}>
          <HeroEmptyState
            tone="mint"
            eyebrow="Audience"
            title="Build the audience that owns your inbox."
            subtitle="Import a CSV, paste a list, or send subscribers in via API. Moosewave de-dupes, validates, and keeps your suppression list honest."
            primaryCta={
              props.canImport
                ? { label: "Import CSV", onClick: props.onOpenImport }
                : undefined
            }
            secondaryCta={
              props.canMutate
                ? { label: "Add subscriber", onClick: props.onOpenCreate }
                : undefined
            }
            imageSrc={HERO.subscribers}
            imageAlt="A phone showing a clean subscriber list"
          />
        </div>
      </div>
    );
  }
  return (
    <>
      {props.pageRows.map((subscriber, index) => (
        <SubscriberTableRow
          key={props.subscriberKey(subscriber) || index}
          subscriber={subscriber}
          index={index}
          props={props}
        />
      ))}
    </>
  );
}

function SubscriberTableRow({
  subscriber,
  index,
  props,
}: {
  subscriber: Subscriber;
  index: number;
  props: SubscribersTableProps;
}): ReactElement {
  const key = props.subscriberKey(subscriber);
  const selected = props.selectedKeys.has(key);
  const focused = index === props.focusedRowIndex;
  const isRovingTabStop = focused || (props.focusedRowIndex < 0 && index === 0);
  const moveFocus = (nextIndex: number): void => {
    const clamped = Math.max(0, Math.min(props.pageRows.length - 1, nextIndex));
    props.onFocusedRowChange(clamped);
    props.onFocusedRowKeyChange?.(
      props.pageRows[clamped]
        ? props.subscriberKey(props.pageRows[clamped])
        : null,
    );
    window.requestAnimationFrame(() => {
      const next = props.listRef.current?.querySelector<HTMLElement>(
        `[data-subscriber-row-index="${clamped}"]`,
      );
      next?.focus({ preventScroll: true });
      next?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
    });
  };
  return (
    <div
      className="list-row"
      role="row"
      aria-rowindex={index + 2}
      aria-selected={selected}
      aria-label={`Subscriber ${subscriber.email}`}
      data-subscriber-row-index={index}
      tabIndex={isRovingTabStop ? 0 : -1}
      onFocus={() => {
        props.onFocusedRowChange(index);
        props.onFocusedRowKeyChange?.(key);
      }}
      onClick={(event) => {
        const target = event.target;
        if (
          target instanceof Element &&
          target.closest("button, input, select, textarea, a, [role='button']")
        ) {
          return;
        }
        props.onOpenSubscriber(subscriber);
      }}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        switch (event.key) {
          case "ArrowDown":
            event.preventDefault();
            moveFocus(index + 1);
            break;
          case "ArrowUp":
            event.preventDefault();
            moveFocus(index - 1);
            break;
          case "Home":
            event.preventDefault();
            moveFocus(0);
            break;
          case "End":
            event.preventDefault();
            moveFocus(props.pageRows.length - 1);
            break;
          case "Enter":
            event.preventDefault();
            props.onOpenSubscriber(subscriber);
            break;
          case " ":
            event.preventDefault();
            props.onSelectRow(subscriber, index, {
              meta: event.metaKey,
              ctrl: event.ctrlKey,
              shift: event.shiftKey,
            });
            break;
          default:
            break;
        }
      }}
      style={{
        gridTemplateColumns: props.gridTemplateColumns,
        background: selected
          ? "color-mix(in srgb, var(--pw-accent) 8%, transparent)"
          : focused
            ? "color-mix(in srgb, var(--pw-accent) 4%, transparent)"
            : undefined,
        boxShadow: focused ? "inset 2px 0 0 0 var(--pw-accent)" : undefined,
      }}
    >
      <div role="gridcell">
        <input
          type="checkbox"
          checked={selected}
          onClick={(event) => {
            event.stopPropagation();
            event.preventDefault();
            props.onSelectRow(subscriber, index, {
              meta: event.metaKey,
              ctrl: event.ctrlKey,
              shift: event.shiftKey,
            });
          }}
          onChange={() => {
            // Selection is modifier-aware and handled in onClick.
          }}
          style={{ accentColor: "var(--pw-accent)" }}
          aria-label={`Select ${subscriber.email}`}
        />
      </div>
      {props.visibleColumnKeys.map((column) => (
        <div key={column} role="gridcell" style={{ minWidth: 0 }}>
          <SubscriberRowCell
            column={column}
            subscriber={subscriber}
            props={props}
          />
        </div>
      ))}
      <div role="gridcell" style={{ textAlign: "right" }}>
        <div className="list-row-actions">
          <button
            type="button"
            className="btn btn-sm btn-ghost list-row-action"
            aria-label={`Open ${subscriber.email}`}
            onClick={(event) => {
              event.stopPropagation();
              props.onOpenSubscriber(subscriber);
            }}
          >
            Open
          </button>
        </div>
      </div>
    </div>
  );
}

const IDENTITY_COLUMNS = new Set([
  "avatar",
  "email",
  "first_name",
  "last_name",
  "full_name",
  "display_name",
  "status",
]);

function SubscriberIdentityCell({
  column,
  subscriber,
  props,
}: {
  column: string;
  subscriber: Subscriber;
  props: SubscribersTableProps;
}): ReactElement {
  if (column === "avatar") {
    return (
      <div style={{ display: "flex", alignItems: "center" }}>
        <Avatar
          email={subscriber.email}
          name={avatarName(subscriber)}
          size={24}
        />
      </div>
    );
  }
  if (column === "email") {
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          flexWrap: "wrap",
          gap: 6,
          minWidth: 0,
        }}
      >
        <InlineEmailEdit
          email={subscriber.email}
          canEdit={props.canMutate && subscriber.id != null}
          onCommit={(email) => props.onRenameEmail(subscriber, email)}
        />
        {subscriber.federated_master_id ? (
          <span
            className="badge"
            style={{ flexShrink: 0, fontSize: 10, whiteSpace: "normal" }}
          >
            Federated · parent workspace identity
          </span>
        ) : null}
      </div>
    );
  }
  if (column === "status") {
    const uiStatus = engineStatusToUi(subscriber.status);
    const statusUnknown = uiStatus === "unknown";
    const statusUnavailable =
      statusUnknown || !props.canMutate || subscriber.id == null;
    const describedBy = [
      props.statusGuidanceId,
      !props.canMutate ? props.statusWriteGuidanceId : undefined,
    ]
      .filter(Boolean)
      .join(" ");
    return (
      <div>
        {statusUnknown ? (
          <span
            className="badge warning"
            role="status"
            aria-label={`Unknown status for ${subscriber.email}; reconciliation required`}
            style={{ fontSize: 10, whiteSpace: "normal" }}
          >
            Unknown · reconcile
          </span>
        ) : (
          <select
            value={uiStatus}
            onChange={(event) => {
              if (!statusUnavailable) {
                props.onStatusChange(subscriber, event.target.value);
              }
            }}
            onClick={(event) => event.stopPropagation()}
            onPointerDown={(event) => {
              if (statusUnavailable) event.preventDefault();
            }}
            onKeyDown={(event) => {
              if (statusUnavailable) event.preventDefault();
            }}
            aria-disabled={statusUnavailable || undefined}
            aria-describedby={describedBy || undefined}
            className="input"
            style={{
              fontSize: 11,
              padding: "1px 4px",
              height: 22,
              maxWidth: 110,
            }}
            aria-label={`Status for ${subscriber.email}`}
          >
            <option value="subscribed">
              {UI_STATUS_LABELS.subscribed} · review required
            </option>
            <option value="unsubscribed">
              {UI_STATUS_LABELS.unsubscribed}
            </option>
            <option value="disabled">{UI_STATUS_LABELS.disabled}</option>
            <option value="unconfirmed">{UI_STATUS_LABELS.unconfirmed}</option>
          </select>
        )}
        {statusUnknown ? (
          <span className="visually-hidden">
            Raw status value: {String(subscriber.status ?? "missing")}. This
            record remains non-sendable until repaired at the source.
          </span>
        ) : null}
      </div>
    );
  }
  return (
    <div
      style={{
        minWidth: 0,
        overflowWrap: "anywhere",
      }}
    >
      {fmtMaybe(field(subscriber, column))}
    </div>
  );
}

function SubscriberRowCell({
  column,
  subscriber,
  props,
}: {
  column: string;
  subscriber: Subscriber;
  props: SubscribersTableProps;
}): ReactElement {
  if (IDENTITY_COLUMNS.has(column)) {
    return (
      <SubscriberIdentityCell
        column={column}
        subscriber={subscriber}
        props={props}
      />
    );
  }
  if (column === "joined") {
    return (
      <div className="muted tabular">
        {fmtDate(subscriber.created_at ?? subscriber.joined_at)}
      </div>
    );
  }
  if (column === "engagement" || column === "rating") {
    const fieldName = column === "engagement" ? "engagement_score" : "rating";
    return (
      <div className="muted tabular col-num">
        {fmtMaybe(field(subscriber, fieldName))}
      </div>
    );
  }
  if (column === "churn_score")
    return <ChurnScoreCell subscriber={subscriber} />;
  if (column === "last_active") {
    const lastActive = field(subscriber, "last_active_at");
    return (
      <div className="muted tabular">
        {typeof lastActive === "string" ? fmtDate(lastActive) : "—"}
      </div>
    );
  }
  if (column === "archived_at") {
    return (
      <div className="muted tabular">
        {subscriber.archived_at ? fmtDate(subscriber.archived_at) : "—"}
      </div>
    );
  }
  if (column === "account") {
    const account = fmtMaybe(field(subscriber, "account_name"));
    return (
      <div
        className="muted"
        style={{
          minWidth: 0,
          overflowWrap: "anywhere",
        }}
      >
        {account}
      </div>
    );
  }
  if (column === "tags") {
    return (
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 4,
          alignItems: "center",
          minWidth: 0,
        }}
      >
        {(subscriber.tags ?? []).map((tag) => (
          <InlineTagChip
            key={tag}
            tag={tag}
            removable={props.canMutate && subscriber.id != null}
            onRemove={() => props.onRemoveTag(subscriber, tag)}
          />
        ))}
        {props.canMutate && subscriber.id != null ? (
          <AddTagButton onAdd={(tag) => props.onAddTag(subscriber, tag)} />
        ) : null}
      </div>
    );
  }
  return <div />;
}

function ChurnScoreCell({
  subscriber,
}: {
  subscriber: Subscriber;
}): ReactElement {
  const version = subscriber.prediction_model_version;
  const confidence = subscriber.prediction_confidence;
  const badge =
    version != null && version !== ""
      ? `${version}${typeof confidence === "number" ? ` (${confidence.toFixed(2)})` : ""}`
      : null;
  return (
    <div
      className="muted tabular col-num"
      style={{
        display: "flex",
        alignItems: "baseline",
        justifyContent: "flex-end",
        gap: 6,
      }}
    >
      <span>{fmtMaybe(field(subscriber, "churn_score"))}</span>
      {badge ? (
        <span className="badge" style={{ fontSize: 10, whiteSpace: "normal" }}>
          Scored by {badge}
        </span>
      ) : null}
    </div>
  );
}

function field(
  subscriber: Subscriber,
  key: string,
): string | number | undefined {
  const value = (subscriber as unknown as Record<string, unknown>)[key];
  return typeof value === "number" || typeof value === "string"
    ? value
    : undefined;
}

function fmtMaybe(value: string | number | undefined): string {
  return value == null || value === "" ? "—" : String(value);
}

function avatarName(subscriber: Subscriber): string | undefined {
  const candidates = [
    field(subscriber, "display_name"),
    field(subscriber, "first_name"),
    field(subscriber, "full_name"),
    subscriber.name,
  ];
  return candidates.find(
    (candidate): candidate is string =>
      typeof candidate === "string" && candidate.trim().length > 0,
  );
}
