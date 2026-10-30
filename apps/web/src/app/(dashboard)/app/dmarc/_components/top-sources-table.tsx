// SPDX-License-Identifier: AGPL-3.0-only
"use client";

/**
 * The server-ranked sending sources from one insights snapshot.
 *
 * Mirrors desktop components/dmarc/DmarcTopSourcesTable.tsx. The ranking is
 * whatever the insights response carried — the server's top N, not an
 * inventory — so the caller says whether it is partial. Each IP opens its
 * per-report evidence; when `onSelect` is withheld (the rows belong to a
 * previous scope while a new one loads) the IP renders as plain text so a
 * click can never request one scope's source against another scope.
 */

import {
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  dmarcDispositionLabel,
  dmarcSourceAlignedShare,
  type DmarcSource,
} from "@/lib/dmarc-api";
import { cn } from "@/lib/utils";

function alignmentTone(source: DmarcSource): string {
  if (source.messages === 0) return "text-muted-foreground";
  if (source.alignedPct >= 0.995) return "text-success";
  if (source.alignedPct >= 0.9) return "text-warning";
  return "text-destructive";
}

export function DmarcTopSourcesTable({
  id,
  title,
  description,
  sources,
  emptyState,
  onSelect,
}: {
  id: string;
  title: string;
  description: string;
  sources: readonly DmarcSource[];
  emptyState: string;
  onSelect?: (source: DmarcSource) => void;
}) {
  return (
    <div className="mt-4">
      <h3 id={id} className="text-sm font-medium">
        {title}
      </h3>
      <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
      {sources.length === 0 ? (
        <p className="mt-2 text-sm text-muted-foreground">{emptyState}</p>
      ) : (
        <TableContainer aria-labelledby={id} className="mt-2">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Source IP</TableHead>
                <TableHead className="text-right">Messages</TableHead>
                <TableHead className="text-right">Aligned</TableHead>
                <TableHead>Primary policy action</TableHead>
                <TableHead>Envelope-from domain</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sources.map((source) => (
                <TableRow key={source.sourceIp}>
                  <TableCell>
                    {onSelect ? (
                      <button
                        type="button"
                        className="font-mono text-left text-sm underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        onClick={() => onSelect(source)}
                        aria-label={`Open aggregate evidence for source ${source.sourceIp}`}
                      >
                        {source.sourceIp}
                      </button>
                    ) : (
                      <code className="text-sm">{source.sourceIp}</code>
                    )}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {source.messages.toLocaleString()}
                  </TableCell>
                  <TableCell
                    className={cn("text-right tabular-nums", alignmentTone(source))}
                  >
                    {dmarcSourceAlignedShare(source.alignedPct, source.messages) ??
                      "Not observed"}
                  </TableCell>
                  <TableCell>
                    {dmarcDispositionLabel(source.primaryDisposition)}
                  </TableCell>
                  <TableCell>
                    {source.envelopeFromDomain ? (
                      <code className="break-all text-xs">
                        {source.envelopeFromDomain}
                      </code>
                    ) : (
                      <span className="text-muted-foreground">
                        Not reported
                      </span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}
    </div>
  );
}
