import type { ReactElement } from "react";

import { Notice } from "../../components/Notice";
import { SubscriberNaturalLanguageSegmentPanel } from "../../components/subscribers/SubscriberNaturalLanguageSegmentPanel";
import type { SavedSegment } from "../../lib/api-client";
import { fmtDate } from "../../lib/format-date";
import type { SubscribersPageController } from "./useSubscribersPageController";

export function SubscribersSegmentsPanels({
  controller,
  onOpenDirectory,
}: {
  controller: SubscribersPageController;
  onOpenDirectory: () => void;
}): ReactElement {
  const { saved, state } = controller;
  const applySegment = async (segment: SavedSegment): Promise<void> => {
    if (await saved.applySavedSegment(segment)) onOpenDirectory();
  };
  return (
    <>
      <section
        className="subscribers-surface"
        aria-labelledby="subscribers-saved-segments-heading"
      >
        <div className="subscribers-surface-heading">
          <div>
            <h3 id="subscribers-saved-segments-heading">
              Saved Directory views
            </h3>
            <p>
              Save and reopen Directory filters as reusable views. Exact,
              targetable audiences created in the studio below live in Segments
              and keep their full rule tree.
            </p>
          </div>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => {
              if (controller.canMutate) saved.openSaveCurrent();
            }}
            aria-disabled={!controller.canMutate || undefined}
            aria-describedby={
              controller.canMutate
                ? undefined
                : "subscribers-save-segment-unavailable"
            }
          >
            Save current view…
          </button>
        </div>
        {!controller.canMutate ? (
          <p
            id="subscribers-save-segment-unavailable"
            className="muted"
            role="status"
          >
            Viewer access can apply existing segments but cannot create or
            delete them.
          </p>
        ) : null}
        {saved.savedSegmentsLoading ? (
          <div className="subscribers-quiet-empty" role="status">
            <strong>Loading saved Directory views…</strong>
            <span>Confirming reusable views for this workspace.</span>
          </div>
        ) : saved.savedSegmentsError ? (
          <Notice
            tone="warning"
            title="Saved Directory views are unavailable"
            action={
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => void saved.loadSavedSegments()}
              >
                Try again
              </button>
            }
          >
            {saved.savedSegmentsError} The directory and current filters remain
            available.
          </Notice>
        ) : saved.savedSegments.length === 0 ? (
          <div className="subscribers-quiet-empty">
            <strong>No saved Directory views yet</strong>
            <span>
              Apply filters in Directory and save that reusable view. Use the
              studio below to create an exact audience in Segments.
            </span>
          </div>
        ) : (
          <div className="subscribers-saved-grid">
            {saved.savedSegments.map((segment) => (
              <article key={segment.id} className="subscribers-saved-card">
                <div>
                  <h4>{segment.name}</h4>
                  <p>
                    {segment.description?.trim() ||
                      "Reusable subscriber view with no description."}
                  </p>
                  <span className="muted">
                    Updated {fmtDate(segment.updated_at)}
                  </span>
                </div>
                <div className="subscribers-saved-card-actions">
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => void applySegment(segment)}
                  >
                    Open in Directory
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm btn-ghost"
                    aria-disabled={!controller.canMutate || undefined}
                    aria-describedby={
                      controller.canMutate
                        ? undefined
                        : "subscribers-save-segment-unavailable"
                    }
                    onClick={() => {
                      if (controller.canMutate) {
                        saved.setPendingSegmentDelete(segment);
                      }
                    }}
                  >
                    Delete
                  </button>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>
      <SubscriberNaturalLanguageSegmentPanel
        canMutate={controller.canMutate}
        status={state.filter}
        query={state.query}
        onSaved={() => undefined}
      />
    </>
  );
}
