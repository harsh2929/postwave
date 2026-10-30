import type { ReactElement, RefObject } from "react";

import { HeroEmptyState } from "../components/HeroEmptyState";
import type { PushSuppressionRow } from "../lib/api/push-suppressions";
import { PushSuppressionDirectory } from "./PushSuppressionDirectory";
import type { PushSuppressionBulkRemoveController } from "./usePushSuppressionBulkRemove";
import type { PushSuppressionsController } from "./usePushSuppressionsController";

type DirectoryState = PushSuppressionsController["directory"];

export function PushRuntimeDisclosure(): ReactElement {
  return (
    <section className="push-runtime-disclosure" aria-labelledby="push-runtime-title">
      <div>
        <span className="push-runtime-kicker">
          Registry operational · dispatch held
        </span>
        <h2 id="push-runtime-title">Push authority is stored before sending ships</h2>
      </div>
      <ul>
        <li>Customer push dispatch is not currently enabled.</li>
        <li>
          The APNs/FCM send gate is code-enforced before any future dispatch
          enablement.
        </li>
        <li>
          Automatic provider feedback is unavailable; Web is registry-only.
        </li>
      </ul>
    </section>
  );
}

interface HeaderProps {
  directory: DirectoryState;
  exporting: boolean;
  pickingImport: boolean;
  mutationReady: boolean;
  addButtonRef: RefObject<HTMLButtonElement | null>;
  onRefresh: () => Promise<boolean>;
  onExport: () => Promise<void>;
  onImport: (trigger: HTMLButtonElement) => Promise<void>;
  onAdd: (trigger: HTMLButtonElement) => void;
}

export function PushSuppressionsHeader({
  directory,
  exporting,
  pickingImport,
  mutationReady,
  addButtonRef,
  onRefresh,
  onExport,
  onImport,
  onAdd,
}: HeaderProps): ReactElement {
  const toolsBusy = exporting || pickingImport;
  return (
    <div className="page-header-v2 push-page-header">
      <div>
        <div className="page-header-v2-eyebrow">Audience protection</div>
        <h1 id="push-suppressions-title" className="page-header-v2-title">
          Push suppressions
        </h1>
        <p className="page-header-v2-subtitle">
          Exact-admin authority registry · privacy-safe fingerprints only
        </p>
      </div>
      <div className="page-header-v2-actions push-header-actions">
        <button
          type="button"
          className="btn"
          disabled={directory.loading || toolsBusy}
          onClick={() => void onRefresh()}
        >
          {directory.loading ? "Refreshing…" : "Refresh registry"}
        </button>
        <button
          type="button"
          className="btn"
          disabled={
            !directory.authorityCurrent ||
            directory.visibleRows.length === 0 ||
            toolsBusy
          }
          onClick={() => void onExport()}
        >
          {exporting ? "Exporting…" : "Export verified page (CSV)"}
        </button>
        <button
          type="button"
          className="btn"
          disabled={!directory.authorityCurrent || toolsBusy}
          onClick={(event) => void onImport(event.currentTarget)}
        >
          {pickingImport ? "Choosing CSV…" : "Import reviewed CSV"}
        </button>
        <button
          ref={addButtonRef}
          type="button"
          className="btn btn-primary"
          disabled={!mutationReady}
          onClick={(event) => onAdd(event.currentTarget)}
        >
          Add manual suppression
        </button>
      </div>
    </div>
  );
}

function hasActiveFilters(directory: DirectoryState): boolean {
  return (
    directory.platform !== "all" ||
    directory.reason !== "all" ||
    directory.source !== "all" ||
    directory.queryInput.length > 0
  );
}

function hasStaleRows(directory: DirectoryState): boolean {
  return (
    directory.criteriaVerified &&
    Boolean(directory.error) &&
    !directory.unavailable
  );
}

function statusCopy(directory: DirectoryState): string {
  if (directory.queryError) {
    return "The fingerprint search has not been applied.";
  }
  if (directory.loading && directory.criteriaVerified) {
    return "Refreshing. The last verified page remains visible; mutations are paused.";
  }
  if (hasStaleRows(directory)) {
    return "Refresh failed. The last verified page remains visible; mutations are paused.";
  }
  if (directory.loading) {
    return "Loading the authoritative push suppression registry.";
  }
  if (directory.criteriaVerified) {
    return `Verified ${directory.total?.toLocaleString() ?? "0"} suppression authorities.`;
  }
  return "No verified push suppression page is available.";
}

function InitialLoading(): ReactElement {
  return (
    <section className="push-initial-loading" role="status" aria-live="polite">
      <span className="sr-only">Loading the push suppression registry.</span>
      {[0, 1, 2, 3].map((index) => (
        <div key={index} className="skel-row" aria-hidden="true" />
      ))}
    </section>
  );
}

