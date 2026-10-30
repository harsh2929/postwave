/**
 * BlocklistHitsTable — recent Spamhaus / SBL / SURBL / etc. hits.
 *
 * Each row exposes the identifier (IP/domain/URL), the list that flagged
 * it, when it was first seen, and a delist button when the blocklist
 * provides a public delisting URL.
 *
 * GAP-LS-113 (blocklist visibility surface).
 */

import type { ReactElement } from "react";

import type { BlocklistHit } from "../../lib/api-client";
import { ExternalLink } from "../ExternalLink";
import { DataTable, type DataTableColumn } from "../table/DataTable";

interface Props {
  rows: BlocklistHit[] | null;
  loading: boolean;
}

function statusBadge(status: string | undefined): ReactElement {
  const s = (status ?? "").toLowerCase();
  if (s === "delisted") return <span className="badge success">Delisted</span>;
  if (s === "in_progress")
    return <span className="badge accent">In progress</span>;
  if (s === "pending") return <span className="badge warn">Pending</span>;
  return <span className="badge">Not started</span>;
}

export function BlocklistHitsTable({ rows, loading }: Props): ReactElement {
  const columns: readonly DataTableColumn<BlocklistHit>[] = [
    {
      id: "list",
      header: "List",
      width: "120px",
      cell: (row) => <span style={{ fontWeight: 500 }}>{row.list_name}</span>,
    },
    {
      id: "identifier",
      header: "Identifier",
      width: "280px",
      cell: (row) => (
        <span
          title={`${row.identifier_type}: ${row.identifier}`}
          className="pw-table-truncate mono"
        >
          <span className="muted">{row.identifier_type}: </span>
          {row.identifier}
        </span>
      ),
    },
    {
      id: "first-seen",
      header: "First seen",
      width: "110px",
      cell: (row) => (
        <span className="muted tabular" style={{ fontSize: 12 }}>
          {new Date(row.first_seen_at).toLocaleDateString()}
        </span>
      ),
    },
    {
      id: "status",
      header: "Status",
      width: "130px",
      cell: (row) => statusBadge(row.delisting_status),
    },
    {
      id: "actions",
      header: <span className="visually-hidden">Actions</span>,
      width: "110px",
      align: "end",
      cell: (row) =>
        row.delist_url ? (
          <ExternalLink className="btn btn-sm" href={row.delist_url}>
            Delist
          </ExternalLink>
        ) : (
          <span className="muted">—</span>
        ),
    },
  ];
  return (
    <div className="card" style={{ padding: 16 }}>
      <DataTable
        caption="Blocklist hits"
        description="Last 30 days · Spamhaus / SURBL / SBL / Composite"
        columns={columns}
        rows={rows ?? []}
        getRowKey={(row) => String(row.id)}
        loading={loading}
        loadingLabel="Loading blocklist hits…"
        emptyState="No blocklist hits in the last 30 days."
        density="compact"
      />
    </div>
  );
}
