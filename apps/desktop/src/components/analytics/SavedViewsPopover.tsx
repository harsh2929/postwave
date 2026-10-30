import {
  type FocusEventHandler,
  type ReactElement,
  type RefObject,
} from "react";

import {
  type SavedView,
  type SavedViewsStorage,
} from "./saved-views-storage";

interface Props {
  popoverRef: RefObject<HTMLDivElement | null>;
  popoverId: string;
  headingId: string;
  descriptionId: string;
  storageStatusId: string;
  storage: SavedViewsStorage;
  statusMessage: string | null;
  canMutate: boolean;
  onBlur: FocusEventHandler<HTMLDivElement>;
  onApply: (view: SavedView) => void;
  onDelete: (view: SavedView, index: number) => void;
  onCreate: () => void;
}

export function SavedViewsPopover({
  popoverRef,
  popoverId,
  headingId,
  descriptionId,
  storageStatusId,
  storage,
  statusMessage,
  canMutate,
  onBlur,
  onApply,
  onDelete,
  onCreate,
}: Props): ReactElement {
  return (
    <div
      ref={popoverRef}
      id={popoverId}
      role="dialog"
      aria-modal="false"
      aria-labelledby={headingId}
      aria-describedby={descriptionId}
      className="analytics-popup analytics-popup--saved-views"
      onBlurCapture={onBlur}
    >
      <header className="analytics-saved-views-header">
        <h2 id={headingId} className="analytics-popup-heading">
          Saved analytics views
        </h2>
        <p id={descriptionId} className="analytics-popup-description">
          Apply or remove encrypted views for this account on this device.
        </p>
      </header>
      {statusMessage ? (
        <p
          id={storageStatusId}
          className="analytics-saved-views-empty"
          role={storage.unavailable ? "alert" : "status"}
        >
          {statusMessage}
        </p>
      ) : null}
      {!storage.loading && !storage.unavailable && storage.views.length === 0 ? (
        <p className="analytics-saved-views-empty">No saved views yet.</p>
      ) : null}
      {storage.views.length > 0 ? (
        <ul className="analytics-saved-views-list">
          {storage.views.map((view, index) => (
            <li key={view.id} className="analytics-saved-view-row">
              <button
                type="button"
                data-saved-view-action
                data-saved-view-apply
                className="analytics-saved-view-apply"
                onClick={() => onApply(view)}
              >
                <span className="analytics-saved-view-name">{view.name}</span>
                <span className="analytics-saved-view-context">
                  {view.range} · {view.vsPrevious ? "compare" : "absolute"}
                </span>
              </button>
              <button
                type="button"
                data-saved-view-action
                className="analytics-saved-view-delete"
                aria-label={`Delete saved view ${view.name}`}
                aria-disabled={storage.busy || undefined}
                onClick={() => {
                  if (!storage.busy) onDelete(view, index);
                }}
              >
                <span aria-hidden>×</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {storage.retryable ? (
        <button
          type="button"
          data-saved-view-action
          className="analytics-saved-view-create"
          aria-disabled={storage.busy || undefined}
          onClick={() => {
            if (!storage.busy) storage.retry();
          }}
        >
          Retry encrypted storage
        </button>
      ) : null}
      <button
        type="button"
        data-saved-view-action
        data-saved-view-create
        className="analytics-saved-view-create"
        aria-disabled={!canMutate || undefined}
        aria-describedby={
          !canMutate && statusMessage ? storageStatusId : undefined
        }
        onClick={onCreate}
      >
        + Save current view
      </button>
    </div>
  );
}
