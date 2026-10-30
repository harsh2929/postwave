import type { ReactElement } from "react";

import { ChoiceGroup } from "../../components/ChoiceGroup";
import { TAG_PALETTE } from "./tagPageModel";
import type { TagRemoteStatus } from "./useTagCatalog";

export function TagCatalogControls({
  query,
  color,
  onQueryChange,
  onColorChange,
  resultCount,
  hasActiveView,
  hiddenOrphans,
  onReset,
}: {
  query: string;
  color: string;
  onQueryChange: (value: string) => void;
  onColorChange: (value: string) => void;
  resultCount: number;
  hasActiveView: boolean;
  hiddenOrphans: number;
  onReset: () => void;
}): ReactElement {
  return (
    <div className="tags-catalog-controls">
      <div className="tags-catalog-controls-main">
        <input
          type="search"
          aria-label="Search tag names and descriptions"
          className="input tags-search"
          placeholder="Search names and descriptions…"
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          maxLength={256}
          autoComplete="off"
          spellCheck={false}
        />
        <TagColorFilter value={color} onChange={onColorChange} />
        {hasActiveView ? (
          <button type="button" className="btn btn-sm" onClick={onReset}>
            Reset view
          </button>
        ) : null}
      </div>
      <div className="tags-view-summary" role="status" aria-live="polite">
        {resultCount.toLocaleString()} result{resultCount === 1 ? "" : "s"}
        {hiddenOrphans > 0
          ? ` · ${hiddenOrphans.toLocaleString()} orphan${hiddenOrphans === 1 ? "" : "s"} hidden by the active colour filter`
          : ""}
      </div>
    </div>
  );
}

export function TagRemoteNotices({
  catalog,
  taxonomy,
  onRetryCatalog,
  onRetryTaxonomy,
}: {
  catalog: TagRemoteStatus;
  taxonomy: TagRemoteStatus;
  onRetryCatalog: () => void;
  onRetryTaxonomy: () => void;
}): ReactElement {
  return (
    <>
      {catalog.error ? (
        <TagRemoteNotice
          label="tag catalogue"
          status={catalog}
          onRetry={onRetryCatalog}
        />
      ) : null}
      {taxonomy.error ? (
        <TagRemoteNotice
          label="subscriber counts and orphan status"
          status={taxonomy}
          onRetry={onRetryTaxonomy}
        />
      ) : null}
    </>
  );
}

function TagRemoteNotice({
  label,
  status,
  onRetry,
}: {
  label: string;
  status: TagRemoteStatus;
  onRetry: () => void;
}): ReactElement {
  const verified = status.lastVerifiedAt
    ? new Date(status.lastVerifiedAt).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      })
    : null;
  return (
    <div className="notice tags-remote-notice" role="alert">
      <span>
        Couldn&apos;t verify {label}: {status.error}
        {status.stale && verified
          ? ` Last verified data from ${verified} remains visible.`
          : " No values are being inferred."}
      </span>
      <button
        type="button"
        className="btn btn-sm"
        onClick={onRetry}
        disabled={status.loading}
      >
        {status.loading ? "Retrying…" : "Retry"}
      </button>
    </div>
  );
}

function TagColorFilter({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}): ReactElement {
  return (
    <ChoiceGroup
      legend="Filter tags by colour"
      value={value}
      options={[
        { value: "all", label: "All" },
        ...TAG_PALETTE.map((palette) => ({
          value: palette.id,
          label: (
            <>
              <span
                className="tag-swatch"
                style={{ background: palette.bg }}
                aria-hidden="true"
              />
              {palette.label}
            </>
          ),
        })),
      ]}
      onChange={onChange}
      className="tags-color-filter"
      optionClassName="tag-color-filter-option"
    />
  );
}

export function TagAvailabilityNotices({
  writeReason,
  mergeReason,
  deleteReason,
  hasOrphans,
}: {
  writeReason: string | null;
  mergeReason: string | null;
  deleteReason: string;
  hasOrphans: boolean;
}): ReactElement {
  return (
    <>
      {writeReason ? (
        <div
          id="tags-write-availability"
          className="pw-action-status"
          role="status"
        >
          {writeReason}
        </div>
      ) : null}
      {mergeReason ? (
        <div
          id="tags-merge-availability"
          className="pw-action-status"
          role="status"
        >
          {mergeReason}
        </div>
      ) : null}
      <div
        id="tags-delete-availability"
        className="pw-action-status"
        role="status"
      >
        {deleteReason}
      </div>
      {hasOrphans ? (
        <div id="tags-orphan-explanation" className="pw-action-status">
          Orphan tags are applied to subscribers but are not registered in the
          catalogue; registering one adds its colour and description without
          changing subscriber assignments.
        </div>
      ) : null}
    </>
  );
}
