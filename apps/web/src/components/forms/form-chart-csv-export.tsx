// SPDX-License-Identifier: AGPL-3.0-only
"use client";

//
// Chart-data CSV downloads for a form's analytics (desktop
// SubmissionsAnalytics AccessibleChartData exports): hosted-page visits,
// daily submission volume, and the submission status mix.
//
// Visits are the series the Analytics tab already loaded — no request.
// Volume and status mix are built from the submissions window, which is
// admin-only server-side (GET /api/v1/forms/{id}/submissions), so those two
// are withheld with the reason for everyone else. Both share one cached walk
// of the window, fetched on first click. Every file goes through the shared
// spreadsheet-safe CSV builder and downloadTextFile.

import { useId, useState } from "react";
import { Download } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";

import { Button } from "@/components/ui/button";
import { apiErrorMessage } from "@/lib/api";
import { effectiveAuthRole, type MeResponse } from "@/lib/auth-api";
import { downloadTextFile } from "@/lib/download";
import { FORM_ADMIN_ONLY_MESSAGE, canAdminForms } from "@/lib/forms-authority";
import {
  CHART_CSV_FILES,
  dailySubmissionVolume,
  dailySubmissionVolumeCsv,
  listSubmissionsInWindow,
  statusMixCsv,
  submissionStatusMix,
  visitsCsv,
  type SubmissionWindow,
} from "@/lib/forms-extras-api";
import type { FormVisitPoint } from "@/lib/forms-types";
import { base, STALE } from "@/lib/query-keys";

const CSV_MIME = "text/csv;charset=utf-8";

type ExportKind = "visits" | "volume" | "statusMix";

interface FormChartCsvExportProps {
  formId: string;
  /** Window the Analytics tab is showing (30 or 90 days). */
  days: number;
  /** The visits series the tab already loaded. */
  visits: readonly FormVisitPoint[];
  identity: MeResponse | null | undefined;
}

export function FormChartCsvExport({
  formId,
  days,
  visits,
  identity,
}: FormChartCsvExportProps) {
  const ids = useId();
  const queryClient = useQueryClient();
  const canAdmin = canAdminForms(identity);
  const tenantId = identity?.tenant_id ?? "anon";
  const role = identity ? effectiveAuthRole(identity) : null;
  const [busy, setBusy] = useState<ExportKind | null>(null);
  const [status, setStatus] = useState("");
  const [error, setError] = useState<string | null>(null);

  function submissionWindow(): Promise<SubmissionWindow> {
    return queryClient.fetchQuery({
      queryKey: [
        ...base("forms", tenantId, role),
        "submissions-window",
        formId,
        days,
      ] as const,
      queryFn: () => listSubmissionsInWindow(formId, days),
      staleTime: STALE.list,
    });
  }

  async function run(kind: ExportKind) {
    if (busy) return;
    setBusy(kind);
    setError(null);
    setStatus("");
    try {
      if (kind === "visits") {
        downloadTextFile(CHART_CSV_FILES.visits, visitsCsv(visits), CSV_MIME);
        setStatus(
          `Downloaded ${CHART_CSV_FILES.visits} (${visits.length} days).`,
        );
        return;
      }
      const sample = await submissionWindow();
      const lowerBound = sample.truncated
        ? " Counts are a lower bound: the newest 20,000 submissions were read."
        : "";
      if (kind === "volume") {
        const volume = dailySubmissionVolume(sample.items, days);
        const total = volume.reduce((sum, v) => sum + v.submissions, 0);
        downloadTextFile(
          CHART_CSV_FILES.volume,
          dailySubmissionVolumeCsv(volume),
          CSV_MIME,
        );
        setStatus(
          `Downloaded ${CHART_CSV_FILES.volume} (${total.toLocaleString()} submissions over ${days} days).${lowerBound}`,
        );
      } else {
        const mix = submissionStatusMix(sample.items, days);
        const total = mix.reduce((sum, m) => sum + m.submissions, 0);
        downloadTextFile(CHART_CSV_FILES.statusMix, statusMixCsv(mix), CSV_MIME);
        setStatus(
          `Downloaded ${CHART_CSV_FILES.statusMix} (${total.toLocaleString()} submissions over ${days} days).${lowerBound}`,
        );
      }
    } catch (err) {
      setError(apiErrorMessage(err, "Could not build the chart data export."));
    } finally {
      setBusy(null);
    }
  }

  const adminNoteId = `${ids}-admin`;

  return (
    <section
      className="space-y-2 rounded-md border bg-card p-4"
      aria-labelledby={`${ids}-title`}
    >
      <h4
        id={`${ids}-title`}
        className="text-xs font-semibold uppercase tracking-wide text-muted-foreground"
      >
        Download chart data
      </h4>
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={busy !== null || visits.length === 0}
          onClick={() => void run("visits")}
        >
          <Download className="h-3.5 w-3.5" aria-hidden />
          Hosted-page visits (CSV)
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={!canAdmin || busy !== null}
          aria-describedby={canAdmin ? undefined : adminNoteId}
          aria-busy={busy === "volume"}
          onClick={() => void run("volume")}
        >
          <Download className="h-3.5 w-3.5" aria-hidden />
          Daily submission volume (CSV)
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={!canAdmin || busy !== null}
          aria-describedby={canAdmin ? undefined : adminNoteId}
          aria-busy={busy === "statusMix"}
          onClick={() => void run("statusMix")}
        >
          <Download className="h-3.5 w-3.5" aria-hidden />
          Status mix (CSV)
        </Button>
      </div>
      {canAdmin ? null : (
        <p id={adminNoteId} role="note" className="text-xs text-muted-foreground">
          {FORM_ADMIN_ONLY_MESSAGE}
        </p>
      )}
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
      <p role="status" aria-live="polite" className="text-xs text-muted-foreground">
        {status}
      </p>
    </section>
  );
}
