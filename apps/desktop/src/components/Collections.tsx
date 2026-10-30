/**
 * Reference Collections workspace.
 *
 * This surface intentionally distinguishes the generic reference-collection
 * API from deployable coupon pools and from campaign/automation runtime data.
 * Lists are metadata-only; row bodies are requested only when an authorized
 * editor explicitly opens one collection.
 */

/* eslint-disable jsx-a11y/no-noninteractive-tabindex -- Bounded table regions need a keyboard scroll target in narrow desktop windows. */

import type { ReactElement } from "react";

import { type Collection, type CollectionType } from "../lib/api-client";
import {
  COLLECTION_IMPORT_FILE_MAX_BYTES,
  COLLECTION_IMPORT_MAX_COLUMNS,
  COLLECTION_IMPORT_MAX_ROWS,
  type ParsedCollectionUpload,
} from "../lib/collections/collection-import";
import { desktopRouteIdentityScope } from "../lib/desktop-router";
import { acceptDroppedFiles, pickImportFiles } from "../lib/file-transfer";
import type { ImportPolicy } from "../lib/file-transfer-types";
import { fmtDate } from "../lib/format-date";
import { useCanWrite, useMe } from "../lib/store";
import { ConfirmModal } from "./ConfirmModal";
import { FormField } from "./FormField";
import { Modal, ModalFooter } from "./Modal";
import { PageHeader } from "./PageHeader";
import { useCollectionsController } from "./collections/useCollectionsController";

import "../styles-collections.css";

const COLLECTION_TYPES: CollectionType[] = ["content", "schedule", "coupons"];
const DETAIL_PREVIEW_ROWS = 50;
const DETAIL_PREVIEW_COLUMNS = 100;

const COLLECTION_IMPORT_POLICY: ImportPolicy = {
  label: "reference-data file",
  privacy: "confidential",
  extensions: ["csv", "json"],
  maxBytes: COLLECTION_IMPORT_FILE_MAX_BYTES,
};

const TYPE_LABELS: Record<CollectionType, string> = {
  content: "Content reference rows",
  schedule: "Schedule reference rows",
  coupons: "Coupon reference rows (legacy)",
};

const SOURCE_LABELS: Record<Collection["source_type"], string> = {
  uploaded: "File upload",
  api: "API",
  manual: "Manual / legacy",
};

function typeLabel(type: CollectionType): string {
  return TYPE_LABELS[type];
}

function displayCell(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null) return "null";
  if (value === undefined) return "";
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return "[Value unavailable]";
  }
}

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim()
    ? error.message
    : fallback;
}

export function Collections(): ReactElement {
  const me = useMe();
  const identityScope = desktopRouteIdentityScope(me?.user, me?.tenant);
  return (
    <CollectionsController
      key={identityScope === null ? "collections-identity-pending" : identityScope}
      identityScope={identityScope}
      workspaceTenantId={me?.tenant ?? null}
    />
  );
}