function RegistryError({
  directory,
  stale,
  onRetry,
}: {
  directory: DirectoryState;
  stale: boolean;
  onRetry: () => Promise<boolean>;
}): ReactElement | null {
  if (!directory.error) return null;
  return (
    <div className={`push-load-error${stale ? " is-stale" : ""}`} role="alert">
      <div>
        <strong>
          {stale ? "Showing the last verified page." : "Registry unavailable."}
        </strong>
        <span>{directory.error}</span>
      </div>
      <button
        type="button"
        className="btn"
        disabled={directory.loading}
        onClick={() => void onRetry()}
      >
        Retry
      </button>
    </div>
  );
}

function RegistryEmptyStates({
  directory,
  activeFilters,
  addButtonRef,
  onAdd,
  onClearFilters,
}: {
  directory: DirectoryState;
  activeFilters: boolean;
  addButtonRef: RefObject<HTMLButtonElement | null>;
  onAdd: (trigger?: HTMLButtonElement | null) => void;
  onClearFilters: () => void;
}): ReactElement | null {
  const firstPageEmpty =
    directory.criteriaVerified &&
    directory.pageIndex === 0 &&
    directory.rows?.length === 0;
  const filteredEmpty =
    directory.criteriaVerified &&
    (activeFilters || directory.pageIndex > 0) &&
    directory.visibleRows.length === 0;
  if (firstPageEmpty && !activeFilters) {
    return (
      <HeroEmptyState
        tone="mint"
        eyebrow="Push hygiene"
        title="The registry has no suppression authorities yet."
        subtitle="Add a customer device token manually when an exact-admin review establishes a suppression requirement. Automatic provider feedback is not available."
        primaryCta={
          directory.authorityCurrent
            ? {
                label: "Add manual suppression",
                onClick: () => onAdd(addButtonRef.current),
              }
            : undefined
        }
        imageSrc={null}
        meta="Raw tokens are accepted only in the add dialog and are never returned."
      />
    );
  }
  if (!filteredEmpty) return null;
  return (
    <section className="push-filtered-empty" role="status">
      <h2>No suppressions match these filters</h2>
      <p>
        Clear the server search and platform/reason filters, or remove the
        current-page source filter.
      </p>
      <button type="button" className="btn" onClick={onClearFilters}>
        Clear all filters
      </button>
    </section>
  );
}

interface RegistryProps {
  directory: DirectoryState;
  mutationReady: boolean;
  bulkRemove: PushSuppressionBulkRemoveController;
  addButtonRef: RefObject<HTMLButtonElement | null>;
  onRetry: () => Promise<boolean>;
  onClearFilters: () => void;
  onAdd: (trigger?: HTMLButtonElement | null) => void;
  onDetail: (row: PushSuppressionRow, trigger: HTMLButtonElement) => void;
  onRemove: (row: PushSuppressionRow, trigger?: HTMLButtonElement | null) => void;
  onPrevious: () => Promise<boolean>;
  onNext: () => Promise<boolean>;
}

export function PushRegistrySurface({
  directory,
  mutationReady,
  bulkRemove,
  addButtonRef,
  onRetry,
  onClearFilters,
  onAdd,
  onDetail,
  onRemove,
  onPrevious,
  onNext,
}: RegistryProps): ReactElement {
  const activeFilters = hasActiveFilters(directory);
  const stale = hasStaleRows(directory);
  const showDirectory =
    directory.criteriaVerified && directory.visibleRows.length > 0;
  const showSnapshot = directory.criteriaVerified && Boolean(directory.snapshotAt);
  return (
    <>
      <p className="push-live-status sr-only" role="status" aria-live="polite">
        {statusCopy(directory)}
      </p>
      <RegistryError directory={directory} stale={stale} onRetry={onRetry} />
      {directory.loading && !directory.criteriaVerified ? (
        <InitialLoading />
      ) : null}
      <RegistryEmptyStates
        directory={directory}
        activeFilters={activeFilters}
        addButtonRef={addButtonRef}
        onAdd={onAdd}
        onClearFilters={onClearFilters}
      />
      {showDirectory ? (
        <PushSuppressionDirectory
          rows={directory.visibleRows}
          unfilteredPageCount={directory.rows?.length ?? 0}
          total={directory.total ?? 0}
          pageIndex={directory.pageIndex}
          hasNextPage={Boolean(directory.nextCursor)}
          loading={directory.loading}
          mutationReady={mutationReady}
          selectedIds={bulkRemove.state.selectedIds}
          onDetail={onDetail}
          onRemove={onRemove}
          onToggleSelection={bulkRemove.toggle}
          onToggleAll={bulkRemove.toggleAll}
          onClearSelection={bulkRemove.clear}
          onRequestBulkRemove={bulkRemove.request}
          onPrevious={() => void onPrevious()}
          onNext={() => void onNext()}
        />
      ) : null}
      {showSnapshot ? (
        <p className="push-snapshot-note">
          Verified snapshot{" "}
          <time dateTime={directory.snapshotAt ?? undefined}>
            {directory.snapshotAt}
          </time>
          . Cursor pages are accepted only while this revision snapshot
          matches. This time is observation metadata, not a row timestamp
          cutoff.
        </p>
      ) : null}
    </>
  );
}
