/**
 * CrossChannelTimeline — email + SMS merged activity feed for the
 * subscriber slideover (R3: GET /subscribers/{id}/cross-channel-
 * timeline). Server merges the channels and pages by keyset:
 * `before` (RFC3339Nano cursor) ← `next_before` from the previous
 * page; `has_more` gates the "Load older" button.
 *
 * 404 (unknown subscriber or routes not mounted) → `onUnavailable()`
 * so the parent can fall back to the email-only timeline.
 */

import {
  type ReactElement,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import {
  type CrossChannelTimelineItem,
  analyticsExtrasApi,
} from "../../lib/api-client";
import { fmtDate } from "../../lib/format-date";
import {
  appendTimelinePage,
  channelBadge,
  timelineItemKey,
  timelineItemText,
} from "./cross-channel-helpers";

interface Props {
  /** Subscriber UUID or email (the endpoint accepts both). */
  subscriberIdOrEmail: string;
  onUnavailable?: () => void;
  /** Page size — server default applies when omitted. */
  pageSize?: number;
}

export function CrossChannelTimeline({
  subscriberIdOrEmail,
  onUnavailable,
  pageSize = 50,
}: Props): ReactElement {
  const [items, setItems] = useState<CrossChannelTimelineItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [errMsg, setErrMsg] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [nextBefore, setNextBefore] = useState<string | undefined>(undefined);
  const [loadingMore, setLoadingMore] = useState(false);
  const activeRef = useRef(true);
  const initialBusyRef = useRef(false);
  const initialSeqRef = useRef(0);
  const pageBusyRef = useRef(false);
  const pageSeqRef = useRef(0);
  const unavailableRef = useRef(onUnavailable);

  useEffect(() => {
    unavailableRef.current = onUnavailable;
  }, [onUnavailable]);

  useEffect(() => {
    activeRef.current = true;
    return () => {
      activeRef.current = false;
      initialSeqRef.current += 1;
      pageSeqRef.current += 1;
      initialBusyRef.current = false;
      pageBusyRef.current = false;
    };
  }, []);

  const loadInitial = useCallback(async (): Promise<void> => {
    if (initialBusyRef.current) return;
    initialBusyRef.current = true;
    const request = ++initialSeqRef.current;
    pageSeqRef.current += 1;
    pageBusyRef.current = false;
    setLoading(true);
    setLoadingMore(false);
    setErrMsg(null);
    setItems([]);
    setHasMore(false);
    setNextBefore(undefined);
    try {
      const result = await analyticsExtrasApi.crossChannelTimeline(
        subscriberIdOrEmail,
        { limit: pageSize },
      );
      if (!activeRef.current || request !== initialSeqRef.current) return;
      if (result.error) {
        if (result.error.kind === "http" && result.error.status === 404) {
          unavailableRef.current?.();
          setErrMsg("Cross-channel timeline unavailable");
        } else {
          setErrMsg(result.error.message);
        }
        return;
      }
      setItems(result.data.items ?? []);
      setHasMore(Boolean(result.data.has_more));
      setNextBefore(result.data.next_before);
    } catch (error) {
      if (activeRef.current && request === initialSeqRef.current) {
        setErrMsg(
          error instanceof Error && error.message
            ? error.message
            : "Cross-channel timeline could not be loaded.",
        );
      }
    } finally {
      if (activeRef.current && request === initialSeqRef.current) {
        initialBusyRef.current = false;
        setLoading(false);
      }
    }
  }, [pageSize, subscriberIdOrEmail]);

  useEffect(() => {
    initialSeqRef.current += 1;
    pageSeqRef.current += 1;
    initialBusyRef.current = false;
    pageBusyRef.current = false;
    void loadInitial();
  }, [loadInitial]);

  const loadOlder = async (): Promise<void> => {
    if (!nextBefore || pageBusyRef.current) return;
    pageBusyRef.current = true;
    const request = ++pageSeqRef.current;
    const cursor = nextBefore;
    setLoadingMore(true);
    setErrMsg(null);
    try {
      const result = await analyticsExtrasApi.crossChannelTimeline(
        subscriberIdOrEmail,
        { limit: pageSize, before: cursor },
      );
      if (!activeRef.current || request !== pageSeqRef.current) return;
      if (result.error) {
        setErrMsg(result.error.message);
        return;
      }
      setItems((prev) => appendTimelinePage(prev, result.data.items ?? []));
      setHasMore(Boolean(result.data.has_more));
      setNextBefore(result.data.next_before);
    } catch (error) {
      if (activeRef.current && request === pageSeqRef.current) {
        setErrMsg(
          error instanceof Error && error.message
            ? error.message
            : "Older activity could not be loaded.",
        );
      }
    } finally {
      if (activeRef.current && request === pageSeqRef.current) {
        pageBusyRef.current = false;
        setLoadingMore(false);
      }
    }
  };

  if (loading) {
    return (
      <div style={{ padding: 4 }} role="status" aria-live="polite">
        <span className="visually-hidden">Loading email and SMS activity…</span>
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

  if (errMsg && items.length === 0) {
    return (
      <div className="notice" role="alert" style={{ fontSize: 12 }}>
        <span>Couldn&apos;t load email and SMS activity: {errMsg}</span>
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => void loadInitial()}
        >
          Retry
        </button>
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="muted" style={{ fontSize: 12 }}>
        No email or SMS activity recorded for this subscriber.
      </div>
    );
  }

  return (
    <>
      <ol
        className="timeline"
        style={{ display: "flex", flexDirection: "column", gap: 6 }}
      >
        {items.map((it) => {
          const badge = channelBadge(it.channel);
          return (
            <li
              key={timelineItemKey(it)}
              style={{
                display: "flex",
                flexWrap: "wrap",
                gap: 8,
                alignItems: "baseline",
                padding: "6px 8px",
                background: "var(--pw-bg-elev-2)",
                borderRadius: 4,
                fontSize: 12,
              }}
            >
              <span
                className="badge"
                style={{
                  fontSize: 9,
                  textAlign: "center",
                  color: badge.color,
                  borderColor: `color-mix(in srgb, ${badge.color} 40%, transparent)`,
                }}
              >
                {badge.label}
              </span>
              <div style={{ minWidth: 0, flex: "1 1 180px" }}>
                <div
                  style={{
                    overflowWrap: "anywhere",
                  }}
                >
                  {timelineItemText(it)}
                </div>
                {it.detail ? (
                  <div
                    className="muted"
                    style={{
                      fontSize: 11,
                      overflowWrap: "anywhere",
                    }}
                  >
                    {it.detail}
                  </div>
                ) : null}
              </div>
              <time
                className="muted tabular"
                style={{ fontSize: 11, whiteSpace: "nowrap" }}
                dateTime={it.at}
              >
                {fmtDate(it.at)}
              </time>
            </li>
          );
        })}
      </ol>
      {errMsg ? (
        <div className="field-error" role="alert" style={{ marginTop: 6 }}>
          {errMsg}
        </div>
      ) : null}
      {hasMore ? (
        <div style={{ marginTop: 8 }}>
          <button
            type="button"
            className="btn"
            onClick={() => void loadOlder()}
            disabled={loadingMore || !nextBefore}
            aria-busy={loadingMore || undefined}
          >
            {loadingMore ? "Loading…" : "Load older"}
          </button>
        </div>
      ) : null}
    </>
  );
}