function CollectionsController({
  identityScope,
  workspaceTenantId,
}: {
  identityScope: string | null;
  workspaceTenantId: string | null;
}): ReactElement {
  const canWrite = useCanWrite();
  const controller = useCollectionsController({
    canWrite,
    identityScope,
    workspaceTenantId,
  });
  const { catalog, collectionImport, detail, deletion } = controller;

  return (
    <div className="collections-route">
      <CollectionsWorkspace
        canDelete={controller.canDelete}
        canWrite={canWrite}
        identityReady={identityScope !== null}
        items={catalog.items}
        loadError={catalog.loadError}
        loadMoreError={catalog.loadMoreError}
        loading={catalog.loading}
        loadingMore={catalog.loadingMore}
        nextCursor={catalog.nextCursor}
        refreshing={catalog.refreshing}
        searchComposing={catalog.searchComposing}
        searchDraft={catalog.searchDraft}
        searchError={catalog.searchError}
        total={catalog.total}
        typeFilter={catalog.typeFilter}
        onClearFilters={catalog.clearFilters}
        onDelete={deletion.open}
        onLoadMore={() => void catalog.loadMore()}
        onOpen={(collection) => void detail.openEditor(collection)}
        onRefresh={() => void catalog.refresh()}
        onSearchChange={catalog.setSearchDraft}
        onSearchComposingChange={catalog.setSearchComposing}
        onSearchCommit={catalog.commitSearch}
        onTypeFilterChange={catalog.setTypeFilter}
        onUpload={collectionImport.openEditor}
      />

      <CollectionUploadModal
        canWrite={canWrite}
        dragOver={collectionImport.dragOver}
        fileName={collectionImport.fileName}
        name={collectionImport.name}
        nameError={collectionImport.nameError}
        open={collectionImport.open}
        parseError={collectionImport.parseError}
        parsed={collectionImport.parsed}
        parsing={collectionImport.parsing}
        saving={collectionImport.saving}
        type={collectionImport.type}
        onClose={collectionImport.requestClose}
        onCreate={collectionImport.create}
        onDragOverChange={collectionImport.setDragOver}
        onFile={collectionImport.handleFile}
        onNameChange={collectionImport.setName}
        onParseError={collectionImport.setParseError}
        onTypeChange={collectionImport.setType}
      />

      <CollectionDetailModal
        canWrite={canWrite}
        collection={detail.detail}
        dirty={detail.dirty}
        error={detail.error}
        loading={detail.loading}
        name={detail.name}
        nameError={detail.nameError}
        saving={detail.saving}
        summary={detail.target}
        type={detail.type}
        onClose={detail.requestClose}
        onNameChange={detail.setName}
        onRetry={() => void detail.retry()}
        onSave={detail.save}
        onTypeChange={detail.setType}
      />

      <ConfirmModal
        open={collectionImport.discardOpen}
        title="Discard this import draft?"
        description="The parsed rows and collection metadata exist only on this device and will be cleared."
        confirmLabel="Discard draft"
        danger
        onConfirm={collectionImport.closeNow}
        onClose={() => collectionImport.setDiscardOpen(false)}
      />
      <ConfirmModal
        open={detail.discardOpen}
        title="Discard metadata changes?"
        description="The stored collection will keep its current name and type."
        confirmLabel="Discard changes"
        danger
        onConfirm={detail.closeNow}
        onClose={() => detail.setDiscardOpen(false)}
      />
      <ConfirmModal
        open={deletion.target !== null}
        title="Permanently delete reference collection?"
        description={
          deletion.target
            ? `${deletion.target.row_count.toLocaleString()} stored row${deletion.target.row_count === 1 ? "" : "s"} will be permanently removed. Moosewave cannot restore them or determine whether an external API client still reads them.`
            : undefined
        }
        confirmLabel="Delete permanently"
        typeToConfirm={deletion.target?.name}
        danger
        busy={deletion.busy}
        confirmDisabled={!controller.canDelete}
        onConfirm={deletion.confirm}
        onClose={deletion.close}
      >
        {deletion.target ? (
          <p className="collections-delete-target">
            Deleting <strong><bdi dir="auto">{deletion.target.name}</bdi></strong>
          </p>
        ) : null}
      </ConfirmModal>
    </div>
  );
}
interface CollectionsWorkspaceProps {
  canDelete: boolean;
  canWrite: boolean;
  identityReady: boolean;
  items: Collection[];
  loadError: string | null;
  loadMoreError: string | null;
  loading: boolean;
  loadingMore: boolean;
  nextCursor: string | null;
  refreshing: boolean;
  searchComposing: boolean;
  searchDraft: string;
  searchError: string | null;
  total: number;
  typeFilter: CollectionType | "all";
  onClearFilters: () => void;
  onDelete: (collection: Collection) => void;
  onLoadMore: () => void;
  onOpen: (collection: Collection) => void;
  onRefresh: () => void;
  onSearchChange: (value: string) => void;
  onSearchComposingChange: (value: boolean) => void;
  onSearchCommit: (value: string) => void;
  onTypeFilterChange: (value: CollectionType | "all") => void;
  onUpload: () => void;
}

