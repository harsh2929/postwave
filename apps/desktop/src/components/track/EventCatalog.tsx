/**
 * EventCatalog — table of distinct event names in this workspace
 * over the selected period. Refined Product Events PR 1.
 *
 * Each row shows: event name, total volume, unique subscribers,
 * first/last seen, and an inline 7-day sparkline. An explicit Filter
 * action narrows the event list below to that event_name.
 *
 * Driven by /api/v1/track/catalog — the heavy lifting is server-side
 * (one GROUP BY query + one per-day series query); the client just
 * renders.
 */

import type { ReactElement } from "react";

import type { ProductEventCatalogRow } from "../../lib/api-client";
import { Sparkline as CompactSparkline } from "../charts/Sparkline";
import { DataTable, type DataTableColumn } from "../table/DataTable";
import { safeAbsoluteTime } from "./track-maturity";

interface Props {
  items: ProductEventCatalogRow[] | null;
  asOf?: string | null;
  loading: boolean;
  error?: string | null;
  stale?: boolean;
  totalDistinctEventNames?: number | null;
  selectedEvent: string;
  onPick: (eventName: string) => void;
}

function fmtRelative(s: string): string {
  const t = new Date(s).getTime();
  if (Number.isNaN(t)) return "invalid time";
  const deltaSeconds = Math.round((t - Date.now()) / 1_000);
  const absolute = Math.abs(deltaSeconds);
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  if (absolute < 60) return formatter.format(deltaSeconds, "second");
  if (absolute < 3_600) {
    return formatter.format(Math.round(deltaSeconds / 60), "minute");
  }
  if (absolute < 86_400) {
    return formatter.format(Math.round(deltaSeconds / 3_600), "hour");
  }
  return formatter.format(Math.round(deltaSeconds / 86_400), "day");
}

function CatalogTime({ value }: { value: string }): ReactElement {
  const valid = Number.isFinite(new Date(value).getTime());
  if (!valid) return <span className="muted">Invalid timestamp</span>;
  return (
    <span className="track-catalog-time">
      <time dateTime={value} className="tabular">
        {safeAbsoluteTime(value)}
      </time>
      <span className="muted">{fmtRelative(value)}</span>
    </span>
  );
}

export function EventCatalog({
  items,
  asOf = null,
  loading,
  error = null,
  stale = false,
  totalDistinctEventNames = null,
  selectedEvent,
  onPick,
}: Props): ReactElement {
  const snapshotSuffix = asOf
    ? ` · independently verified ${safeAbsoluteTime(asOf)}`
    : "";
  const columns: readonly DataTableColumn<ProductEventCatalogRow>[] = [
    {
      id: "event",
      header: "Event",
      width: "210px",
      cell: (row) => <span className="badge accent mono">{row.eventName}</span>,
    },
    {
      id: "volume",
      header: "Volume",
      width: "100px",
      align: "end",
      className: "tabular",
      cell: (row) => (row.count ?? 0).toLocaleString(),
    },
    {
      id: "subscribers",
      header: "Subscribers",
      width: "120px",
      align: "end",
      className: "tabular",
      cell: (row) => (row.uniqueSubscribers ?? 0).toLocaleString(),
    },
    {
      id: "first-seen",
      header: "First in period",
      width: "195px",
      cell: (row) => <CatalogTime value={row.firstSeen} />,
    },
    {
      id: "last-seen",
      header: "Last in period",
      width: "195px",
      cell: (row) => <CatalogTime value={row.lastSeen} />,
    },
    {
      id: "last-seven-days",
      header: "Last 7 UTC days",
      width: "135px",
      cell: (row) => (
        <CompactSparkline
          values={(row.daily ?? []).map((point) => point.count ?? 0)}
          labels={(row.daily ?? []).map((point) => point.date)}
          width={120}
          height={24}
          fill={false}
          color="var(--pw-info)"
          className="track-sparkline"
          valueLabel="events"
          interactive={false}
          ariaLabel={`${row.eventName}, daily event volume across 7 consecutive UTC calendar days`}
        />
      ),
    },
    {
      id: "actions",
      header: <span className="visually-hidden">Filter action</span>,
      width: "110px",
      align: "end",
      cell: (row) => {
        const selected = selectedEvent === row.eventName;
        return (
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            aria-pressed={selected}
            aria-label={
              selected
                ? `Remove the ${row.eventName} event filter`
                : `Filter events to ${row.eventName}`
            }
            onClick={() => onPick(row.eventName)}
          >
            {selected ? "Selected" : "Filter"}
          </button>
        );
      },
    },
  ];
  return (
    <div className="track-catalog">
      {error ? (
        <div className="notice" role="alert" style={{ marginBottom: 8 }}>
          Couldn&apos;t load the event catalog: {error}
        </div>
      ) : null}
      <DataTable
        caption="Event catalog"
        description={
          loading && items
            ? `Refreshing · showing the last verified event catalog${snapshotSuffix}`
            : stale && items
              ? `Refresh failed · showing the last verified event catalog${snapshotSuffix}`
              : selectedEvent
                ? `Distinct product events · filtering the event stream to ${selectedEvent}${snapshotSuffix}`
                : items?.length === 200
                  ? totalDistinctEventNames !== null
                    ? `Top 200 of ${totalDistinctEventNames.toLocaleString()} product event names by volume in the selected UTC reporting period${snapshotSuffix}`
                    : `Top 200 product event names by volume in the selected UTC reporting period · additional names may exist${snapshotSuffix}`
                  : `All ${items?.length.toLocaleString() ?? "verified"} distinct product event names in the selected UTC reporting period${snapshotSuffix}`
        }
        columns={columns}
        rows={items ?? []}
        getRowKey={(row) => row.eventName}
        loading={loading && items === null}
        loadingLabel="Loading the event catalog…"
        emptyState={
          error
            ? "Event catalog data is unavailable. Change the reporting period or retry the page refresh."
            : "No product events yet. POST an event_name and subscriber identifier to /api/v1/track; it will appear here after ingestion."
        }
        density="compact"
        rowClassName={(row) =>
          selectedEvent === row.eventName
            ? "track-catalog-row is-selected"
            : "track-catalog-row"
        }
        columnControls={
          selectedEvent ? (
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              onClick={() => onPick("")}
              aria-label={`Remove the ${selectedEvent} event filter`}
            >
              Showing only: <strong>{selectedEvent}</strong> · clear
            </button>
          ) : undefined
        }
      />
    </div>
  );
}
