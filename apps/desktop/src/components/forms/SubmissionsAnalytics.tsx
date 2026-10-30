/**
 * SubmissionsAnalytics — compact visual summary of a form's recent
 * submissions, sized to fit inside the detail slideover.
 *
 *   1. Sparkline of daily submission volume over the last 30 days
 *      (bucketed in the browser from the same submission list the
 *      slideover already loads — no extra API call).
 *
 *   2. Visits-vs-submissions: a second sparkline of daily hosted-page
 *      visits from `GET /api/v1/forms/{id}/analytics?days=30`, aligned
 *      to the same window, plus the window's real conversion number
 *      (submissions ÷ visits). Honest states: 404/501 → "not available
 *      on this server build"; other errors → message + Retry.
 *
 *   3. Status-mix bar: confirmed / pending / unsubscribed share, with
 *      a leading dot per row so the operator can scan at a glance.
 *
 *   4. Admin-only export using a short-lived stream token for the existing
 *      `GET /api/v1/forms/{id}/submissions.csv` endpoint. The desktop opens
 *      the authenticated URL only while this form is still active.
 */

import {
  type ReactElement,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  type FormAnalyticsResponse,
  type FormSubmission,
  api,
  buildStreamUrl,
} from "../../lib/api-client";
import { downloadUrlToFile } from "../../lib/file-transfer";
import { useCanAdmin } from "../../lib/store";
import { toast } from "../Toast";
import { AccessibleChartData } from "../charts/AccessibleChartData";
import { CategoricalDistributionChart } from "../charts/CategoricalDistributionChart";
import { alignVisitCounts, windowConversion } from "./form-metrics";

interface Props {
  formId: string;
  submissions: FormSubmission[] | null;
  loading: boolean;
}

/**
 * The submissions list endpoint caps its response at 1000 rows
 * server-side. When we receive exactly the cap we assume truncation
 * and surface a note — the chart and status mix are then a sample,
 * not the full history.
 */
const SERVER_ROW_CAP = 1000;

/** Window length shared by the local submission buckets and the
 *  visits endpoint so the two sparklines cover the same days. */
const WINDOW_DAYS = 30;

function startOfUTCDay(d: Date): number {
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

function bucketDaily(subs: FormSubmission[]): {
  buckets: number[];
  labels: string[];
  weekends: boolean[];
  /** YYYY-MM-DD (UTC) per bucket — used to align the visits series. */
  isoDates: string[];
  /** Rows that actually fall inside the same 30-day UTC window. */
  inWindow: FormSubmission[];
} {
  const now = new Date();
  const todayUTC = startOfUTCDay(now);
  const days = WINDOW_DAYS;
  const buckets = new Array<number>(days).fill(0);
  const labels = new Array<string>(days).fill("");
  const weekends = new Array<boolean>(days).fill(false);
  const isoDates = new Array<string>(days).fill("");
  const inWindow: FormSubmission[] = [];
  for (let i = 0; i < days; i++) {
    const dayMs = todayUTC - (days - 1 - i) * 24 * 60 * 60 * 1000;
    const day = new Date(dayMs);
    labels[i] = day.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
    });
    isoDates[i] = day.toISOString().slice(0, 10);
    // Buckets are UTC days, so the weekend flag uses the bucket's
    // actual UTC day-of-week — not the bucket index, which only lines
    // up with the calendar when "today" happens to be a Sunday.
    const dow = day.getUTCDay();
    weekends[i] = dow === 0 || dow === 6;
  }
  for (const s of subs) {
    const ts = Date.parse(s.submittedAt);
    if (Number.isNaN(ts)) continue;
    const dayUTC = startOfUTCDay(new Date(ts));
    const offset = Math.floor((todayUTC - dayUTC) / (24 * 60 * 60 * 1000));
    if (offset < 0 || offset >= days) continue;
    inWindow.push(s);
    buckets[days - 1 - offset]! += 1;
  }
  return { buckets, labels, weekends, isoDates, inWindow };
}

