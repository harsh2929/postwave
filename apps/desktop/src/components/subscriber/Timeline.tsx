/**
 * Timeline — vertical event feed for the subscriber drill-down.
 *
 * Loads `/api/v1/subscribers/{id}/timeline` (Go shape lives in
 * apps/api/internal/subscribers/timeline.go) and paginates via the
 * `before` cursor. Stats live in a sibling component above this one;
 * this view focuses on the events.
 *
 * Honest fallback: when the endpoint 404s (mis-deployed gateway), the
 * parent slideover renders the legacy /activity view + a muted
 * "Activity timeline unavailable" message. We surface a `notFound`
 * signal via the `onUnavailable` callback so the parent can swap.
 */
import { type ReactElement, useEffect, useMemo, useRef, useState } from "react";

import {
  type SubscriberTimelineEvent,
  api,
  getSubscriberTimeline,
} from "../../lib/api-client";
import {
  responseIdentityMatches,
  responseIdentityMismatch,
} from "../../lib/api/subscriber-response-integrity";
import { TimelineEvent } from "./TimelineEvent";

interface Props {
  subscriberId: string | number;
  /** Called when the endpoint returns 404 (so the parent can swap to
   * the legacy /activity fallback). */
  onUnavailable?: () => void;
  /** Page size — defaults to 50 (server clamps to [1, 200]). */
  pageSize?: number;
}

export function Timeline({
  subscriberId,
  onUnavailable,
  pageSize = 50,
}: Props): ReactElement {
  const subscriberKey = `${typeof subscriberId}:${String(subscriberId)}`;
  return (
    <TimelineState
      key={subscriberKey}
      subscriberId={subscriberId}
      onUnavailable={onUnavailable}
      pageSize={pageSize}
    />
  );
}

function TimelineState({
  subscriberId,
  onUnavailable,
  pageSize = 50,
}: Props): ReactElement {
  const [events, setEvents] = useState<SubscriberTimelineEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [errMsg, setErrMsg] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [reloadNonce, setReloadNonce] = useState(0);
  const loadingMoreRef = useRef(false);

  // Initial load.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErrMsg(null);
    void (async () => {
      try {
        const res = await getSubscriberTimeline(subscriberId, {
          limit: pageSize,
        });
        if (cancelled) return;
        if (res.error) {
          if (res.error.status === 404) {
            onUnavailable?.();
            setErrMsg("Activity timeline unavailable");
          } else {
            setErrMsg(res.error.message);
          }
          return;
        }
        if (!responseIdentityMatches(subscriberId, res.data.subscriber_id)) {
          setErrMsg(responseIdentityMismatch("subscriber").error.message);
          return;
        }
        setEvents(res.data.events ?? []);
        setHasMore(Boolean(res.data.pagination?.has_more));
      } catch {
        if (!cancelled) {
          setErrMsg(
            "Activity timeline couldn't be loaded. Check your connection and retry.",
          );
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // We intentionally don't depend on `api` (it's a stable singleton);
    // re-running on subscriberId change is the only meaningful trigger.
  }, [subscriberId, pageSize, onUnavailable, reloadNonce]);

  const loadMore = async (): Promise<void> => {
    const last = events.at(-1);
    if (!last || loadingMoreRef.current) return;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    setErrMsg(null);
    try {
      const res = await getSubscriberTimeline(subscriberId, {
        before: last.occurred_at,
        limit: pageSize,
      });
      if (res.error) {
        setErrMsg(res.error.message);
        return;
      }
      if (!responseIdentityMatches(subscriberId, res.data.subscriber_id)) {
        setErrMsg(responseIdentityMismatch("subscriber").error.message);
        return;
      }
      const fresh = res.data.events ?? [];
      setEvents((current) => {
        // The cursor is strict-less-than, but de-duplicate around tied
        // timestamps so a repeated page can never duplicate visible events.
        const seen = new Set(
          current.map(
            (event) =>
              `${event.type}::${event.occurred_at}::${event.subject_id ?? ""}`,
          ),
        );
        return [
          ...current,
          ...fresh.filter(
            (event) =>
              !seen.has(
                `${event.type}::${event.occurred_at}::${event.subject_id ?? ""}`,
              ),
          ),
        ];
      });
      setHasMore(Boolean(res.data.pagination?.has_more));
    } catch {
      setErrMsg(
        "Older activity couldn't be loaded. Check your connection and retry.",
      );
    } finally {
      loadingMoreRef.current = false;
      setLoadingMore(false);
    }
  };

  // Surface the api-client reference so eslint's no-unused-vars stays
  // happy with the explicit re-export above. (The linter already
  // enforces this via tsc --noEmit; keep the symbol live.)
  void api;

  const sorted = useMemo<SubscriberTimelineEvent[]>(() => {
    return [...events].sort(
      (a, b) => Date.parse(b.occurred_at) - Date.parse(a.occurred_at),
    );
  }, [events]);

  if (loading && events.length === 0) {
    return (
      <div style={{ padding: 4 }}>
        {[0, 1, 2, 3].map((i) => (
          <div
            key={i}
            className="skel"
            style={{ height: 14, margin: "6px 0" }}
          />
        ))}
      </div>
    );
  }

  if (errMsg && sorted.length === 0) {
    return (
      <div className="notice" role="alert" style={{ fontSize: 12 }}>
        <span>{errMsg}</span>
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => setReloadNonce((current) => current + 1)}
        >
          Retry timeline
        </button>
      </div>
    );
  }

  if (sorted.length === 0) {
    return (
      <div className="muted" style={{ fontSize: 12 }}>
        No activity recorded for this subscriber.
      </div>
    );
  }

  return (
    <>
      <ol className="timeline">
        {sorted.map((ev, i) => (
          <TimelineEvent
            key={`${ev.type}-${ev.occurred_at}-${ev.subject_id ?? i}`}
            event={ev}
          />
        ))}
      </ol>
      {errMsg ? (
        <div className="field-error" role="alert" style={{ marginTop: 6 }}>
          <span>{errMsg}</span>{" "}
          <button
            type="button"
            className="btn btn-xs"
            onClick={() => setReloadNonce((current) => current + 1)}
          >
            Retry timeline
          </button>
        </div>
      ) : null}
      {hasMore ? (
        <div style={{ marginTop: 8 }}>
          <button
            type="button"
            className="btn"
            onClick={() => void loadMore()}
            disabled={loadingMore}
          >
            {loadingMore ? "Loading…" : "Load more"}
          </button>
        </div>
      ) : null}
    </>
  );
}
