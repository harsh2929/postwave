// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { AEOProbe } from "@/lib/aeo-api";

import { ENGINE_LABEL } from "./aeo-format";

export interface ProbeAuditProps {
  probes: AEOProbe[];
  loading: boolean;
}

/** Read-only audit of the last N probe responses. */
export function ProbeAudit({ probes, loading }: ProbeAuditProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Recent probes</CardTitle>
        <CardDescription>
          The most recent probe responses, newest first.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {loading ? (
          <p role="status" className="text-sm text-muted-foreground">
            Loading recent probes…
          </p>
        ) : probes.length === 0 ? (
          <p className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
            No probes recorded yet. Run a pass after configuring brand terms and
            enabling at least one engine.
          </p>
        ) : (
          <TableContainer aria-label="Recent probe responses">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Engine</TableHead>
                  <TableHead>Mentioned</TableHead>
                  <TableHead>Cited</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Probed at</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {probes.map((p) => (
                  <TableRow key={p.id}>
                    <TableCell>{ENGINE_LABEL[p.engine]}</TableCell>
                    <TableCell>{p.mentioned ? "Yes" : "No"}</TableCell>
                    <TableCell>{p.cited ? "Yes" : "No"}</TableCell>
                    <TableCell className="capitalize">
                      {p.status.replace("_", " ")}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      <time dateTime={p.probed_at}>
                        {new Date(p.probed_at).toLocaleString()}
                      </time>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        )}
      </CardContent>
    </Card>
  );
}
