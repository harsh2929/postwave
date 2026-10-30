// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useState } from "react";
import { Download } from "lucide-react";

import { downloadTextFile } from "@/lib/download";
import { migrationAuditEventLabel } from "@/lib/migration-audit";
import { buildAuditLogCsv } from "@/lib/migration-verification-export";
import type { AuditEntry } from "@/lib/types";
import { RelativeTime } from "@/components/relative-time";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export function AuditCard({ entries }: { entries: AuditEntry[] }) {
  const [showAll, setShowAll] = useState(false);
  if (entries.length === 0) return null;
  const visible = showAll ? entries : entries.slice(0, 5);
  const exportAudit = () => {
    downloadTextFile(
      "migration-audit-log.csv",
      buildAuditLogCsv(entries),
      "text/csv;charset=utf-8",
    );
  };
  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-4">
          <div>
            <CardTitle className="text-base">Activity</CardTitle>
            <CardDescription>
              {entries.length} audit entr{entries.length === 1 ? "y" : "ies"}{" "}
              scoped to this migration.
            </CardDescription>
          </div>
          <Button size="sm" variant="outline" onClick={exportAudit}>
            <Download className="h-3.5 w-3.5" /> Export
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        <ul className="space-y-2">
          {visible.map((entry) => (
            <li
              key={entry.id}
              className="border-l-2 border-muted py-1 pl-3 text-sm"
            >
              <div className="flex flex-wrap items-baseline gap-2">
                <span className="font-medium">
                  {migrationAuditEventLabel(entry.event)}
                </span>
                <RelativeTime
                  iso={entry.timestamp}
                  className="text-xs text-muted-foreground"
                />
              </div>
              <p className="text-xs text-muted-foreground">
                <span className="font-mono">{entry.event}</span> · by{" "}
                {entry.actor}
              </p>
            </li>
          ))}
        </ul>
        {entries.length > 5 ? (
          <Button
            size="sm"
            variant="ghost"
            className="mt-3"
            onClick={() => setShowAll((visible) => !visible)}
          >
            {showAll ? "Show less" : `View all ${entries.length} entries`}
          </Button>
        ) : null}
      </CardContent>
    </Card>
  );
}
