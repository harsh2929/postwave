/**
 * DnsHealthTable — per-identity SPF / DKIM / DMARC verification matrix.
 *
 * Mirrors the data shape from `api.listDnsHealth()` but renders inside
 * the DeliverabilityHub layout (compact, no header chrome). Clicking a
 * row jumps the operator to Custom domains via the parent.
 *
 * GAP-LS-136 (DNS health surface on Deliverability Hub).
 */

import type { ReactElement } from "react";

import { type Section, setSection } from "../../lib/store";
import type { DnsHealthStatus } from "../../lib/api-client";
import { DataTable, type DataTableColumn } from "../table/DataTable";

interface Props {
  rows: DnsHealthStatus[] | null;
  loading: boolean;
}

function verifyBadge(state: string, ts?: string | null): ReactElement {
  const s = state.toLowerCase();
  // The DNS worker clears a failed leg's timestamp on every current recheck,
  // and the response boundary rejects a broken row carrying stale timestamps.
  // Keep this overall-state guard as a final presentation fail-safe.
  if (s === "broken") return <span className="badge danger">Check DNS</span>;
  if (ts) return <span className="badge success">Verified</span>;
  if (s.includes("fail")) return <span className="badge danger">Failed</span>;
  if (s.includes("pend")) return <span className="badge warn">Pending</span>;
  return <span className="badge">Not set</span>;
}

export function DnsHealthTable({ rows, loading }: Props): ReactElement {
  const columns: readonly DataTableColumn<DnsHealthStatus>[] = [
    {
      id: "domain",
      header: "Domain",
      width: "260px",
      cell: (row) => (
        <span className="pw-table-truncate" title={row.domain}>
          <span style={{ fontWeight: 500 }}>{row.domain}</span>
          {row.is_stale ? (
            <span
              className="badge warn"
              style={{ marginLeft: 6, fontSize: 10 }}
              title={`Last check ${row.hours_since_last_check}h ago`}
            >
              Stale
            </span>
          ) : null}
        </span>
      ),
    },
    {
      id: "spf",
      header: "SPF",
      width: "90px",
      cell: (row) => verifyBadge(row.verify_state, row.spf_verified_at),
    },
    {
      id: "dkim",
      header: "DKIM",
      width: "90px",
      cell: (row) => verifyBadge(row.verify_state, row.dkim_verified_at),
    },
    {
      id: "dmarc",
      header: "DMARC",
      width: "90px",
      cell: (row) => verifyBadge(row.verify_state, row.dmarc_verified_at),
    },
    {
      id: "state",
      header: "State",
      width: "100px",
      cell: (row) => (
        <span
          className="muted"
          style={{ fontSize: 12, textTransform: "capitalize" }}
        >
          {row.verify_state}
        </span>
      ),
    },
  ];
  return (
    <div className="card" style={{ padding: 16 }}>
      <DataTable
        caption="DNS health"
        description="SPF · DKIM · DMARC per sending identity"
        columns={columns}
        rows={rows ?? []}
        getRowKey={(row) => String(row.id || row.domain)}
        loading={loading}
        loadingLabel="Loading DNS health…"
        emptyState="No sending identities configured yet."
        density="compact"
        columnControls={
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => setSection("domains" as Section)}
          >
            Manage
          </button>
        }
      />
    </div>
  );
}
