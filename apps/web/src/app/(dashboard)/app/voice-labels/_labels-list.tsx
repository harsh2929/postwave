// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { BarChart3, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { IconButton } from "@/components/ui/icon-button";
import { Skeleton } from "@/components/ui/skeleton";
import { RelativeTime } from "@/components/relative-time";
import { pluralize } from "@/lib/analytics-format";
import {
  voiceLabelsApi,
  VOICE_LABEL_AXES,
  type VoiceLabel,
  type VoiceLabelAxis,
} from "@/lib/voice-labels-api";
import {
  LABEL_VALUE_BUCKETS,
  summarizeLabelCoverage,
  type LabelCoverage,
} from "@/lib/voice-labels-helpers";
import { useTableUrlState } from "@/lib/use-table-url-state";
import { enumParam, intParam } from "@/lib/table-url-state";
import { createLatestRequestGate } from "@/lib/latest-request";
import { ApiError } from "@/lib/api";
import { downloadTextFile } from "@/lib/download";
import { isServiceNotDeployed } from "@/lib/service-availability";

const PAGE_SIZE = 20;

const AXIS_FILTER_VALUES = ["all", ...VOICE_LABEL_AXES] as const;
const LABELS_URL_SCHEMA = {
  axis: enumParam(AXIS_FILTER_VALUES, "all"),
  page: intParam(1, 1),
};

function truncate(s: string, n: number): string {
  if (!s) return "";
  if (s.length <= n) return s;
  return s.slice(0, n - 1).trimEnd() + "…";
}

function humanLoadError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 403) return "You need an admin role to view labels.";
    if (err.status >= 500)
      return "The labels service is temporarily unavailable.";
    return `Couldn't load labels (error ${err.status}).`;
  }
  return err instanceof Error ? err.message : "Couldn't load labels.";
}

interface LabelsListProps {
  /** Bumping this counter refetches — wired from the form's onSubmitted. */
  refreshToken: number;
  /**
   * Voice labeling isn't set up in this environment (a read answered 503
   * service_not_deployed). The page owns the notice; this list stops offering
   * Retry, Export and Coverage, and points those controls at the notice.
   */
  notDeployed?: boolean;
  /** The id of the page's not-deployed notice, for aria-describedby. */
  notDeployedId?: string;
  /** Called when a read answers service_not_deployed. */
  onServiceNotDeployed?: () => void;
}

/**
 * Right-half panel: coverage summary + filter + paginated list + delete +
 * export. Filter/page persist in the URL so refresh and Back restore the
 * operator's place. The "Export all (JSON)" button hits
 * /api/v1/voice/labels/export.json with the session cookie attached.
 */
