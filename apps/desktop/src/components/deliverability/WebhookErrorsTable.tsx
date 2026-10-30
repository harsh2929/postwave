/**
 * WebhookErrorsTable — recent outbound webhook delivery failures.
 *
 * Operators use this to spot misconfigured receivers (5xx storms) and
 * decide whether to disable a webhook before its retry budget burns
 * the rest of the queue.
 *
 * GAP-LS-137 (webhook error rate surface).
 */

import type { ReactElement } from "react";

import { type Section, setSection } from "../../lib/store";
import type { WebhookErrorRow } from "../../lib/api-client";
import { DataTable, type DataTableColumn } from "../table/DataTable";

interface Props {
  rows: WebhookErrorRow[] | null;
  loading: boolean;
}

function statusTone(code: number | undefined): string {
  if (!code) return "";
  if (code >= 500) return "danger";
  if (code >= 400) return "warn";
  return "";
}

export function WebhookErrorsTable({ rows, loading }: Props): ReactElement {
  const columns: readonly DataTableColumn<WebhookErrorRow>[] = [
    {
      id: "event",
      header: "Event / URL",
      width: "320px",
      cell: (row) => (
        <div className="pw-table-truncate" title={row.url ?? row.event}>
          <div style={{ fontWeight: 500 }}>{row.event}</div>
          {row.url ? (
            <div
              className="muted mono pw-table-truncate"
              style={{ fontSize: 11 }}
            >
              {row.url}
            </div>
          ) : null}
        </div>
      ),
    },
    {
      id: "error",
      header: "Error",
      width: "160px",
      cell: (row) => (
        <span className="muted pw-table-truncate" title={row.error ?? ""}>
          {row.error || "—"}
        </span>
      ),
    },
    {
      id: "status",
      header: "Status",
      width: "80px",
      cell: (row) =>
        row.status_code ? (
          <span className={`badge ${statusTone(row.status_code)}`}>
            {row.status_code}
          </span>
        ) : (
          <span className="muted">—</span>
        ),
    },
    {
      id: "tries",
      header: "Tries",
      width: "70px",
      align: "end",
      cell: (row) => row.attempt_count,
    },
    {
      id: "last-attempt",
      header: "Last attempt",
      width: "120px",
      cell: (row) => (
        <span className="muted" style={{ fontSize: 12 }}>
          {new Date(row.last_attempt_at).toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
          })}
        </span>
      ),
    },
  ];
  return (
    <div className="card" style={{ padding: 16 }}>
      <DataTable
        caption="Webhook delivery errors"
        description="Last 7 days · outbound receivers"
        columns={columns}
        rows={rows ?? []}
        getRowKey={(row) => String(row.id)}
        loading={loading}
        loadingLabel="Loading webhook delivery errors…"
        emptyState="No webhook delivery failures in the last 7 days."
        density="compact"
        columnControls={
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => setSection("webhooks" as Section)}
          >
            Open Webhooks
          </button>
        }
      />
    </div>
  );
}
