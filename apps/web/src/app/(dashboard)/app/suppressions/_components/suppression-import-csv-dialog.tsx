// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useId, useState, type ChangeEvent } from "react";
import { FileUp } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { apiErrorMessage } from "@/lib/api";
import {
  formatSuppressionImportBytes,
  importSuppressionsCsv,
  suppressionImportFileError,
  type ImportResult,
  type SuppressionReason,
} from "@/lib/suppressions-admin-api";
import {
  MANUAL_SUPPRESSION_REASONS,
  SUPPRESSION_REASON_LABELS,
} from "@/lib/suppression-reasons";

/**
 * Multipart CSV upload for the suppression list (desktop parity with
 * ImportSuppressionsModal). The paste-based "Bulk import" dialog covers small
 * lists; this one takes a file up to 25 MiB with an `email` column and an
 * optional `reason` column, applying the chosen default where a row has none.
 * The server's counts (and its first bad rows) are rendered verbatim so the
 * operator sees what was actually parsed rather than an inferred summary.
 */
export function SuppressionImportCsvDialog({
  onClose,
  onImported,
}: {
  onClose: () => void;
  /** Fired once per successful upload with the server's counts. */
  onImported: (result: ImportResult) => void;
}) {
  const fileId = useId();
  const reasonId = useId();
  const [file, setFile] = useState<File | null>(null);
  const [defaultReason, setDefaultReason] =
    useState<SuppressionReason>("list_manual");
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);

  const pick = (event: ChangeEvent<HTMLInputElement>): void => {
    const picked = event.target.files?.[0] ?? null;
    setError(null);
    if (!picked) {
      setFile(null);
      return;
    }
    const problem = suppressionImportFileError(picked);
    if (problem) {
      setFile(null);
      setError(problem);
      return;
    }
    setFile(picked);
  };

  async function submit(): Promise<void> {
    if (!file || working) return;
    setWorking(true);
    setError(null);
    try {
      const response = await importSuppressionsCsv(file, defaultReason);
      setResult(response);
      onImported(response);
    } catch (err) {
      setError(apiErrorMessage(err, "Could not import the CSV."));
    } finally {
      setWorking(false);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && !working && onClose()}>
      <DialogContent
        closeDisabled={working}
        aria-busy={working || undefined}
        className="[&_[data-slot=button]]:min-h-11 sm:[&_[data-slot=button]]:min-h-9"
        onEscapeKeyDown={(event) => {
          if (working) event.preventDefault();
        }}
        onInteractOutside={(event) => {
          if (working) event.preventDefault();
        }}
      >
        <DialogHeader>
          <DialogTitle>Import suppressions from CSV</DialogTitle>
          <DialogDescription>
            Upload a CSV with an <code>email</code> column. A second{" "}
            <code>reason</code> column is optional — rows without one use the
            default below. Header row auto-detected; up to 25 MiB.
          </DialogDescription>
        </DialogHeader>

        {result ? (
          <div className="space-y-3" role="status">
            <div className="rounded-md border bg-muted/40 p-3 text-sm">
              <p className="font-medium">Import complete.</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Read {formatSuppressionImportBytes(result.bytes_read)}. Existing
                rows keep their reason; nothing was overwritten.
              </p>
            </div>
            <dl className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
              <ImportStat label="Inserted" value={result.inserted} />
              <ImportStat label="Already existed" value={result.existing} />
              <ImportStat label="Skipped" value={result.skipped} />
              <ImportStat
                label="Errors"
                value={result.errors}
                negative={result.errors > 0}
              />
            </dl>
            {result.bad_rows && result.bad_rows.length > 0 ? (
              <div>
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Bad rows (first {result.bad_rows.length})
                </p>
                <ul className="mt-1 max-h-36 space-y-0.5 overflow-auto rounded-md border bg-muted/40 p-2 font-mono text-xs">
                  {result.bad_rows.map((row, index) => (
                    <li key={`${index}-${row}`} className="break-all">
                      {row}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        ) : (
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor={fileId}>CSV file</Label>
              <Input
                id={fileId}
                type="file"
                accept=".csv,text/csv"
                disabled={working}
                onChange={pick}
                aria-invalid={error ? true : undefined}
                aria-describedby={`${fileId}-help`}
              />
              <p
                id={`${fileId}-help`}
                className="text-xs text-muted-foreground"
              >
                {file
                  ? `${file.name} · ${formatSuppressionImportBytes(file.size)}`
                  : "email,reason columns; header optional."}
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={reasonId}>Default reason</Label>
              <Select
                id={reasonId}
                value={defaultReason}
                disabled={working}
                onChange={(event) =>
                  setDefaultReason(event.target.value as SuppressionReason)
                }
              >
                {MANUAL_SUPPRESSION_REASONS.map((reason) => (
                  <option key={reason} value={reason}>
                    {SUPPRESSION_REASON_LABELS[reason]}
                  </option>
                ))}
              </Select>
              <p className="text-xs text-muted-foreground">
                Used when a row does not carry its own reason.
              </p>
            </div>
          </div>
        )}

        {error ? (
          <p role="alert" className="text-sm text-destructive-emphasis">
            {error}
          </p>
        ) : null}

        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            onClick={onClose}
            disabled={working}
          >
            {result ? "Done" : "Cancel"}
          </Button>
          {!result ? (
            <Button
              type="button"
              onClick={() => void submit()}
              disabled={!file || working}
              loading={working}
            >
              <FileUp className="h-4 w-4" />
              {working ? "Uploading…" : "Upload and import"}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ImportStat({
  label,
  value,
  negative,
}: {
  label: string;
  value: number;
  negative?: boolean;
}) {
  return (
    <div className="rounded-md border bg-muted/40 px-3 py-2">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd
        className={`text-lg font-semibold tabular-nums ${
          negative ? "text-destructive-emphasis" : ""
        }`}
      >
        {value.toLocaleString()}
      </dd>
    </div>
  );
}
