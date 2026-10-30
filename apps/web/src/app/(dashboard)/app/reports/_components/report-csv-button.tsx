// SPDX-License-Identifier: AGPL-3.0-only
//
// "Download CSV" for the report builder's preview rows (parity with desktop
// ReportBuilderSection downloadCsv). Client-side: it saves exactly the rows the
// preview table shows, through the guarded CSV builder, and makes no request.
//
// Withheld with its reason when there is nothing to export, rather than
// producing a header-only file somebody might mistake for "no data".
"use client";

import { useId, useState } from "react";
import { Download } from "lucide-react";

import { downloadTextFile } from "@/lib/download";
import { reportCsvFilename, reportRowsToCsv } from "@/lib/report-rows-csv";
import { Button } from "@/components/ui/button";

export function ReportCsvButton({
  name,
  columns,
  rows,
}: {
  /** Draft report name; used for the filename (blank → "report"). */
  name: string | null | undefined;
  /** The preview table's columns, in display order. */
  columns: readonly string[];
  /** The preview rows currently on screen. */
  rows: ReadonlyArray<Record<string, unknown>> | null | undefined;
}) {
  const reasonId = useId();
  const [failure, setFailure] = useState<string | null>(null);
  const count = Array.isArray(rows) ? rows.length : 0;
  const csv = count > 0 ? reportRowsToCsv(columns, rows) : "";
  const unavailable = csv.length === 0;

  function download() {
    if (unavailable) return;
    try {
      downloadTextFile(
        reportCsvFilename(name),
        csv,
        "text/csv;charset=utf-8",
      );
      setFailure(null);
    } catch {
      setFailure("The browser blocked the CSV download. Try again.");
    }
  }

  return (
    <span className="inline-flex flex-col items-start gap-1">
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={download}
        disabled={unavailable}
        aria-describedby={unavailable ? reasonId : undefined}
      >
        <Download className="h-4 w-4" aria-hidden />
        Download CSV
        {count > 0 ? (
          <span className="tabular-nums text-muted-foreground">
            ({count.toLocaleString()} row{count === 1 ? "" : "s"})
          </span>
        ) : null}
      </Button>
      {unavailable ? (
        <span id={reasonId} className="sr-only">
          Run a preview that returns rows to download them as CSV.
        </span>
      ) : null}
      {failure ? (
        <span role="alert" className="text-xs text-destructive">
          {failure}
        </span>
      ) : null}
    </span>
  );
}
