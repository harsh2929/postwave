import { type ReactElement, useEffect, useRef } from "react";

import type { PushSuppressionRow } from "../lib/api/push-suppressions";
import { fmtDate } from "../lib/format-date";
import {
  PUSH_SUPPRESSION_PAGE_SIZE,
  lockedReasonLabel,
  platformLabel,
  reasonLabel,
  rowAuthorityLabel,
  rowCanBeRemoved,
  sourceLabel,
} from "./push-suppression-model";

interface Props {
  rows: readonly PushSuppressionRow[];
  unfilteredPageCount: number;
  total: number;
  pageIndex: number;
  hasNextPage: boolean;
  loading: boolean;
  mutationReady: boolean;
  selectedIds: ReadonlySet<string>;
  onDetail: (row: PushSuppressionRow, trigger: HTMLButtonElement) => void;
  onRemove: (row: PushSuppressionRow, trigger: HTMLButtonElement) => void;
  onToggleSelection: (row: PushSuppressionRow) => void;
  onToggleAll: () => void;
  onClearSelection: () => void;
  onRequestBulkRemove: (trigger: HTMLButtonElement) => void;
  onPrevious: () => void;
  onNext: () => void;
}

function SelectionCheckbox({
  checked,
  mixed = false,
  disabled,
  label,
  onChange,
}: {
  checked: boolean;
  mixed?: boolean;
  disabled: boolean;
  label: string;
  onChange: () => void;
}): ReactElement {
  const inputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (inputRef.current) inputRef.current.indeterminate = mixed;
  }, [mixed]);
  return (
    <label className="push-select-control">
      <input
        ref={inputRef}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={onChange}
        aria-label={label}
      />
    </label>
  );
}

function Badge({ children, tone }: { children: string; tone?: string }): ReactElement {
  return (
    <span className={["push-row-badge", tone].filter(Boolean).join(" ")}>
      {children}
    </span>
  );
}

function PushSuppressionRowCells({
  row,
  mutationReady,
  selectedIds,
  onDetail,
  onRemove,
  onToggleSelection,
}: Pick<
  Props,
  | "mutationReady"
  | "selectedIds"
  | "onDetail"
  | "onRemove"
  | "onToggleSelection"
> & {
  row: PushSuppressionRow;
}): ReactElement {
  const removable = rowCanBeRemoved(row);
  const reasonTone =
    row.reason === "complaint" || row.reason === "unregistered"
      ? "danger"
      : row.reason === "user_opt_out"
        ? "warning"
        : undefined;
  return (
    <tr>
      <td data-label="Select" className="push-select-cell">
        {removable ? (
          <SelectionCheckbox
            checked={selectedIds.has(row.id)}
            disabled={!mutationReady}
            label={`Select suppression ${row.device_token_hash}`}
            onChange={() => onToggleSelection(row)}
          />
        ) : (
          <span className="push-not-selectable" aria-label="Locked row not selectable">
            —
          </span>
        )}
      </td>
      <th scope="row" data-label="Fingerprint">
        <button
          type="button"
          className="push-fingerprint-button"
          onClick={(event) => onDetail(row, event.currentTarget)}
          aria-label={`View details for fingerprint ${row.device_token_hash}`}
        >
          <span className="push-fingerprint tabular">{row.device_token_hash}</span>
          <span className="push-detail-cue" aria-hidden="true">
            Details
          </span>
        </button>
      </th>
      <td data-label="Platform">
        <Badge>{platformLabel(row.platform)}</Badge>
      </td>
      <td data-label="Reason">
        <Badge tone={reasonTone}>{reasonLabel(row.reason)}</Badge>
      </td>
      <td data-label="Provenance">
        <span className="push-source">{sourceLabel(row.source)}</span>
      </td>
      <td data-label="Authority">
        <span className={removable ? "push-authority reversible" : "push-authority locked"}>
          {rowAuthorityLabel(row)}
        </span>
        {!removable && row.locked_reason ? (
          <span className="push-cell-detail">
            {lockedReasonLabel(row.locked_reason)}
          </span>
        ) : null}
      </td>
      <td data-label="Created">
        <time dateTime={row.created_at} className="tabular">
          {fmtDate(row.created_at)}
        </time>
        <span className="push-cell-detail tabular">v{row.version}</span>
      </td>
      <td data-label="Actions" className="push-row-actions">
        <button
          type="button"
          className="btn"
          onClick={(event) => onDetail(row, event.currentTarget)}
        >
          View details
        </button>
        {removable ? (
          <button
            type="button"
            className="btn btn-danger"
            disabled={!mutationReady}
            onClick={(event) => onRemove(row, event.currentTarget)}
            aria-label={`Remove suppression for fingerprint ${row.device_token_hash}`}
          >
            Remove
          </button>
        ) : (
          <span className="push-locked-action" aria-label="Removal unavailable">
            Locked
          </span>
        )}
      </td>
    </tr>
  );
}

