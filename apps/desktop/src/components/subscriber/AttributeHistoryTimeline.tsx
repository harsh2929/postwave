/**
 * AttributeHistoryTimeline — SUB-008 temporal attribute history.
 *
 * Renders the per-field before/after change log for a subscriber: a
 * timeline of "status changed from enabled to disabled", "custom_fields.phone
 * changed from 555-1234 to 555-5678", etc. Each row carries a timestamp and
 * the change source (subscriber_upsert / subscriber_update / manual).
 *
 * Backed by GET /api/v1/subscribers/{id}/attribute-history
 * (apps/api/internal/subscribers/attribute_history.go), paged newest-first
 * via a `before` cursor. The endpoint 404s on older deployments; the parent
 * gates rendering and this component degrades to an honest empty state.
 */
import { type ReactElement, useEffect, useState } from "react";

import {
  type SubscriberAttributeHistoryEvent,
  listSubscriberAttributeHistory,
} from "../../lib/api-client";
import { fmtDate } from "../../lib/format-date";

interface Props {
  subscriberId: string | number;
  /** Fired when the endpoint 404s so the parent can hide the tab/notice. */
  onUnavailable?: () => void;
}

const PAGE_SIZE = 50;

/** Human-readable label for the change source verb. */
function sourceLabel(source: string): string {
  switch (source) {
    case "subscriber_upsert":
      return "Upsert";
    case "subscriber_update":
      return "Update";
    case "manual":
      return "Manual";
    default:
      return source || "—";
  }
}

/** A nullable before/after value rendered as a literal or an em-dash. */
function valueChip(v: string | null): ReactElement {
  if (v == null) {
    return (
      <span className="muted" style={{ fontStyle: "italic" }}>
        (none)
      </span>
    );
  }
  if (v === "") {
    return (
      <span className="muted" style={{ fontStyle: "italic" }}>
        (empty)
      </span>
    );
  }
  return (
    <code
      style={{
        fontSize: 11,
        fontFamily: "var(--pw-font-mono)",
        wordBreak: "break-word",
      }}
    >
      {v}
    </code>
  );
}

/**
 * Pretty field name: "custom_fields.phone" → "Custom field · phone",
 * "status" → "Status". Keeps the raw dotted key visible for jsonb keys so
 * operators can map it back to the registry.
 */
function fieldLabel(field: string): string {
  const dot = field.indexOf(".");
  if (dot === -1) {
    return field
      .split("_")
      .map((p) => (p ? p[0]!.toUpperCase() + p.slice(1) : p))
      .join(" ");
  }
  const prefix = field.slice(0, dot);
  const key = field.slice(dot + 1);
  const prettyPrefix =
    prefix === "custom_fields"
      ? "Custom field"
      : prefix === "merge_fields"
        ? "Merge field"
        : prefix;
  return `${prettyPrefix} · ${key}`;
}

export function AttributeHistoryTimeline(props: Props): ReactElement {
  const subscriberKey = `${typeof props.subscriberId}:${String(props.subscriberId)}`;
  return <AttributeHistoryTimelineState key={subscriberKey} {...props} />;
}

function AttributeHistoryTimelineState({
  subscriberId,
  onUnavailable,
}: Props): ReactElement {
  const [items, setItems] = useState<SubscriberAttributeHistoryEvent[] | null>(
    null,
  );
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [reloadNonce, setReloadNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setErr(null);
    setLoading(true);
    void (async () => {
      const res = await listSubscriberAttributeHistory(subscriberId, {
        limit: PAGE_SIZE,
      });
      if (cancelled) return;
      setLoading(false);
      if (res.error) {
        if (res.error.kind === "http" && res.error.status === 404) {
          onUnavailable?.();
          setItems([]);
          return;
        }
        setErr(res.error.message);
        return;
      }
      setItems(res.data.items ?? []);
      setCursor(res.data.next_cursor || undefined);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadNonce, subscriberId]);

  const loadMore = async (): Promise<void> => {
    if (!cursor) return;
    setLoadingMore(true);
    const res = await listSubscriberAttributeHistory(subscriberId, {
      limit: PAGE_SIZE,
      before: cursor,
    });
    setLoadingMore(false);
    if (res.error) {
      setErr(res.error.message);
      return;
    }
    setItems((prev) => [...(prev ?? []), ...(res.data.items ?? [])]);
    setCursor(res.data.next_cursor || undefined);
  };

  if (loading && items === null) {
    return <div className="skel" style={{ height: 60 }} />;
  }

  if (err && (!items || items.length === 0)) {
    return (
      <div className="notice" role="alert" style={{ fontSize: 12 }}>
        <span>Couldn&apos;t load attribute history: {err}</span>
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => setReloadNonce((current) => current + 1)}
        >
          Retry history
        </button>
      </div>
    );
  }

  if (!items || items.length === 0) {
    return (
      <div className="muted" style={{ fontSize: 12 }}>
        No attribute changes recorded yet. Edits to status, custom fields, and
        other mutable attributes appear here.
      </div>
    );
  }

  return (
    <div>
      {err ? (
        <div className="notice" role="alert" style={{ fontSize: 12 }}>
          <span>Couldn&apos;t refresh attribute history: {err}</span>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => setReloadNonce((current) => current + 1)}
          >
            Retry history
          </button>
        </div>
      ) : null}
      <ol
        className="timeline"
        style={{ display: "flex", flexDirection: "column", gap: 6 }}
      >
        {items.map((ev) => (
          <li
            key={ev.id}
            style={{
              display: "grid",
              gridTemplateColumns: "1fr auto",
              gap: 6,
              padding: "6px 8px",
              background: "var(--pw-bg-elev-2)",
              borderRadius: 4,
              fontSize: 12,
            }}
          >
            <div style={{ minWidth: 0 }}>
              <div style={{ fontWeight: 500, marginBottom: 2 }}>
                {fieldLabel(ev.field_name)}
              </div>
              <div
                style={{
                  display: "flex",
                  flexWrap: "wrap",
                  alignItems: "center",
                  gap: 4,
                }}
              >
                {valueChip(ev.old_value)}
                <span className="muted" aria-hidden="true">
                  →
                </span>
                {valueChip(ev.new_value)}
              </div>
            </div>
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "flex-end",
                gap: 2,
                whiteSpace: "nowrap",
              }}
            >
              <span
                className="badge"
                style={{ fontSize: 9 }}
                title={`Change source: ${ev.source}`}
              >
                {sourceLabel(ev.source)}
              </span>
              <span
                className="muted tabular"
                style={{ fontSize: 11 }}
                title={ev.changed_at}
              >
                {fmtDate(ev.changed_at)}
              </span>
            </div>
          </li>
        ))}
      </ol>
      {cursor ? (
        <div
          style={{ display: "flex", justifyContent: "center", marginTop: 8 }}
        >
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => void loadMore()}
            disabled={loadingMore}
          >
            {loadingMore ? "Loading…" : "Load more"}
          </button>
        </div>
      ) : null}
    </div>
  );
}
