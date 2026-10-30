/**
 * ActivityTab — unified audit timeline for one list.
 *
 * Wave-2 (GAP-LS-118, 119, 122). Renders subscribes / unsubscribes /
 * imports / exports / merge-field changes / settings edits as a
 * single timeline with sticky date headers, paginated server-side
 * via `listsActivityApi.list`.
 */

import { type ReactElement, useEffect, useMemo, useState } from "react";

import {
  type List,
  type ListActivityEvent,
  listsActivityApi,
} from "../../../lib/api-client";
import { fmtDateTime } from "../../../lib/format-date";

const PAGE_SIZE = 25;

interface Props {
  list: List;
}

const EVENT_LABEL: Record<string, string> = {
  "list.subscriber.added": "Subscribed",
  "list.subscriber.removed": "Removed",
  "list.subscriber.unsubscribed": "Unsubscribed",
  "list.import": "Import",
  "list.export": "Export",
  "list.settings.updated": "Settings updated",
  "list.merge_field.created": "Merge field added",
  "list.merge_field.deleted": "Merge field removed",
};

function eventLabel(type: string): string {
  return EVENT_LABEL[type] ?? type;
}

function dayKey(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function ActivityTab({ list }: Props): ReactElement {
  const [events, setEvents] = useState<ListActivityEvent[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErr(null);
    void (async () => {
      const res = await listsActivityApi.list(list.id, {
        page,
        perPage: PAGE_SIZE,
      });
      if (cancelled) return;
      if (res.error) {
        setErr(res.error.message);
        setEvents([]);
        setTotal(0);
      } else {
        setEvents(res.data?.items ?? []);
        setTotal(res.data?.total ?? 0);
      }
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [list.id, page]);

  // Group events by day for sticky headers.
  const grouped = useMemo<Array<{ day: string; events: ListActivityEvent[] }>>(() => {
    const map = new Map<string, ListActivityEvent[]>();
    for (const ev of events) {
      const k = dayKey(ev.occurred_at);
      const arr = map.get(k) ?? [];
      arr.push(ev);
      map.set(k, arr);
    }
    return Array.from(map.entries()).map(([day, evs]) => ({
      day,
      events: evs,
    }));
  }, [events]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {err ? (
        <div className="notice">
          <span>Couldn&apos;t load activity: {err}</span>
        </div>
      ) : null}

      {loading ? (
        <>
          <div className="skel-row" />
          <div className="skel-row" />
          <div className="skel-row" />
        </>
      ) : events.length === 0 ? (
        <div className="pw-chart-empty">
          No recorded activity for <code>{list.name}</code> yet. Subscribes,
          unsubscribes, imports, exports and settings edits appear here as
          they happen.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {grouped.map(({ day, events: evs }) => (
            <div key={day} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <div
                style={{
                  position: "sticky",
                  top: 0,
                  zIndex: 1,
                  background: "var(--pw-bg-elev)",
                  padding: "4px 0",
                  fontSize: 11,
                  fontWeight: 600,
                  color: "var(--pw-fg-muted)",
                  textTransform: "uppercase",
                  letterSpacing: 0.4,
                  borderBottom: "1px solid var(--pw-border)",
                }}
              >
                {day}
              </div>
              {evs.map((ev) => (
                <div
                  key={ev.id}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "120px 1fr 140px",
                    gap: 8,
                    alignItems: "baseline",
                    padding: "6px 10px",
                    background: "var(--pw-bg-elev-2)",
                    borderRadius: 4,
                    fontSize: 12,
                  }}
                >
                  <span
                    className="badge"
                    style={{ justifySelf: "start" }}
                    title={ev.type}
                  >
                    {eventLabel(ev.type)}
                  </span>
                  <span
                    style={{
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      color: "var(--pw-fg)",
                    }}
                    title={ev.subscriber_email ?? ev.actor ?? ""}
                  >
                    {ev.subscriber_email ?? ev.actor ?? "—"}
                  </span>
                  <span
                    className="muted tabular"
                    style={{ fontSize: 10, textAlign: "right" }}
                    title={ev.occurred_at}
                  >
                    {fmtDateTime(ev.occurred_at)}
                  </span>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}

      {total > PAGE_SIZE ? (
        <div className="pagination">
          <button
            type="button"
            className="btn btn-sm"
            disabled={page <= 1 || loading}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
          >
            Prev
          </button>
          <span>
            Page {page} of {totalPages} · {total.toLocaleString()} event
            {total === 1 ? "" : "s"}
          </span>
          <button
            type="button"
            className="btn btn-sm"
            disabled={page >= totalPages || loading}
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
          >
            Next
          </button>
        </div>
      ) : null}
    </div>
  );
}