function statusMix(
  subs: FormSubmission[],
): Array<{ key: string; label: string; n: number; color: string }> {
  const counts = new Map<string, number>();
  for (const s of subs) {
    const k = (s.status ?? "unknown").toLowerCase();
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const rows = [
    {
      key: "confirmed",
      label: "Confirmed",
      n: counts.get("confirmed") ?? 0,
      color: "var(--pw-accent)",
    },
    {
      key: "pending",
      label: "Pending",
      n: counts.get("pending") ?? 0,
      color: "var(--pw-warning)",
    },
    {
      key: "unsubscribed",
      label: "Unsubscribed",
      n: counts.get("unsubscribed") ?? 0,
      color: "var(--pw-fg-muted)",
    },
  ];
  const known = new Set(rows.map((row) => row.key));
  const other = [...counts].reduce(
    (sum, [key, count]) => sum + (known.has(key) ? 0 : count),
    0,
  );
  if (other > 0) {
    rows.push({
      key: "other",
      label: "Other",
      n: other,
      color: "var(--pw-fg-subtle)",
    });
  }
  return rows;
}

interface VisitsAnalyticsProps {
  error: string | null;
  labels: string[];
  loading: boolean;
  onRetry: () => void;
  submissionCount: number;
  truncated: boolean;
  unavailable: boolean;
  visitBuckets: number[];
  visitsTotal: number;
}

function VisitsAnalytics({
  error,
  labels,
  loading,
  onRetry,
  submissionCount,
  truncated,
  unavailable,
  visitBuckets,
  visitsTotal,
}: VisitsAnalyticsProps): ReactElement {
  const peak = Math.max(1, ...visitBuckets);
  const conversion = windowConversion(submissionCount, visitsTotal);
  const denominatorIncomplete =
    visitsTotal > 0 && submissionCount > visitsTotal;
  const color = "color-mix(in srgb, var(--pw-accent) 45%, var(--pw-fg-muted))";
  return (
    <div style={{ marginTop: 12 }}>
      <div
        className="muted"
        style={{
          fontSize: 11,
          marginBottom: 4,
          textTransform: "uppercase",
          letterSpacing: 0.4,
        }}
      >
        Visits vs submissions
      </div>
      {loading ? (
        <div className="skel" style={{ height: 40 }} />
      ) : unavailable ? (
        <div className="muted" style={{ fontSize: 11 }}>
          Visit analytics aren&apos;t available on this server build, so
          conversion for the window can&apos;t be computed.
        </div>
      ) : error ? (
        <div>
          <div className="field-error" style={{ marginBottom: 6 }}>
            Couldn&apos;t load hosted-page visits: {error}
          </div>
          <button type="button" className="btn btn-sm" onClick={onRetry}>
            Retry
          </button>
        </div>
      ) : visitsTotal === 0 ? (
        <div className="muted" style={{ fontSize: 11 }}>
          No hosted-page visits recorded in the last {WINDOW_DAYS} days
          {submissionCount > 0
            ? " — submissions may come from embeds, which don't report visits"
            : ""}
          .
        </div>
      ) : (
        <>
          <div
            style={{
              display: "flex",
              alignItems: "flex-end",
              gap: 2,
              height: 36,
              padding: "4px 0",
            }}
            aria-hidden="true"
          >
            {visitBuckets.map((count, index) => (
              <div
                key={labels[index]}
                title={`${labels[index]}: ${count} visit${count === 1 ? "" : "s"}`}
                style={{
                  flex: 1,
                  height: Math.max(2, (count / peak) * 32),
                  minWidth: 4,
                  borderRadius: 2,
                  background:
                    count > 0
                      ? color
                      : "color-mix(in srgb, var(--pw-fg-muted) 12%, transparent)",
                  opacity: count > 0 ? 1 : 0.55,
                }}
              />
            ))}
          </div>
          <div
            className="muted"
            style={{
              display: "flex",
              justifyContent: "space-between",
              fontSize: 10,
              marginTop: 2,
            }}
          >
            <span>
              <span
                aria-hidden
                style={{
                  display: "inline-block",
                  width: 8,
                  height: 8,
                  borderRadius: 2,
                  background: color,
                  marginRight: 4,
                  verticalAlign: "middle",
                }}
              />
              {visitsTotal.toLocaleString()} visits
            </span>
            <span>Peak: {peak}/day</span>
          </div>
          <div style={{ fontSize: 12, marginTop: 6 }}>
            Window conversion:{" "}
            <strong className="tabular">
              {denominatorIncomplete
                ? "Not comparable"
                : conversion == null
                  ? "—"
                  : `${conversion.toFixed(1)}%`}
            </strong>{" "}
            <span className="muted">
              ({submissionCount.toLocaleString()} submissions /{" "}
              {visitsTotal.toLocaleString()} visits, {WINDOW_DAYS}d)
            </span>
          </div>
          {denominatorIncomplete ? (
            <div className="muted" style={{ fontSize: 10, marginTop: 2 }}>
              Submissions exceed hosted-page visits because some embed paths do
              not report a visit. No percentage is shown from an incomplete
              denominator.
            </div>
          ) : null}
          {truncated ? (
            <div className="muted" style={{ fontSize: 10, marginTop: 2 }}>
              Submission counts use the most recent{" "}
              {SERVER_ROW_CAP.toLocaleString()} rows, so this conversion is a
              lower bound.
            </div>
          ) : null}
          <AccessibleChartData
            title="Daily hosted-page visits"
            summary={`${visitsTotal.toLocaleString()} visits over ${WINDOW_DAYS} days; peak ${peak.toLocaleString()} per day.`}
            rowHeaderLabel="Date"
            columns={[{ key: "visits", label: "Visits" }]}
            rows={labels.map((label, index) => ({
              key: label,
              label,
              values: { visits: (visitBuckets[index] ?? 0).toLocaleString() },
              exportValues: { visits: visitBuckets[index] ?? 0 },
            }))}
            provenance={{
              source: "Moosewave forms analytics API",
              asOf: null,
              scope: `Selected form · last ${WINDOW_DAYS} days`,
              note: "Hosted-page visits exclude embeds that do not report a visit.",
            }}
            exportFileName="form-hosted-page-visits.csv"
            exportPrivacy="confidential"
          />
        </>
      )}
    </div>
  );
}

export function SubmissionsAnalytics({
  formId,
  submissions,
  loading,
}: Props): ReactElement {
  const canAdmin = useCanAdmin();
  const activeRef = useRef(true);
  const exportRequestRef = useRef(0);
  const exportingRef = useRef(false);
  const [exporting, setExporting] = useState(false);
  const exportDescriptionId = useId();
  const safeSubs = submissions ?? [];
  const { buckets, labels, weekends, isoDates, inWindow } = useMemo(
    () => bucketDaily(safeSubs),
    [safeSubs],
  );
  const mix = useMemo(() => statusMix(inWindow), [inWindow]);
  const peak = Math.max(1, ...buckets);
  const truncated = safeSubs.length >= SERVER_ROW_CAP;

  /* ---------- hosted-page visits (per-form analytics endpoint) ------- */
  const [visitsResp, setVisitsResp] = useState<FormAnalyticsResponse | null>(
    null,
  );
  const [visitsLoading, setVisitsLoading] = useState(true);
  const [visitsErr, setVisitsErr] = useState<string | null>(null);
  const [visitsUnavailable, setVisitsUnavailable] = useState(false);
  /** Bumped by the Retry button to refire the effect. */
  const [visitsAttempt, setVisitsAttempt] = useState(0);
  const retryVisits = useCallback(() => setVisitsAttempt((a) => a + 1), []);

  useEffect(() => {
    activeRef.current = true;
    exportRequestRef.current += 1;
    exportingRef.current = false;
    setExporting(false);
    return () => {
      activeRef.current = false;
      exportRequestRef.current += 1;
      exportingRef.current = false;
    };
  }, [canAdmin, formId]);

  useEffect(() => {
    let cancelled = false;
    setVisitsLoading(true);
    setVisitsErr(null);
    setVisitsUnavailable(false);
    void api.getFormAnalytics(formId, { days: WINDOW_DAYS }).then((res) => {
      if (cancelled) return;
      if (res.error) {
        const status = res.error.status ?? 0;
        if (res.error.kind === "http" && (status === 404 || status === 501)) {
          // Older API builds don't ship the visits endpoint — say so
          // instead of rendering an error for something unfixable here.
          setVisitsUnavailable(true);
        } else {
          setVisitsErr(res.error.message);
        }
        setVisitsResp(null);
      } else {
        setVisitsResp(res.data);
      }
      setVisitsLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [formId, visitsAttempt]);

  const visitBuckets = useMemo(
    () => alignVisitCounts(visitsResp?.visits ?? [], isoDates),
    [visitsResp, isoDates],
  );
  const visitsTotal = visitsResp?.visits_total ?? 0;
  const windowSubs = buckets.reduce((sum, n) => sum + n, 0);

  const exportCsv = async (): Promise<void> => {
    // The CSV route is admin-scoped, so a bare anchor href carries no
    // auth and 401s in the Tauri webview's cookieless context.
    // buildStreamUrl resolves the absolute URL against the configured
    // API host AND appends a short-lived stream_token (same pattern
    // as the Discounts CSV export).
    if (!canAdmin || exportingRef.current) return;
    const requestId = ++exportRequestRef.current;
    exportingRef.current = true;
    setExporting(true);
    try {
      const url = await buildStreamUrl(
        `/api/v1/forms/${encodeURIComponent(formId)}/submissions.csv`,
      );
      if (!activeRef.current || requestId !== exportRequestRef.current) return;
      const saved = await downloadUrlToFile({
        url,
        suggestedName: `form-${formId}-submissions.csv`,
        label: "Form submissions export",
        privacy: "confidential",
        mimeType: "text/csv;charset=utf-8",
      });
      if (!saved.ok) throw new Error(saved.message);
    } catch (e) {
      if (!activeRef.current || requestId !== exportRequestRef.current) return;
      toast.error(
        `Couldn't open export: ${e instanceof Error ? e.message : "unknown error"}`,
      );
    } finally {
      if (activeRef.current && requestId === exportRequestRef.current) {
        exportingRef.current = false;
        setExporting(false);
      }
    }
  };

  return (
    <div>
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          marginBottom: 6,
        }}
      >
        <div className="label" style={{ margin: 0 }}>
          Submissions, last 30 days
        </div>
        <span
          id={exportDescriptionId}
          className="visually-hidden"
          role={exporting ? "status" : undefined}
        >
          {!canAdmin
            ? "Admin access is required to export submission history."
            : exporting
              ? "The submission export is already being prepared."
              : "Downloads the full available submission history as a confidential CSV file."}
        </span>
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => {
            if (!canAdmin || exporting || exportingRef.current) return;
            void exportCsv();
          }}
          aria-disabled={!canAdmin || exporting || undefined}
          aria-describedby={exportDescriptionId}
        >
          {exporting ? "Opening export…" : "Export CSV"}
        </button>
      </div>

      {truncated ? (
        <div className="muted" style={{ fontSize: 11, marginBottom: 6 }}>
          Showing the most recent {SERVER_ROW_CAP.toLocaleString()} submissions
          — older rows are not included in the chart or status mix. Export CSV
          walks the complete available history.
        </div>
      ) : null}

      {loading ? (
        <div className="skel" style={{ height: 60 }} />
      ) : safeSubs.length === 0 ? (
        <>
          <div className="muted" style={{ fontSize: 12 }}>
            No submissions yet. Once visitors submit the form, daily volume and
            status mix appear here.
          </div>
          <VisitsAnalytics
            error={visitsErr}
            labels={labels}
            loading={visitsLoading}
            onRetry={retryVisits}
            submissionCount={windowSubs}
            truncated={truncated}
            unavailable={visitsUnavailable}
            visitBuckets={visitBuckets}
            visitsTotal={visitsTotal}
          />
        </>
      ) : (
        <>
          {/* sparkline */}
          <div
            style={{
              display: "flex",
              alignItems: "flex-end",
              gap: 2,
              height: 48,
              padding: "4px 0",
            }}
            aria-hidden="true"
          >
            {buckets.map((n, i) => {
              const h = Math.max(2, (n / peak) * 44);
              const isWeekend = weekends[i] === true;
              return (
                <div
                  key={i}
                  title={`${labels[i]}: ${n}`}
                  style={{
                    flex: 1,
                    height: h,
                    minWidth: 4,
                    borderRadius: 2,
                    background:
                      n > 0
                        ? "var(--pw-accent)"
                        : isWeekend
                          ? "color-mix(in srgb, var(--pw-fg-muted) 18%, transparent)"
                          : "color-mix(in srgb, var(--pw-fg-muted) 12%, transparent)",
                    opacity: n > 0 ? 1 : 0.55,
                  }}
                />
              );
            })}
          </div>

          <AccessibleChartData
            title="Daily form submission volume"
            summary={`${windowSubs.toLocaleString()} submissions over ${WINDOW_DAYS} days; peak ${peak.toLocaleString()} per day.`}
            rowHeaderLabel="Date"
            columns={[{ key: "submissions", label: "Submissions" }]}
            rows={labels.map((label, index) => ({
              key: isoDates[index] ?? label,
              label,
              values: {
                submissions: (buckets[index] ?? 0).toLocaleString(),
              },
              exportValues: { submissions: buckets[index] ?? 0 },
            }))}
            provenance={{
              source: "Moosewave form submissions API",
              asOf: null,
              scope: `Selected form · last ${WINDOW_DAYS} days`,
              note: truncated
                ? `Chart is limited to the most recent ${SERVER_ROW_CAP.toLocaleString()} loaded submissions.`
                : "Complete loaded submission window.",
            }}
            exportFileName="form-daily-submission-volume.csv"
            exportPrivacy="confidential"
          />
          <div
            className="muted"
            style={{
              display: "flex",
              justifyContent: "space-between",
              fontSize: 10,
              marginTop: 2,
            }}
          >
            <span>{labels[0]}</span>
            <span>Peak: {peak}/day</span>
            <span>{labels[labels.length - 1]}</span>
          </div>

          {/* visits vs submissions + window conversion */}
          <VisitsAnalytics
            error={visitsErr}
            labels={labels}
            loading={visitsLoading}
            onRetry={retryVisits}
            submissionCount={windowSubs}
            truncated={truncated}
            unavailable={visitsUnavailable}
            visitBuckets={visitBuckets}
            visitsTotal={visitsTotal}
          />

          {/* status mix */}
          <div style={{ marginTop: 12 }}>
            <CategoricalDistributionChart
              title="Form submission status mix"
              valueLabel="Submissions"
              segments={mix.map((item) => ({
                key: item.key,
                label: item.label,
                value: item.n,
                color: item.color,
              }))}
              provenance={{
                source: "Moosewave form submissions API",
                asOf: null,
                scope: `Selected form · loaded ${WINDOW_DAYS}-day window`,
                note: truncated
                  ? `Status mix is limited to the most recent ${SERVER_ROW_CAP.toLocaleString()} rows.`
                  : "Complete loaded submission window.",
              }}
              exportFileName="form-submission-status-mix.csv"
              exportPrivacy="confidential"
            />
          </div>
        </>
      )}
    </div>
  );
}