function CollectionsWorkspace({
  canDelete,
  canWrite,
  identityReady,
  items,
  loadError,
  loadMoreError,
  loading,
  loadingMore,
  nextCursor,
  onClearFilters,
  onDelete,
  onLoadMore,
  onOpen,
  onRefresh,
  onSearchChange,
  onSearchCommit,
  onSearchComposingChange,
  onTypeFilterChange,
  onUpload,
  refreshing,
  searchComposing,
  searchDraft,
  searchError,
  total,
  typeFilter,
}: CollectionsWorkspaceProps): ReactElement {
  const rowTotal = items.reduce((sum, item) => sum + item.row_count, 0);
  const filtered = searchDraft.trim().length > 0 || typeFilter !== "all";
  const initialError = !loading && items.length === 0 && loadError;
  return (
    <>
      <PageHeader
        eyebrow="Data operations"
        title="Reference collections"
        subtitle="Workspace-scoped lookup tables for controlled operator and API use. Saving data here does not publish it to campaigns, personalization, or automations."
        meta={<span className="badge info">Reference API only</span>}
        actions={[
          {
            label: "Import reference data",
            variant: "primary",
            disabled: !canWrite,
            title: canWrite
              ? "Parse a bounded CSV or JSON file before saving."
              : "Viewer access can inspect metadata, but cannot read row values or import data.",
            onClick: onUpload,
          },
        ]}
      />

      <section className="collections-boundary" aria-labelledby="collections-boundary-title">
        <div className="collections-boundary-mark" aria-hidden="true">
          i
        </div>
        <div>
          <h2 id="collections-boundary-title">Know what this workspace stores</h2>
          <p>
            These are generic reference rows. The legacy coupon-reference type
            is separate from deployable coupon pools, redemption inventory, and
            Discounts. No runtime dependency graph or publish step exists here.
          </p>
        </div>
      </section>

      {!canWrite ? (
        <div className="collections-readonly" id="collections-readonly-reason" role="status">
          Viewer mode shows names, types, dates, and exact row counts only.
          Confidential row values are never requested from this screen.
        </div>
      ) : null}
      {canWrite && !canDelete && items.length > 0 ? (
        <div
          className="collections-readonly"
          id="collections-delete-stale-reason"
          role="status"
        >
          Permanent delete is paused until collection metadata finishes
          refreshing successfully. Fresh detail review remains available.
        </div>
      ) : null}

      <div className="collections-stats" aria-label="Loaded catalog summary">
        <div className="collections-stat">
          <span>Matching records</span>
          <strong>{total.toLocaleString()}</strong>
        </div>
        <div className="collections-stat">
          <span>Metadata loaded</span>
          <strong>{items.length.toLocaleString()}</strong>
        </div>
        <div className="collections-stat">
          <span>Rows in loaded records</span>
          <strong>{rowTotal.toLocaleString()}</strong>
        </div>
      </div>

      <div className="collections-toolbar" role="search" aria-label="Filter reference collections">
        <label className="collections-search-field">
          <span className="collections-filter-label">Search by name</span>
          <input
            className="input"
            value={searchDraft}
            dir="auto"
            onChange={(event) => onSearchChange(event.target.value)}
            onCompositionStart={() => onSearchComposingChange(true)}
            onCompositionEnd={(event) => {
              onSearchComposingChange(false);
              onSearchChange(event.currentTarget.value);
              onSearchCommit(event.currentTarget.value);
            }}
            placeholder="Search reference collections…"
            autoComplete="off"
            aria-invalid={searchError ? "true" : undefined}
            aria-describedby={searchError ? "collections-search-error" : undefined}
          />
          {searchError ? (
            <span
              className="collections-field-error"
              id="collections-search-error"
              role="alert"
            >
              {searchError} Results below still use the last valid search.
            </span>
          ) : null}
        </label>
        <label className="collections-type-field">
          <span className="collections-filter-label">Reference type</span>
          <select
            className="input"
            value={typeFilter}
            onChange={(event) =>
              onTypeFilterChange(event.target.value as CollectionType | "all")
            }
          >
            <option value="all">All reference types</option>
            {COLLECTION_TYPES.map((type) => (
              <option key={type} value={type}>
                {typeLabel(type)}
              </option>
            ))}
          </select>
        </label>
        <div className="collections-toolbar-actions">
          {filtered ? (
            <button type="button" className="btn btn-ghost" onClick={onClearFilters}>
              Clear filters
            </button>
          ) : null}
          <button
            type="button"
            className="btn"
            disabled={loading || refreshing}
            onClick={onRefresh}
          >
            {refreshing ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      </div>

      <div
        className="collections-results"
        aria-busy={loading || refreshing || loadingMore}
        aria-live="polite"
      >
        {!identityReady ? (
          <CollectionLoadingState label="Confirming workspace identity…" />
        ) : loading ? (
          <CollectionLoadingState label="Loading collection metadata…" />
        ) : initialError ? (
          <CollectionErrorState message={initialError} onRetry={onRefresh} />
        ) : (
          <>
            {loadError ? (
              <div className="notice notice-danger collections-inline-notice" role="alert">
                <span>Refresh failed: {loadError}. Verified metadata remains below.</span>
                <button type="button" className="btn btn-sm" onClick={onRefresh}>
                  Retry
                </button>
              </div>
            ) : null}
            {items.length === 0 ? (
              <CollectionEmptyState
                canWrite={canWrite}
                filtered={filtered}
                onClearFilters={onClearFilters}
                onUpload={onUpload}
              />
            ) : (
              <CollectionTable
                canDelete={canDelete}
                canWrite={canWrite}
                items={items}
                onDelete={onDelete}
                onOpen={onOpen}
              />
            )}
            {items.length > 0 ? (
              <div className="collections-pagination" aria-label="Collection pagination">
                <span className="muted">
                  Showing {items.length.toLocaleString()} of {total.toLocaleString()} matching records
                </span>
                {nextCursor ? (
                  <button
                    type="button"
                    className="btn"
                    disabled={loadingMore}
                    onClick={onLoadMore}
                  >
                    {loadingMore ? "Loading…" : "Load more"}
                  </button>
                ) : (
                  <span className="collections-end-marker">End of results</span>
                )}
              </div>
            ) : null}
            {loadMoreError ? (
              <div className="notice notice-danger collections-inline-notice" role="alert">
                <span>Couldn't load the next page: {loadMoreError}</span>
                <button type="button" className="btn btn-sm" onClick={onLoadMore}>
                  Retry
                </button>
              </div>
            ) : null}
          </>
        )}
        {searchComposing ? (
          <span className="visually-hidden">Search waits until text composition is complete.</span>
        ) : null}
      </div>
    </>
  );
}

function CollectionLoadingState({ label }: { label: string }): ReactElement {
  return (
    <div className="collections-loading" role="status">
      <div className="collections-loading-copy">
        <strong>{label}</strong>
        <span>Only bounded metadata is requested for this catalog.</span>
      </div>
      <div className="collections-loading-rows" aria-hidden="true">
        <span />
        <span />
        <span />
      </div>
    </div>
  );
}

function CollectionErrorState({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}): ReactElement {
  return (
    <div className="empty-state collections-empty" role="alert">
      <div className="empty-state-icon" aria-hidden="true">!</div>
      <h2>Reference metadata is unavailable</h2>
      <p>{message}</p>
      <button type="button" className="btn btn-primary" onClick={onRetry}>
        Retry safely
      </button>
    </div>
  );
}

function CollectionEmptyState({
  canWrite,
  filtered,
  onClearFilters,
  onUpload,
}: {
  canWrite: boolean;
  filtered: boolean;
  onClearFilters: () => void;
  onUpload: () => void;
}): ReactElement {
  return (
    <div className="empty-state collections-empty">
      <div className="empty-state-icon" aria-hidden="true">{filtered ? "⌕" : "↳"}</div>
      <h2>{filtered ? "No matching reference collections" : "No reference collections yet"}</h2>
      <p>
        {filtered
          ? "Clear or adjust the server-side filters to search the full catalog."
          : canWrite
            ? "Import a bounded CSV or JSON array when you need an operator-managed lookup table."
            : "An editor can import a reference table. Viewer access remains metadata-only."}
      </p>
      {filtered ? (
        <button type="button" className="btn" onClick={onClearFilters}>Clear filters</button>
      ) : canWrite ? (
        <button type="button" className="btn btn-primary" onClick={onUpload}>Import reference data</button>
      ) : null}
    </div>
  );
}

function CollectionTable({
  canDelete,
  canWrite,
  items,
  onDelete,
  onOpen,
}: {
  canDelete: boolean;
  canWrite: boolean;
  items: Collection[];
  onDelete: (collection: Collection) => void;
  onOpen: (collection: Collection) => void;
}): ReactElement {
  return (
    <div
      className="collections-table-wrap"
      role="region"
      aria-label="Reference collection metadata"
      tabIndex={0}
    >
      <table className="table collections-table">
        <caption className="visually-hidden">
          Metadata-only reference collection catalog. Row values are not included.
        </caption>
        <thead>
          <tr>
            <th scope="col">Name</th>
            <th scope="col">Type</th>
            <th scope="col">Source</th>
            <th scope="col" className="tabular">Rows</th>
            <th scope="col">Updated</th>
            <th scope="col">Actions</th>
          </tr>
        </thead>
        <tbody>
          {items.map((collection) => (
            <tr key={collection.id}>
              <td>
                {canWrite ? (
                  <button
                    type="button"
                    className="btn-link collections-name"
                    onClick={() => onOpen(collection)}
                    aria-label={`Review and edit ${collection.name}`}
                  >
                    <bdi dir="auto">{collection.name}</bdi>
                  </button>
                ) : (
                  <span className="collections-name">
                    <bdi dir="auto">{collection.name}</bdi>
                  </span>
                )}
              </td>
              <td><span className={`badge collections-type-${collection.collection_type}`}>{typeLabel(collection.collection_type)}</span></td>
              <td className="muted">{SOURCE_LABELS[collection.source_type]}</td>
              <td className="tabular">{collection.row_count.toLocaleString()}</td>
              <td className="muted">{fmtDate(collection.updated_at)}</td>
              <td className="collections-row-actions">
                {canWrite ? (
                  <button
                    type="button"
                    className="btn btn-sm btn-danger"
                    aria-label={`Delete ${collection.name}`}
                    aria-describedby={
                      !canDelete ? "collections-delete-stale-reason" : undefined
                    }
                    disabled={!canDelete}
                    onClick={() => onDelete(collection)}
                  >
                    Delete
                  </button>
                ) : (
                  <span className="collections-row-readonly">Read only</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

interface CollectionUploadModalProps {
  canWrite: boolean;
  dragOver: boolean;
  fileName: string | null;
  name: string;
  nameError: string | null;
  open: boolean;
  parseError: string | null;
  parsed: ParsedCollectionUpload | null;
  parsing: boolean;
  saving: boolean;
  type: CollectionType;
  onClose: () => void;
  onCreate: () => Promise<void>;
  onDragOverChange: (value: boolean) => void;
  onFile: (file: File) => Promise<void>;
  onNameChange: (value: string) => void;
  onParseError: (value: string | null) => void;
  onTypeChange: (value: CollectionType) => void;
}

function CollectionUploadModal({
  canWrite,
  dragOver,
  fileName,
  name,
  nameError,
  onClose,
  onCreate,
  onDragOverChange,
  onFile,
  onNameChange,
  onParseError,
  onTypeChange,
  open,
  parseError,
  parsed,
  parsing,
  saving,
  type,
}: CollectionUploadModalProps): ReactElement {
  const fileInputLocked = !canWrite || saving || parsing;
  const acceptFiles = (files: FileList): void => {
    if (fileInputLocked) return;
    const result = acceptDroppedFiles(files, COLLECTION_IMPORT_POLICY);
    if (!result.ok) onParseError(result.message);
    else if (result.files[0]) void onFile(result.files[0]);
  };
  const createDisabled =
    !canWrite || saving || parsing || nameError !== null || parsed === null;
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Import reference data"
      description="Review a bounded, flat CSV or JSON array before its rows are saved to this workspace."
      size="lg"
      closeDisabled={saving}
      closeOnBackdrop={!saving}
      closeOnEscape={!saving}
    >
      {!canWrite ? (
        <div className="notice notice-danger" role="alert">
          Your access changed to viewer. This draft cannot be saved; close it or ask a workspace admin to restore edit access.
        </div>
      ) : null}
      <div className="collections-import-grid">
        <FormField
          label="Collection name"
          required
          error={nameError}
          help="Unique in this workspace; 200 Unicode characters maximum."
        >
          <input
            className="input"
            value={name}
            dir="auto"
            disabled={!canWrite || saving}
            onChange={(event) => onNameChange(event.target.value)}
            placeholder="Spring content references"
          />
        </FormField>
        <FormField label="Reference type" required error={null} help="A descriptive category, not a runtime destination.">
          <select
            className="input"
            value={type}
            disabled={!canWrite || saving}
            onChange={(event) => onTypeChange(event.target.value as CollectionType)}
          >
            {COLLECTION_TYPES.map((collectionType) => (
              <option key={collectionType} value={collectionType}>{typeLabel(collectionType)}</option>
            ))}
          </select>
        </FormField>
      </div>
      {type === "coupons" ? (
        <div className="collections-coupon-warning" role="note">
          Coupon reference rows are legacy generic data. They do not reserve, issue, validate, or track deployable coupon codes.
        </div>
      ) : null}
      <div
        className={`collections-dropzone${dragOver ? " is-dragging" : ""}${fileInputLocked ? " is-disabled" : ""}`}
        aria-busy={parsing || saving ? "true" : undefined}
        aria-disabled={fileInputLocked ? "true" : undefined}
        onDragOver={(event) => {
          if (fileInputLocked) return;
          event.preventDefault();
          onDragOverChange(true);
        }}
        onDragLeave={() => onDragOverChange(false)}
        onDrop={(event) => {
          event.preventDefault();
          onDragOverChange(false);
          acceptFiles(event.dataTransfer.files);
        }}
      >
        <div className="collections-dropzone-copy">
          <strong>
            <bdi dir="auto">{fileName ?? "Choose one bounded lookup table"}</bdi>
          </strong>
          <span>
            {saving
              ? "Saving the reviewed snapshot; file replacement is paused."
              : parsing
                ? "Validating this file; replacement resumes when validation finishes."
                : `CSV with one header row, or a JSON array of flat objects · 1 MiB · ${COLLECTION_IMPORT_MAX_ROWS.toLocaleString()} rows · ${COLLECTION_IMPORT_MAX_COLUMNS.toLocaleString()} columns`}
          </span>
        </div>
        <button
          type="button"
          className="btn"
          disabled={fileInputLocked}
          onClick={() => {
            void pickImportFiles(COLLECTION_IMPORT_POLICY)
              .then((result) => {
                if (!result.ok) onParseError(result.message);
                else if (result.files[0]) void onFile(result.files[0]);
              })
              .catch((error: unknown) => {
                onParseError(errorText(error, "Couldn't open the file picker."));
              });
          }}
        >
          {parsing ? "Parsing safely…" : parsed ? "Choose another file" : "Choose CSV or JSON"}
        </button>
      </div>
      {parsing ? <div className="collections-parse-status" role="status">Validating UTF-8, structure, and save size…</div> : null}
      {parseError ? <div className="notice notice-danger collections-inline-notice" role="alert">{parseError}</div> : null}
      {parsed ? <CollectionPreview parsed={parsed} /> : null}
      <ModalFooter>
        <button type="button" className="btn" disabled={saving} onClick={onClose}>Cancel</button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={createDisabled}
          aria-describedby={!canWrite ? "collections-readonly-reason" : undefined}
          onClick={() => void onCreate()}
        >
          {saving ? "Saving…" : "Create reference collection"}
        </button>
      </ModalFooter>
    </Modal>
  );
}

function CollectionPreview({
  parsed,
}: {
  parsed: ParsedCollectionUpload;
}): ReactElement {
  return (
    <section className="collections-preview" aria-labelledby="collections-preview-title">
      <div className="collections-preview-heading">
        <div>
          <h3 id="collections-preview-title">Parsed preview</h3>
          <p>
            {parsed.rows.length.toLocaleString()} row{parsed.rows.length === 1 ? "" : "s"} · {parsed.columns.length.toLocaleString()} column{parsed.columns.length === 1 ? "" : "s"} · {(parsed.encodedBytes / 1024).toFixed(1)} KiB persistence-normalized payload
          </p>
        </div>
        <span className="badge success">Structure checked locally</span>
      </div>
      <DataPreviewTable columns={parsed.columns} rows={parsed.rows.slice(0, 20)} label="First parsed rows" />
      {parsed.rows.length > 20 ? <p className="collections-preview-foot">Showing the first 20 of {parsed.rows.length.toLocaleString()} rows.</p> : null}
    </section>
  );
}

interface CollectionDetailModalProps {
  canWrite: boolean;
  collection: Collection | null;
  dirty: boolean;
  error: string | null;
  loading: boolean;
  name: string;
  nameError: string | null;
  saving: boolean;
  summary: Collection | null;
  type: CollectionType;
  onClose: () => void;
  onNameChange: (value: string) => void;
  onRetry: () => void;
  onSave: () => Promise<void>;
  onTypeChange: (value: CollectionType) => void;
}

function CollectionDetailModal({
  canWrite,
  collection,
  dirty,
  error,
  loading,
  name,
  nameError,
  onClose,
  onNameChange,
  onRetry,
  onSave,
  onTypeChange,
  saving,
  summary,
  type,
}: CollectionDetailModalProps): ReactElement {
  const previewRows = (collection?.data ?? []).slice(0, DETAIL_PREVIEW_ROWS);
  const allColumns = [
    ...new Set(previewRows.flatMap((row) => Object.keys(row))),
  ];
  const columns = allColumns.slice(0, DETAIL_PREVIEW_COLUMNS);
  return (
    <Modal
      open={summary !== null}
      onClose={onClose}
      title={`Reference collection details${summary ? ` — ${summary.name}` : ""}`}
      description="Fresh confidential rows are requested only for this authorized review."
      size="lg"
      closeDisabled={saving}
      closeOnBackdrop={!saving}
      closeOnEscape={!saving}
    >
      {loading ? <CollectionLoadingState label="Loading current row values…" /> : null}
      {error ? (
        <div className="empty-state collections-detail-error" role="alert">
          <div className="empty-state-icon" aria-hidden="true">!</div>
          <h3>Rows were not opened</h3>
          <p>{error}</p>
          <button type="button" className="btn" onClick={onRetry}>Retry current record</button>
        </div>
      ) : null}
      {collection ? (
        <>
          {!canWrite ? <div className="notice notice-danger" role="alert">Edit access was removed. Confidential rows have been cleared.</div> : null}
          <div className="collections-import-grid">
            <FormField label="Collection name" required error={nameError}>
              <input
                className="input"
                value={name}
                dir="auto"
                disabled={!canWrite || saving}
                onChange={(event) => onNameChange(event.target.value)}
              />
            </FormField>
            <FormField label="Reference type" required error={null}>
              <select
                className="input"
                value={type}
                disabled={!canWrite || saving}
                onChange={(event) => onTypeChange(event.target.value as CollectionType)}
              >
                {COLLECTION_TYPES.map((collectionType) => (
                  <option key={collectionType} value={collectionType}>{typeLabel(collectionType)}</option>
                ))}
              </select>
            </FormField>
          </div>
          {type === "coupons" ? <div className="collections-coupon-warning" role="note">This is legacy coupon reference data, not deployable coupon inventory.</div> : null}
          <section className="collections-preview" aria-labelledby="collections-detail-rows-title">
            <div className="collections-preview-heading">
              <div>
                <h3 id="collections-detail-rows-title">Stored rows</h3>
                <p>{collection.row_count.toLocaleString()} exact persisted row{collection.row_count === 1 ? "" : "s"}</p>
              </div>
              <span className="badge info">Fresh read</span>
            </div>
            {collection.data.length === 0 ? <p className="collections-preview-foot">This collection has no rows.</p> : columns.length === 0 ? <p className="collections-preview-foot">The stored rows contain no named fields.</p> : (
              <>
                <DataPreviewTable columns={columns} rows={previewRows} label="Stored reference rows" />
                <p className="collections-preview-foot">
                  Showing the first {previewRows.length.toLocaleString()} of {collection.row_count.toLocaleString()} rows{allColumns.length > columns.length ? ` and ${columns.length.toLocaleString()} of ${allColumns.length.toLocaleString()} preview columns` : ""}.
                </p>
              </>
            )}
          </section>
          <ModalFooter>
            <button type="button" className="btn" disabled={saving} onClick={onClose}>Close</button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={!canWrite || saving || !dirty || nameError !== null}
              onClick={() => void onSave()}
            >
              {saving ? "Saving…" : dirty ? "Save metadata changes" : "No changes to save"}
            </button>
          </ModalFooter>
        </>
      ) : null}
    </Modal>
  );
}

function DataPreviewTable({
  columns,
  label,
  rows,
}: {
  columns: string[];
  label: string;
  rows: Collection["data"];
}): ReactElement {
  return (
    <div className="collections-preview-table-wrap" role="region" aria-label={label} tabIndex={0}>
      <table className="table collections-preview-table">
        <caption className="visually-hidden">{label}</caption>
        <thead>
          <tr>
            {columns.map((column) => (
              <th scope="col" key={column}>
                <bdi dir="auto">{column}</bdi>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={index}>
              {columns.map((column) => <td key={column}><bdi className="collections-cell-value" dir="auto">{displayCell(row[column])}</bdi></td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
