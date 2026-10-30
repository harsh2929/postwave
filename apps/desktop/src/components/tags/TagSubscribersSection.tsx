import type { ReactElement } from "react";

import type { TagSubscriber } from "../../lib/api-client";
import { navigateDesktopSectionResource } from "../../lib/desktop-router";

interface Props {
  tagName: string;
  count: number | null;
  subscribers: TagSubscriber[] | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
}

export function TagSubscribersSection({
  tagName,
  count,
  subscribers,
  loading,
  error,
  onRetry,
}: Props): ReactElement {
  return (
    <section className="tag-detail-section" aria-labelledby="tag-members-title">
      <div className="tag-detail-section-header">
        <h3 id="tag-members-title" className="label">
          Verified member sample for {tagName}
        </h3>
        <button
          type="button"
          className="btn btn-sm pw-discoverable-unavailable"
          aria-disabled="true"
          aria-describedby="tag-member-directory-unavailable"
          onClick={(event) => event.preventDefault()}
        >
          Open filtered directory
        </button>
      </div>
      <p id="tag-member-directory-unavailable" className="field-help">
        A tag-filtered Subscribers route is not available yet. Open an
        individual verified subscriber below instead.
      </p>
      {loading ? (
        <div className="muted" role="status">
          {subscribers === null
            ? "Loading subscribers…"
            : "Refreshing subscribers; last verified rows remain visible."}
        </div>
      ) : null}
      {error ? (
        <div className="notice notice-danger tags-inline-error" role="alert">
          <span>{error}</span>
          <button
            type="button"
            className="btn btn-sm"
            onClick={onRetry}
            disabled={loading}
          >
            {loading ? "Retrying…" : "Retry"}
          </button>
        </div>
      ) : null}
      {subscribers === null ? null : subscribers.length === 0 ? (
        <div className="muted">No verified subscribers carry this tag.</div>
      ) : (
        <div className="tag-subs-list">
          {subscribers.slice(0, 50).map((subscriber) => (
            <button
              key={subscriber.id}
              type="button"
              className="tag-sub-row"
              aria-label={`Open ${subscriber.email} in Subscribers`}
              onClick={() =>
                navigateDesktopSectionResource("subscribers", subscriber.id)
              }
            >
              <span className="tag-sub-email">{subscriber.email}</span>
              <span className="muted">{subscriber.status}</span>
            </button>
          ))}
          {count !== null && count > 50 ? (
            <div className="muted tags-member-overflow">
              {count - 50} more. The server currently returns only the first 50
              verified members.
            </div>
          ) : null}
        </div>
      )}
      {count === null ? (
        <p className="field-help">Total membership is currently unverified.</p>
      ) : null}
    </section>
  );
}