export function LabelsList({
  refreshToken,
  notDeployed = false,
  notDeployedId,
  onServiceNotDeployed,
}: LabelsListProps): JSX.Element {
  const { state, setState } = useTableUrlState(LABELS_URL_SCHEMA);
  const axisFilter: VoiceLabelAxis | "" =
    state.axis === "all" ? "" : (state.axis as VoiceLabelAxis);
  const page = state.page;

  const [items, setItems] = useState<VoiceLabel[]>([]);
  const [total, setTotal] = useState(0);
  // `total` starts at 0, which reads as "one page" — so the page clamp below
  // may only run once a response has actually been counted.
  const [countObserved, setCountObserved] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  const [coverageOpen, setCoverageOpen] = useState(false);
  const [coverage, setCoverage] = useState<LabelCoverage | null>(null);
  const [coverageLoading, setCoverageLoading] = useState(false);
  const [coverageError, setCoverageError] = useState<string | null>(null);

  // Only the newest list request may write state. Changing the axis filter or
  // paging quickly leaves an earlier request in flight, and responses are not
  // ordered — without this, a slower page-1 answer landing after page-2 would
  // render page 1's rows while the UI says page 2.
  const listGate = useRef(createLatestRequestGate()).current;
  // Through a ref so an inline callback from the page cannot change `load`'s
  // identity and re-fire the list request on every render.
  const notDeployedRef = useRef(onServiceNotDeployed);
  notDeployedRef.current = onServiceNotDeployed;

  const load = useCallback(async (): Promise<void> => {
    const isCurrent = listGate.begin();
    setLoading(true);
    setError(null);
    try {
      const res = await voiceLabelsApi.list({
        axis: axisFilter || undefined,
        page,
        size: PAGE_SIZE,
      });
      if (!isCurrent()) return;
      setItems(res.items);
      setTotal(res.total);
      setCountObserved(true);
    } catch (err) {
      if (!isCurrent()) return;
      if (isServiceNotDeployed(err)) {
        notDeployedRef.current?.();
        return;
      }
      setError(humanLoadError(err));
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, [axisFilter, page, listGate]);

  useEffect(() => {
    void load();
  }, [load, refreshToken]);

  // Coverage is computed from the full export feed (accurate counts +
  // distribution) but only fetched when the panel is opened, so the default
  // load stays cheap. Refetched when new labels land (refreshToken).
  const loadCoverage = useCallback(async (): Promise<void> => {
    setCoverageLoading(true);
    setCoverageError(null);
    try {
      const all = await voiceLabelsApi.export();
      setCoverage(summarizeLabelCoverage(all));
    } catch (err) {
      if (isServiceNotDeployed(err)) {
        notDeployedRef.current?.();
        return;
      }
      setCoverageError(humanLoadError(err));
    } finally {
      setCoverageLoading(false);
    }
  }, []);

  useEffect(() => {
    if (coverageOpen) void loadCoverage();
  }, [coverageOpen, loadCoverage, refreshToken]);

  async function performDelete(id: string): Promise<void> {
    try {
      await voiceLabelsApi.delete(id);
      toast.success("Label deleted");
      if (coverageOpen) void loadCoverage();
      await load();
    } catch (err) {
      const msg =
        err instanceof ApiError
          ? err.status === 403
            ? "Admin role required to delete"
            : `Delete failed: ${err.status}`
          : err instanceof Error
            ? err.message
            : "Delete failed";
      toast.error(msg);
    }
  }

  async function handleExport(): Promise<void> {
    setExporting(true);
    try {
      const data = await voiceLabelsApi.export();
      // Through the shared helper, which revokes on the next tick; revoking
      // in a `finally` here raced the click that had just been dispatched.
      downloadTextFile(
        `voice-labels-${new Date().toISOString().slice(0, 10)}.json`,
        JSON.stringify(data, null, 2),
        "application/json;charset=utf-8",
      );
      toast.success(
        `Exported ${data.length} ${pluralize(data.length, "label")}`,
      );
    } catch (err) {
      if (isServiceNotDeployed(err)) {
        notDeployedRef.current?.();
        return;
      }
      const msg =
        err instanceof ApiError
          ? err.status === 403
            ? "Admin role required to export"
            : `Export failed: ${err.status}`
          : err instanceof Error
            ? err.message
            : "Export failed";
      toast.error(msg);
    } finally {
      setExporting(false);
    }
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  useEffect(() => {
    // Without `countObserved` this fires on the very first render — `loading`
    // is still false in this closure while the first request is only queued —
    // and rewrites a deep-linked or refreshed ?page=3 to page 1 before its own
    // response lands, which is exactly the place-restoring this panel promises.
    if (countObserved && !loading && !error && page > totalPages) {
      setState({ page: totalPages });
    }
  }, [countObserved, error, loading, page, setState, totalPages]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            onClick={() => setState({ axis: "all", page: 1 })}
            className={
              "inline-flex min-h-8 items-center rounded-full border px-2.5 py-0.5 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 " +
              (axisFilter === ""
                ? "bg-primary text-primary-foreground border-primary"
                : "bg-background hover:bg-accent")
            }
            aria-pressed={axisFilter === ""}
          >
            All
          </button>
          {VOICE_LABEL_AXES.map((a) => (
            <button
              key={a}
              type="button"
              onClick={() => setState({ axis: a, page: 1 })}
              className={
                "inline-flex min-h-8 items-center rounded-full border px-2.5 py-0.5 text-xs capitalize outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 " +
                (axisFilter === a
                  ? "bg-primary text-primary-foreground border-primary"
                  : "bg-background hover:bg-accent")
              }
              aria-pressed={axisFilter === a}
            >
              {a}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setCoverageOpen((v) => !v)}
            aria-expanded={coverageOpen}
            disabled={notDeployed}
            aria-describedby={notDeployed ? notDeployedId : undefined}
          >
            <BarChart3 className="h-4 w-4" />
            {coverageOpen ? "Hide coverage" : "Coverage"}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void handleExport()}
            disabled={exporting || notDeployed}
            aria-describedby={notDeployed ? notDeployedId : undefined}
          >
            {exporting ? "Exporting..." : "Export all (JSON)"}
          </Button>
        </div>
      </div>

      {coverageOpen && !notDeployed && (
        <CoveragePanel
          coverage={coverage}
          loading={coverageLoading}
          error={coverageError}
          onRetry={() => void loadCoverage()}
        />
      )}

      {error && (
        <div
          role="alert"
          className="flex items-start justify-between gap-3 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-foreground"
        >
          <p>{error}</p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="shrink-0"
            onClick={() => void load()}
            disabled={loading}
          >
            Retry
          </Button>
        </div>
      )}

      <div
        role="region"
        aria-label="Voice labels"
        tabIndex={0}
        className="border rounded-md overflow-x-auto focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-muted-foreground">
            <tr>
              <th scope="col" className="text-left px-3 py-2 font-medium">
                When
              </th>
              <th scope="col" className="text-left px-3 py-2 font-medium">
                Axis
              </th>
              <th scope="col" className="text-left px-3 py-2 font-medium">
                Value
              </th>
              <th scope="col" className="text-left px-3 py-2 font-medium">
                Sample
              </th>
              <th scope="col" className="text-left px-3 py-2 font-medium">
                Notes
              </th>
              <th scope="col" className="text-right px-3 py-2 font-medium">
                Actions
              </th>
            </tr>
          </thead>
          <tbody>
            {notDeployed ? (
              <tr>
                <td
                  className="px-3 py-6 text-center text-muted-foreground"
                  colSpan={6}
                >
                  Labels can&apos;t be listed in this environment.
                </td>
              </tr>
            ) : loading && items.length === 0 ? (
              Array.from({ length: 5 }).map((_, i) => (
                <tr key={`sk-${i}`} className="border-t">
                  {Array.from({ length: 6 }).map((__, j) => (
                    <td key={j} className="px-3 py-2.5">
                      <Skeleton className="h-4 w-full" />
                    </td>
                  ))}
                </tr>
              ))
            ) : error && items.length === 0 ? (
              <tr>
                <td
                  className="px-3 py-6 text-center text-muted-foreground"
                  colSpan={6}
                >
                  Labels are unavailable until the request succeeds.
                </td>
              </tr>
            ) : items.length === 0 ? (
              <tr>
                <td
                  className="px-3 py-6 text-center text-muted-foreground"
                  colSpan={6}
                >
                  No labels yet — submit one to get started.
                </td>
              </tr>
            ) : (
              items.map((it) => (
                <tr key={it.id} className="border-t">
                  <td className="px-3 py-2 whitespace-nowrap text-muted-foreground tabular-nums">
                    <RelativeTime iso={it.created_at} />
                  </td>
                  <td className="px-3 py-2">
                    <Badge variant="secondary" className="capitalize">
                      {it.axis}
                    </Badge>
                  </td>
                  <td className="px-3 py-2 tabular-nums">
                    {it.value.toFixed(2)}
                  </td>
                  <td className="px-3 py-2 max-w-[28ch]">
                    <span title={it.sample_text}>
                      {truncate(it.sample_text, 100)}
                    </span>
                  </td>
                  <td className="px-3 py-2 max-w-[24ch]">
                    {it.notes ? (
                      <span title={it.notes}>{truncate(it.notes, 60)}</span>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <ConfirmDialog
                      trigger={
                        <IconButton
                          size="sm"
                          aria-label={`Delete label ${it.id}`}
                        >
                          <Trash2 className="h-4 w-4 text-destructive" />
                        </IconButton>
                      }
                      title="Delete this label?"
                      description="This removes the labeled sample from the training feed. This cannot be undone."
                      confirmLabel="Delete label"
                      onConfirm={() => performDelete(it.id)}
                    />
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>
          {total === 0
            ? "0 labels"
            : `${(page - 1) * PAGE_SIZE + 1}–${Math.min(page * PAGE_SIZE, total)} of ${total}`}
        </span>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setState({ page: Math.max(1, page - 1) })}
            disabled={page <= 1 || loading || notDeployed}
          >
            Prev
          </Button>
          <span className="tabular-nums">
            {page} / {totalPages}
          </span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setState({ page: Math.min(totalPages, page + 1) })}
            disabled={page >= totalPages || loading || notDeployed}
          >
            Next
          </Button>
        </div>
      </div>
    </div>
  );
}

/** Per-axis counts + value-distribution histogram (SEQ-048). */
function CoveragePanel({
  coverage,
  loading,
  error,
  onRetry,
}: {
  coverage: LabelCoverage | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
}): JSX.Element {
  if (loading && !coverage) {
    return (
      <div className="space-y-2 rounded-md border p-4">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-4 w-full" />
        ))}
      </div>
    );
  }
  if (error) {
    return (
      <div
        role="alert"
        className="flex items-start justify-between gap-3 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-foreground"
      >
        <p>{error}</p>
        <Button
          variant="outline"
          size="sm"
          className="shrink-0"
          onClick={onRetry}
        >
          Retry
        </Button>
      </div>
    );
  }
  if (!coverage) return <></>;

  const maxCount = Math.max(1, ...coverage.perAxis.map((a) => a.count));
  return (
    <div className="space-y-3 rounded-md border p-4">
      <p className="text-xs text-muted-foreground">
        {coverage.total} labeled {pluralize(coverage.total, "row")} across all
        axes. Bars show how many samples cover each axis; the mini-histogram
        shows the spread of values (0.0 → 1.0).
      </p>
      <ul className="space-y-2">
        {coverage.perAxis.map((axis) => (
          <li key={axis.axis} className="flex items-center gap-3">
            <span className="w-20 shrink-0 text-xs font-medium capitalize">
              {axis.axis}
            </span>
            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
              <div
                className={
                  axis.count === 0
                    ? "h-full bg-destructive/40"
                    : "h-full bg-foreground"
                }
                style={{ width: `${(axis.count / maxCount) * 100}%` }}
              />
            </div>
            <span className="w-8 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
              {axis.count}
            </span>
            <div
              className="flex h-4 w-24 shrink-0 items-end gap-0.5"
              aria-hidden
              title={`Value spread: ${axis.buckets
                .map((c, i) => `${LABEL_VALUE_BUCKETS[i].label}=${c}`)
                .join(", ")}`}
            >
              {axis.buckets.map((count, i) => {
                const maxBucket = Math.max(1, ...axis.buckets);
                return (
                  <span
                    key={i}
                    className="w-1/5 rounded-sm bg-primary/50"
                    style={{
                      height: `${Math.max(6, (count / maxBucket) * 100)}%`,
                    }}
                  />
                );
              })}
            </div>
            <span className="sr-only">
              Value spread:{" "}
              {axis.buckets
                .map(
                  (count, index) =>
                    `${LABEL_VALUE_BUCKETS[index].label} ${count}`,
                )
                .join(", ")}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
