import { type ReactElement, useMemo } from "react";

import type { DmarcSource } from "../../lib/api-client";
import { DataTable, type DataTableColumn } from "../table/DataTable";

interface Props {
  title?: string;
  description?: string;
  emptyState?: string;
  sources: DmarcSource[];
  onSelect?: (source: DmarcSource, trigger: HTMLButtonElement) => void;
}

function formatPercent(source: DmarcSource): string {
  if (source.messages === 0) return "Not observed";
  return `${(source.alignedPct * 100).toFixed(source.alignedPct >= 0.995 ? 2 : 1)}%`;
}

function dispositionLabel(value: string): string {
  if (value === "none") return "Reported none";
  if (value === "quarantine") return "Quarantine";
  if (value === "reject") return "Reject";
  return "Unknown action";
}

export function DmarcTopSourcesTable({
  title = "Top observed sources",
  description = "Ranked by observed message volume.",
  emptyState = "No sources were present in this contract-valid snapshot.",
  sources,
  onSelect,
}: Props): ReactElement {
  const columns = useMemo<readonly DataTableColumn<DmarcSource>[]>(
    () => [
      {
        id: "source",
        header: "Source IP",
        width: "190px",
        cell: (source) =>
          onSelect ? (
            <button
              type="button"
              className="dmarc-table-link mono"
              onClick={(event) => onSelect(source, event.currentTarget)}
              aria-label={`Open aggregate evidence for source ${source.sourceIp}`}
            >
              {source.sourceIp}
            </button>
          ) : (
            <code>{source.sourceIp}</code>
          ),
      },
      {
        id: "messages",
        header: "Messages",
        width: "115px",
        align: "end",
        cell: (source) => source.messages.toLocaleString(),
      },
      {
        id: "aligned",
        header: "Aligned",
        width: "115px",
        align: "end",
        cell: (source) => (
          <span
            className="dmarc-source-alignment"
            data-tone={
              source.messages === 0
                ? "unknown"
                : source.alignedPct >= 0.995
                  ? "positive"
                  : source.alignedPct >= 0.9
                    ? "caution"
                    : "negative"
            }
          >
            {formatPercent(source)}
          </span>
        ),
      },
      {
        id: "policy-action",
        header: "Primary policy action",
        width: "180px",
        cell: (source) => (
          <span
            className="dmarc-policy-action"
            data-action={source.primaryDisposition}
          >
            {dispositionLabel(source.primaryDisposition)}
          </span>
        ),
      },
      {
        id: "envelope-from",
        header: "Envelope-from domain",
        width: "260px",
        cell: (source) =>
          source.envelopeFromDomain ? (
            <code className="dmarc-truncate" title={source.envelopeFromDomain}>
              {source.envelopeFromDomain}
            </code>
          ) : (
            <span className="muted">Not reported</span>
          ),
      },
    ],
    [onSelect],
  );

  return (
    <DataTable
      caption={title}
      description={description}
      columns={columns}
      rows={sources}
      getRowKey={(source) => source.sourceIp}
      density="compact"
      emptyState={emptyState}
      className="dmarc-sources-table"
    />
  );
}