export function PushSuppressionDirectory({
  rows,
  unfilteredPageCount,
  total,
  pageIndex,
  hasNextPage,
  loading,
  mutationReady,
  selectedIds,
  onDetail,
  onRemove,
  onToggleSelection,
  onToggleAll,
  onClearSelection,
  onRequestBulkRemove,
  onPrevious,
  onNext,
}: Props): ReactElement {
  const first = pageIndex * PUSH_SUPPRESSION_PAGE_SIZE + 1;
  const last = pageIndex * PUSH_SUPPRESSION_PAGE_SIZE + unfilteredPageCount;
  const eligibleCount = rows.filter(rowCanBeRemoved).length;
  const selectedCount = rows.filter((row) => selectedIds.has(row.id)).length;
  const allSelected = eligibleCount > 0 && selectedCount === eligibleCount;
  const partlySelected = selectedCount > 0 && !allSelected;
  return (
    <section className="push-directory" aria-labelledby="push-directory-title">
      <div className="push-directory-heading">
        <div>
          <h2 id="push-directory-title">Verified suppression authorities</h2>
          <p>
            Showing {first.toLocaleString()}–{last.toLocaleString()} of{" "}
            {total.toLocaleString()}
            {rows.length !== unfilteredPageCount
              ? ` · ${rows.length.toLocaleString()} match the page source filter`
              : ""}
          </p>
        </div>
        {loading ? <span className="push-refreshing">Refreshing…</span> : null}
      </div>
      {selectedCount > 0 ? (
        <div className="push-bulk-toolbar" role="status" aria-live="polite">
          <span>
            <strong>{selectedCount.toLocaleString()}</strong> reversible{" "}
            {selectedCount === 1 ? "authority" : "authorities"} selected from
            this verified view
          </span>
          <div>
            <button
              type="button"
              className="btn"
              disabled={loading}
              onClick={onClearSelection}
            >
              Clear selection
            </button>
            <button
              type="button"
              className="btn btn-danger"
              disabled={!mutationReady}
              onClick={(event) => onRequestBulkRemove(event.currentTarget)}
            >
              Review bulk removal
            </button>
          </div>
        </div>
      ) : null}
      <div className="push-table-shell">
        <table aria-busy={loading ? "true" : undefined}>
          <caption className="sr-only">
            Push token suppression registry. Only privacy-safe fingerprints are
            shown.
          </caption>
          <thead>
            <tr>
              <th scope="col" className="push-select-column">
                <SelectionCheckbox
                  checked={allSelected}
                  mixed={partlySelected}
                  disabled={!mutationReady || eligibleCount === 0}
                  label="Select all reversible rows in this verified view"
                  onChange={onToggleAll}
                />
              </th>
              <th scope="col">Fingerprint</th>
              <th scope="col">Platform</th>
              <th scope="col">Reason</th>
              <th scope="col">Provenance</th>
              <th scope="col">Authority</th>
              <th scope="col">Created</th>
              <th scope="col">Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <PushSuppressionRowCells
                key={row.id}
                row={row}
                mutationReady={mutationReady}
                selectedIds={selectedIds}
                onDetail={onDetail}
                onRemove={onRemove}
                onToggleSelection={onToggleSelection}
              />
            ))}
          </tbody>
        </table>
      </div>
      <nav className="push-pagination" aria-label="Suppression registry pages">
        <button
          type="button"
          className="btn"
          disabled={pageIndex === 0 || loading}
          onClick={onPrevious}
        >
          Previous page
        </button>
        <span aria-current="page">Page {pageIndex + 1}</span>
        <button
          type="button"
          className="btn"
          disabled={!hasNextPage || loading}
          onClick={onNext}
        >
          Next page
        </button>
      </nav>
    </section>
  );
}
