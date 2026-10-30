// SPDX-License-Identifier: AGPL-3.0-only
//
// DMARC aggregate-report monitoring (INBOX-032). Surfaces the parsed rua
// reports the deliverability IMAP poller ingests: aggregate pass/fail counters
// plus a per-source-IP alignment table for the latest report. Pure server
// component — the parent page fetches `stats` + `detail` and passes them in.

import { ShieldCheck } from "lucide-react";

import { RelativeTime } from "@/components/relative-time";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import type { DmarcStats, ReportDetail } from "@/lib/inbox-reality-types";

type BadgeVariant = "success" | "warning" | "destructive" | "outline";

// DMARC/DKIM/SPF result strings → a semantic badge variant.
function resultVariant(result: string): BadgeVariant {
  const value = result.toLowerCase();
  if (value === "pass") return "success";
  if (value === "fail") return "destructive";
  return "outline";
}

// Applied policy disposition → a semantic badge variant. `none` means the
// message was delivered despite any failure (monitoring), so it reads neutral.
function dispositionVariant(disposition: string): BadgeVariant {
  const value = disposition.toLowerCase();
  if (value === "reject") return "destructive";
  if (value === "quarantine") return "warning";
  return "outline";
}

function StatTile({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md border px-3 py-2">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-lg font-semibold tabular-nums">
        {value.toLocaleString()}
      </div>
    </div>
  );
}

export function DmarcMonitoring({
  stats,
  detail,
}: {
  stats: DmarcStats | null;
  detail: ReportDetail | null;
}) {
  // A failed statistics read says nothing about whether reports exist.
  if (stats === null) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>DMARC monitoring unavailable</CardTitle>
          <CardDescription>
            Report availability could not be verified.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <p role="alert" className="text-sm text-muted-foreground">
            DMARC statistics could not be loaded. Refresh this page to try
            again.
          </p>
        </CardContent>
      </Card>
    );
  }
  // Only a successful zero-report response proves this empty state.
  if (stats.total_reports === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>DMARC monitoring</CardTitle>
          <CardDescription>
            Aggregate (rua) report analysis for your sending domain.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <EmptyState
            icon={ShieldCheck}
            title="No DMARC reports yet"
            description="Once your rua reporting mailbox receives aggregate reports, per-source-IP alignment will appear here."
          />
        </CardContent>
      </Card>
    );
  }

  const report = detail?.report ?? null;
  const hasRecords = detail !== null && detail.records.length > 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle>DMARC monitoring</CardTitle>
        <CardDescription>
          {report ? (
            <>
              {report.domain} · policy p={report.policy_p || "none"} · latest
              report <RelativeTime iso={report.date_range_end} />
            </>
          ) : (
            "Aggregate (rua) report analysis for your sending domain."
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap gap-3">
          <StatTile label="Reports" value={stats.total_reports} />
          <StatTile label="Messages evaluated" value={stats.total_count} />
          <StatTile label="DKIM pass" value={stats.dkim_pass} />
          <StatTile label="DKIM fail" value={stats.dkim_fail} />
          <StatTile label="SPF pass" value={stats.spf_pass} />
          <StatTile label="SPF fail" value={stats.spf_fail} />
          <StatTile label="Fully aligned" value={stats.pass_count} />
          <StatTile label="Failing" value={stats.fail_count} />
        </div>

        {hasRecords ? (
          <div
            role="region"
            aria-label="Per-source-IP DMARC alignment"
            tabIndex={0}
            className="overflow-x-auto rounded-md border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
                <tr>
                  <th scope="col" className="px-3 py-2 font-medium">
                    Source IP
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    Messages
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    Disposition
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    DKIM
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    SPF
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    Header From
                  </th>
                </tr>
              </thead>
              <tbody>
                {detail.records.map((record) => (
                  <tr key={record.id} className="border-t">
                    {/* The source IP is the row header: every other cell is a
                        verdict about that sender, and without it a screen
                        reader reads "pass / fail / none" with no subject. */}
                    <th
                      scope="row"
                      className="px-3 py-2 text-left font-mono text-xs font-normal"
                    >
                      {record.source_ip}
                    </th>
                    <td className="px-3 py-2 tabular-nums">
                      {record.count.toLocaleString()}
                    </td>
                    <td className="px-3 py-2">
                      <Badge variant={dispositionVariant(record.disposition)}>
                        {record.disposition || "none"}
                      </Badge>
                    </td>
                    <td className="px-3 py-2">
                      <Badge variant={resultVariant(record.dkim_result)}>
                        {record.dkim_result || "—"}
                      </Badge>
                    </td>
                    <td className="px-3 py-2">
                      <Badge variant={resultVariant(record.spf_result)}>
                        {record.spf_result || "—"}
                      </Badge>
                    </td>
                    <td className="px-3 py-2">{record.header_from || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            Per-source-IP alignment for the latest report is unavailable right
            now.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
