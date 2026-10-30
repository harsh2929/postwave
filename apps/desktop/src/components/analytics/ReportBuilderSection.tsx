/**
 * ReportBuilderSection — the flagship KLV-12 metric report builder.
 *
 * The loop: pick metrics (grouped by product_area, runtime_status badged) →
 * choose group-by dimensions (the union of the selected metrics' dimensions) →
 * "Run preview" (POST /reporting/preview, render the returned
 * rows as a table) → optionally Save (upsertDefinition) + Run (runDefinition,
 * polled to terminal) → Download CSV of whatever rows are currently shown.
 *
 * Honest-UI rules honored:
 *  - Only `runtime_status:"supported"` metrics return real data; partial/planned
 *    are badged as warnings in the picker so an operator can avoid them. If one
 *    is selected anyway, the server's preview warnings/errors explain the gap —
 *    we surface those VERBATIM (never fabricate data or a success state).
 *  - The 422 / `valid:false` path renders the server's errors verbatim and KEEPS
 *    the user's selections; we never paint a fake success.
 *  - CSV export is client-side (Blob) and contains EXACTLY the shown rows/columns.
 *  - Save + Run require admin scope (gated on useCanAdmin); preview is read scope
 *    and always available.
 *
 * Collapsible, mirroring ScheduledReportsSection: collapsed by default, the
 * registry is lazy-fetched on first expand.
 */

/* eslint-disable jsx-a11y/no-noninteractive-tabindex -- the horizontally scrollable report-result region must be keyboard-focusable */

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
  type ReportMetricDefinition,
  type ReportPreviewResponse,
  type ReportRequest,
  type ReportRun,
  reportingApi,
} from "../../lib/api-client";
import { remoteFailureFromError } from "../../lib/remote-resource";
import { useCanAdmin } from "../../lib/store";
import { toast } from "../Toast";
import {
  MAX_DIMENSIONS,
  MAX_METRICS,
  canAddDimension,
  canAddMetric,
  cellToString,
  deriveColumns,
  isSupported,
  isTerminalRunStatus,
  metricsByArea,
  rowsToCsv,
  runResultRows,
  selectableDimensions,
} from "./report-builder-helpers";

const CELL_PAD = "6px 8px";
const RUN_POLL_MS = 1500;
const RUN_POLL_MAX = 40; // ~60s ceiling before we stop polling honestly

/** Humanize a product_area key for the picker group header. */
function areaLabel(area: string): string {
  if (!area) return "General";
  return area.charAt(0).toUpperCase() + area.slice(1);
}

/** Badge variant + label for a metric's runtime_status. supported → neutral
 *  "ok"; partial/planned → a warning the user can see and avoid. */
function statusBadge(status: string): { cls: string; label: string } {
  const s = (status ?? "").toLowerCase();
  if (s === "supported") return { cls: "badge success", label: "supported" };
  if (s === "partial") return { cls: "badge warning", label: "partial" };
  if (s === "planned") return { cls: "badge warning", label: "planned" };
  return { cls: "badge", label: s || "unknown" };
}

function resolveShownReportRows(
  preview: ReportPreviewResponse | null,
  run: ReportRun | null,
): {
  runComplete: boolean;
  showingRunRows: boolean;
  shownRows: Array<Record<string, unknown>>;
} {
  const runRows = run ? runResultRows(run.result) : [];
  const runComplete =
    run != null && (run.status ?? "").toLowerCase() === "completed";
  // A completed run owns the result surface even when it returned zero rows.
  // Falling back to an earlier non-empty preview here shows data from a
  // different execution beneath the completed run's status.
  const showingRunRows = runComplete;
  const shownRows = runComplete
    ? runRows
    : Array.isArray(preview?.rows)
      ? preview.rows
      : [];
  return { runComplete, showingRunRows, shownRows };
}

function buildReportRequest(
  reportName: string,
  selectedKeys: string[],
  selectedDims: string[],
): ReportRequest {
  return {
    ...(reportName.trim() ? { name: reportName.trim() } : {}),
    metrics: selectedKeys.map((key) => ({ key })),
    ...(selectedDims.length > 0 ? { dimensions: selectedDims } : {}),
    // The reporting repository currently executes a fixed 30-day window.
    // Keeping that value in the immutable request makes the saved definition
    // and every result receipt explicit about the window actually used.
    time_range: { preset: "30d" },
  };
}

function reportRequestFingerprint(request: ReportRequest): string {
  return JSON.stringify(request);
}

function reportPreviewFeedback(preview: ReportPreviewResponse | null): {
  warnings: string[];
  errors: string[];
  invalid: boolean;
} {
  return {
    warnings: Array.isArray(preview?.warnings) ? preview.warnings : [],
    errors: Array.isArray(preview?.errors) ? preview.errors : [],
    invalid: preview != null && preview.valid === false,
  };
}

interface ReportBuilderFieldsProps {
  registry: ReportMetricDefinition[] | null;
  allMetrics: ReportMetricDefinition[];
  groups: ReturnType<typeof metricsByArea>;
  selectedKeys: string[];
  metricCount: number;
  regLoading: boolean;
  regErr: string | null;
  selectedDefs: ReportMetricDefinition[];
  dimCount: number;
  availableDims: string[];
  selectedDims: string[];
  reportName: string;
  loadRegistry: () => Promise<void>;
  toggleMetric: (key: string) => void;
  toggleDim: (dimension: string) => void;
  setReportName: (name: string) => void;
}

function ReportBuilderFields({
  registry,
  allMetrics,
  groups,
  selectedKeys,
  metricCount,
  regLoading,
  regErr,
  selectedDefs,
  dimCount,
  availableDims,
  selectedDims,
  reportName,
  loadRegistry,
  toggleMetric,
  toggleDim,
  setReportName,
}: ReportBuilderFieldsProps): ReactElement {
  const metricCapReasonId = useId();
  const dimensionCapReasonId = useId();
  return (
    <>
      {/* registry load error / loading */}
      {regErr ? (
        <div className="notice" role="alert">
          <span>Couldn&apos;t load the metric registry: {regErr}</span>
          <span className="spacer" />
          <button
            type="button"
            className="btn btn-sm"
            disabled={regLoading}
            onClick={() => void loadRegistry()}
          >
            {regLoading ? "Retrying…" : "Retry"}
          </button>
        </div>
      ) : null}

      {regLoading && registry === null ? (
        <div className="muted" style={{ fontSize: 12 }}>
          Loading metrics…
        </div>
      ) : null}

      {/* ---------- 1. Metric picker ---------- */}
      {registry !== null && allMetrics.length > 0 ? (
        <div className="field">
          <div
            className="field-label"
            style={{ display: "flex", alignItems: "center", gap: 8 }}
          >
            <span>Metrics</span>
            <span
              id={metricCapReasonId}
              className="muted"
              style={{ fontSize: 11 }}
            >
              {metricCount}/{MAX_METRICS} selected
              {!canAddMetric(metricCount)
                ? " · cap reached — deselect one to add another"
                : ""}
            </span>
          </div>
          <div style={{ display: "grid", gap: 10, marginTop: 4 }}>
            {groups.map((g) => (
              <div key={g.area}>
                <div
                  className="muted"
                  style={{
                    fontSize: 10,
                    textTransform: "uppercase",
                    letterSpacing: 0.4,
                    fontWeight: 600,
                    marginBottom: 4,
                  }}
                >
                  {areaLabel(g.area)}
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                  {(Array.isArray(g.metrics) ? g.metrics : []).map((m) => {
                    const checked = selectedKeys.includes(m.key);
                    const badge = statusBadge(m.runtime_status);
                    const blockedByCap = !checked && !canAddMetric(metricCount);
                    const blockedByRuntime = !isSupported(m);
                    const blocked = blockedByCap || blockedByRuntime;
                    const helpId = `${metricCapReasonId}-${m.key}`;
                    const describedBy = [
                      m.help ? helpId : undefined,
                      blockedByCap ? metricCapReasonId : undefined,
                    ]
                      .filter(Boolean)
                      .join(" ");
                    return (
                      <button
                        key={m.key}
                        type="button"
                        aria-pressed={checked}
                        aria-disabled={blocked || undefined}
                        aria-describedby={describedBy || undefined}
                        onClick={() => {
                          if (!blocked) toggleMetric(m.key);
                        }}
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          gap: 6,
                          padding: "5px 9px",
                          borderRadius: 6,
                          border: `1px solid ${checked ? "var(--pw-accent)" : "var(--pw-border)"}`,
                          background: checked
                            ? "var(--pw-accent)"
                            : "var(--pw-bg-elev)",
                          color: checked
                            ? "var(--pw-accent-fg)"
                            : "var(--pw-fg)",
                          cursor: blocked ? "not-allowed" : "pointer",
                          opacity: blocked ? 0.5 : 1,
                          fontSize: 12,
                          maxWidth: 320,
                          flexWrap: "wrap",
                          textAlign: "left",
                        }}
                      >
                        <span
                          style={{
                            overflowWrap: "anywhere",
                            fontWeight: 600,
                          }}
                        >
                          {m.label ?? m.key}
                        </span>
                        {!isSupported(m) ? (
                          <span
                            className={badge.cls}
                            style={{ fontSize: 9 }}
                            aria-label={`${badge.label}; this metric cannot be selected until its execution capability is available`}
                          >
                            {badge.label}
                          </span>
                        ) : null}
                        {m.help ? (
                          <span
                            id={helpId}
                            style={{
                              flexBasis: "100%",
                              fontSize: 10,
                              opacity: 0.82,
                              overflowWrap: "anywhere",
                            }}
                          >
                            {m.help}
                          </span>
                        ) : null}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : registry !== null && !regLoading && !regErr ? (
        <div className="muted" style={{ fontSize: 12 }}>
          No metrics are available in the registry yet.
        </div>
      ) : null}

      {/* ---------- 2. Group-by dimensions ---------- */}
      {selectedDefs.length > 0 ? (
        <div className="field">
          <div
            className="field-label"
            style={{ display: "flex", alignItems: "center", gap: 8 }}
          >
            <span>Group by</span>
            <span
              id={dimensionCapReasonId}
              className="muted"
              style={{ fontSize: 11 }}
            >
              {dimCount}/{MAX_DIMENSIONS}
              {!canAddDimension(dimCount) ? " · cap reached" : ""}
            </span>
          </div>
          {availableDims.length > 0 ? (
            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                gap: 6,
                marginTop: 4,
              }}
            >
              {availableDims.map((d) => {
                const checked = selectedDims.includes(d);
                const blockedByCap = !checked && !canAddDimension(dimCount);
                return (
                  <button
                    key={d}
                    type="button"
                    aria-pressed={checked}
                    aria-disabled={blockedByCap || undefined}
                    aria-describedby={
                      blockedByCap ? dimensionCapReasonId : undefined
                    }
                    onClick={() => {
                      if (!blockedByCap) toggleDim(d);
                    }}
                    className="btn btn-sm"
                    style={{
                      borderColor: checked
                        ? "var(--pw-accent)"
                        : "var(--pw-border)",
                      background: checked ? "var(--pw-accent)" : undefined,
                      color: checked ? "var(--pw-accent-fg)" : undefined,
                      opacity: blockedByCap ? 0.5 : 1,
                    }}
                  >
                    {d}
                  </button>
                );
              })}
            </div>
          ) : (
            <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
              The selected metrics don&apos;t declare any group-by dimensions.
            </div>
          )}
        </div>
      ) : null}

      {/* ---------- 3. Time range + name ---------- */}
      {selectedDefs.length > 0 ? (
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: 14,
            alignItems: "flex-end",
          }}
        >
          {/* Honest fixed window: the reporting backend currently
              scopes every metric query to the last 30 days regardless
              of the requested range (repo.go hardcodes interval '30
              days'). Rather than offer a selector that silently does
              nothing, we state the real window. When the backend honors
              a configurable range this becomes a live control. */}
          <div className="field" style={{ minWidth: 160 }}>
            <div className="field-label">Time range</div>
            <div
              className="muted"
              style={{
                fontSize: 12,
                display: "flex",
                alignItems: "center",
                height: 32,
              }}
            >
              Last 30 days{" "}
              <span className="badge" style={{ fontSize: 10, marginLeft: 6 }}>
                fixed
              </span>
            </div>
          </div>
          <div className="field" style={{ flex: 1, minWidth: 200 }}>
            <label className="field-label" htmlFor="rb-name">
              Report name{" "}
              <span className="muted" style={{ fontWeight: 400 }}>
                (required to save)
              </span>
            </label>
            <input
              id="rb-name"
              className="input"
              type="text"
              placeholder="e.g. Weekly engagement by day"
              value={reportName ?? ""}
              onChange={(e) => setReportName(e.target.value)}
              style={{ fontSize: 12 }}
            />
          </div>
        </div>
      ) : null}
    </>
  );
}

interface ReportBuilderOutputProps {
  metricCount: number;
  previewing: boolean;
  reportNameReady: boolean;
  canAdmin: boolean;
  saving: boolean;
  savedDefId: string | null;
  running: boolean;
  shownRows: Array<Record<string, unknown>>;
  exporting: boolean;
  previewErr: string | null;
  previewInvalid: boolean;
  previewErrors: string[];
  previewWarnings: string[];
  runErr: string | null;
  run: ReportRun | null;
  runComplete: boolean;
  showingRunRows: boolean;
  columns: string[];
  preview: ReportPreviewResponse | null;
  runPreview: () => Promise<void>;
  saveDefinition: () => Promise<void>;
  runSaved: () => Promise<void>;
  downloadCsv: () => Promise<void>;
}

function ReportBuilderOutput({
  metricCount,
  previewing,
  reportNameReady,
  canAdmin,
  saving,
  savedDefId,
  running,
  shownRows,
  exporting,
  previewErr,
  previewInvalid,
  previewErrors,
  previewWarnings,
  runErr,
  run,
  runComplete,
  showingRunRows,
  columns,
  preview,
  runPreview,
  saveDefinition,
  runSaved,
  downloadCsv,
}: ReportBuilderOutputProps): ReactElement {
  const previewGuidanceId = useId();
  const saveGuidanceId = useId();
  const runGuidanceId = useId();
  const exportGuidanceId = useId();
  const previewUnavailable = metricCount === 0;
  const saveUnavailable = metricCount === 0 || !reportNameReady;
  const runUnavailable = !savedDefId;
  const exportUnavailable = shownRows.length === 0;
  return (
    <>
      {/* ---------- 4 + 5. Action bar ---------- */}
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 8,
          alignItems: "center",
        }}
      >
        <button
          type="button"
          className="btn btn-sm btn-primary"
          disabled={previewing}
          aria-busy={previewing}
          aria-disabled={previewUnavailable || undefined}
          aria-describedby={previewGuidanceId}
          onClick={() => {
            if (!previewUnavailable) void runPreview();
          }}
        >
          {previewing ? "Running preview…" : "Run preview"}
        </button>

        {canAdmin ? (
          <>
            <button
              type="button"
              className="btn btn-sm"
              disabled={saving}
              aria-busy={saving}
              aria-disabled={saveUnavailable || undefined}
              aria-describedby={saveGuidanceId}
              onClick={() => {
                if (!saveUnavailable) void saveDefinition();
              }}
            >
              {saving ? "Saving…" : "Save report"}
            </button>
            <button
              type="button"
              className="btn btn-sm"
              disabled={running}
              aria-busy={running}
              aria-disabled={runUnavailable || undefined}
              aria-describedby={runGuidanceId}
              onClick={() => {
                if (!runUnavailable) void runSaved();
              }}
            >
              {running ? "Running…" : "Run"}
            </button>
          </>
        ) : (
          <span className="muted" style={{ fontSize: 11 }}>
            Preview is available to everyone; saving &amp; running a report need
            an admin-scoped key.
          </span>
        )}

        <span className="spacer" style={{ flex: 1 }} />

        <button
          type="button"
          className="btn btn-sm"
          disabled={exporting}
          aria-busy={exporting}
          aria-disabled={exportUnavailable || undefined}
          aria-describedby={exportGuidanceId}
          onClick={() => {
            if (!exportUnavailable) void downloadCsv();
          }}
        >
          {exporting ? "Preparing CSV…" : "Download CSV"}
        </button>
      </div>
      <div
        className="muted"
        role="status"
        aria-live="polite"
        style={{ display: "grid", gap: 2, fontSize: 11 }}
      >
        <span id={previewGuidanceId}>
          {previewUnavailable
            ? "Select at least one metric to run a preview."
            : "Preview runs the current unsaved report selection."}
        </span>
        {canAdmin ? (
          <>
            <span id={saveGuidanceId}>
              {metricCount === 0
                ? "Select a metric before saving."
                : !reportNameReady
                  ? "Enter a report name before saving."
                  : "Save stores this report definition for administrators."}
            </span>
            <span id={runGuidanceId}>
              {runUnavailable
                ? "Save this report before running the stored definition."
                : "Run executes the saved definition and polls for its result."}
            </span>
          </>
        ) : null}
        <span id={exportGuidanceId}>
          {exportUnavailable
            ? "Run a preview or saved report to enable CSV export."
            : "CSV export contains exactly the rows currently shown below."}
        </span>
      </div>

      {/* ---------- preview errors (422 / valid:false) verbatim ---------- */}
      {previewErr ? (
        <div className="field-error" role="alert">
          Preview failed: {previewErr}
        </div>
      ) : null}

      {previewInvalid ? (
        <div
          className="card"
          style={{
            padding: "10px 12px",
            border: "1px solid var(--pw-danger)",
            background: "var(--pw-bg-elev)",
          }}
        >
          <div
            className="field-label"
            style={{ color: "var(--pw-danger)", marginBottom: 4 }}
          >
            This report request is invalid
          </div>
          {previewErrors.length > 0 ? (
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {previewErrors.map((e, i) => (
                <li
                  key={`perr-${i}`}
                  className="field-error"
                  style={{ fontSize: 12 }}
                >
                  {e}
                </li>
              ))}
            </ul>
          ) : (
            <div className="field-error" style={{ fontSize: 12 }}>
              The server rejected the request but returned no detail.
            </div>
          )}
        </div>
      ) : null}

      {/* ---------- preview warnings (muted, verbatim) ---------- */}
      {previewWarnings.length > 0 ? (
        <div
          className="muted"
          style={{ fontSize: 11, display: "grid", gap: 2 }}
        >
          {previewWarnings.map((w, i) => (
            <div key={`pwarn-${i}`}>⚠ {w}</div>
          ))}
        </div>
      ) : null}

      {/* ---------- run status / errors ---------- */}
      {runErr ? (
        <div className="field-error" role="alert">
          Run failed: {runErr}
        </div>
      ) : null}
      {run ? (
        <div className="muted" style={{ fontSize: 11 }}>
          Run {run.id} · status:{" "}
          <span
            className="tabular"
            style={{
              color: runComplete
                ? "var(--pw-fg)"
                : (run.status ?? "").toLowerCase() === "failed"
                  ? "var(--pw-danger)"
                  : "var(--pw-fg-muted)",
            }}
          >
            {run.status ?? "unknown"}
          </span>
          {typeof run.rows_total === "number"
            ? ` · ${run.rows_total} row${run.rows_total === 1 ? "" : "s"}`
            : ""}
          {run.error ? (
            <span style={{ color: "var(--pw-danger)" }}>
              {" "}
              · recorded failure
            </span>
          ) : null}
          {showingRunRows
            ? shownRows.length > 0
              ? " · showing run result below"
              : " · completed with no rows"
            : ""}
        </div>
      ) : null}

      {/* ---------- preview / run table ---------- */}
      {columns.length > 0 && (preview != null || run != null) ? (
        shownRows.length === 0 ? (
          <div className="muted" style={{ fontSize: 12 }}>
            {previewInvalid
              ? "No rows — the request was invalid (see above)."
              : "No rows returned for this report. Supported metrics with data in the selected range will populate here."}
          </div>
        ) : (
          <div
            role="region"
            aria-label="Report result table"
            tabIndex={0}
            style={{ overflowX: "auto" }}
          >
            <table
              style={{
                width: "100%",
                borderCollapse: "collapse",
                fontSize: 12,
              }}
            >
              <thead>
                <tr>
                  {columns.map((c) => (
                    <th
                      key={`h-${c}`}
                      style={{
                        textAlign: "left",
                        padding: CELL_PAD,
                        borderBottom: "1px solid var(--pw-border)",
                        color: "var(--pw-fg-subtle)",
                        fontSize: 10,
                        textTransform: "uppercase",
                        letterSpacing: 0.4,
                        fontWeight: 600,
                        whiteSpace: "nowrap",
                      }}
                    >
                      {c}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {shownRows.map((row, ri) => {
                  const safeRow = row && typeof row === "object" ? row : {};
                  return (
                    <tr key={`r-${ri}`}>
                      {columns.map((c) => (
                        <td
                          key={`r-${ri}-${c}`}
                          className="tabular"
                          style={{
                            padding: CELL_PAD,
                            borderBottom: "1px solid var(--pw-border)",
                            color: "var(--pw-fg)",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {cellToString(safeRow[c])}
                        </td>
                      ))}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )
      ) : null}
    </>
  );
}

function useReportRegistry(open: boolean) {
  const [registry, setRegistry] = useState<ReportMetricDefinition[] | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const mountedRef = useRef(true);
  const fetchingRef = useRef(false);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  const load = useCallback(async (): Promise<void> => {
    if (fetchingRef.current) return;
    fetchingRef.current = true;
    setLoading(true);
    setError(null);
    try {
      const res = await reportingApi.metricRegistry();
      if (!mountedRef.current) return;
      if (res.error) {
        setError(remoteFailureFromError(res.error).message);
        setRegistry([]);
        return;
      }
      setRegistry(Array.isArray(res.data?.items) ? res.data.items : []);
    } catch {
      if (!mountedRef.current) return;
      setError(remoteFailureFromError({ kind: "network" }).message);
      setRegistry([]);
    } finally {
      fetchingRef.current = false;
      if (mountedRef.current) setLoading(false);
    }
  }, []);
  useEffect(() => {
    if (open && registry === null && !loading) void load();
  }, [load, loading, open, registry]);
  return { error, load, loading, registry };
}

function ReportBuilderHeader({
  open,
  onToggle,
}: {
  open: boolean;
  onToggle: () => void;
}): ReactElement {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "6px 16px 6px 6px",
      }}
    >
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          flex: 1,
          minWidth: 0,
          padding: "6px 10px",
          background: "transparent",
          border: "none",
          cursor: "pointer",
          textAlign: "left",
          color: "var(--pw-fg)",
          flexWrap: "wrap",
        }}
      >
        <span aria-hidden="true">{open ? "▼" : "▶"}</span>
        <span className="section-title" style={{ marginBottom: 0 }}>
          Report builder
        </span>
        <span className="muted" style={{ fontSize: 11 }}>
          Compose a metric report, preview it live, then save &amp; run it
        </span>
      </button>
    </div>
  );
}

export function ReportBuilderSection(): ReactElement {
  const canAdmin = useCanAdmin();
  const [open, setOpen] = useState(false);
  const {
    registry,
    error: regErr,
    loading: regLoading,
    load: loadRegistry,
  } = useReportRegistry(open);

  // Builder selections.
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
  const [selectedDims, setSelectedDims] = useState<string[]>([]);
  const [reportName, setReportName] = useState("");

  // Preview state.
  const [previewing, setPreviewing] = useState(false);
  const [preview, setPreview] = useState<ReportPreviewResponse | null>(null);
  const [previewErr, setPreviewErr] = useState<string | null>(null);

  // Save / run state.
  const [savedDefId, setSavedDefId] = useState<string | null>(null);
  const [savedRequestFingerprint, setSavedRequestFingerprint] = useState<
    string | null
  >(null);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [run, setRun] = useState<ReportRun | null>(null);
  const [runRequestFingerprint, setRunRequestFingerprint] = useState<
    string | null
  >(null);
  const [runErr, setRunErr] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [previewRequestFingerprint, setPreviewRequestFingerprint] = useState<
    string | null
  >(null);

  // True while mounted — guards the long run-poll loop's setState calls so
  // a collapse/navigate mid-poll can't write to an unmounted instance.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  const previewingRef = useRef(false);
  const savingRef = useRef(false);
  const runningRef = useRef(false);
  const exportingRef = useRef(false);

  const allMetrics = useMemo(
    () => (Array.isArray(registry) ? registry : []),
    [registry],
  );

  const selectedDefs = useMemo(
    () => allMetrics.filter((m) => selectedKeys.includes(m.key)),
    [allMetrics, selectedKeys],
  );

  // Dimensions the current selection supports; "day" defaulted when offered.
  const availableDims = useMemo<string[]>(
    () =>
      // The current repository only executes day-grouped and ungrouped plans.
      // Other registry dimensions are intentionally hidden until request→SQL
      // integration tests prove they affect the returned rows.
      selectableDimensions(selectedDefs).filter(
        (dimension) => dimension === "day",
      ),
    [selectedDefs],
  );

  // Keep selected dims pruned to what's still available as metrics change.
  useEffect(() => {
    setSelectedDims((prev) => {
      const pruned = prev.filter((d) => availableDims.includes(d));
      if (
        pruned.length === 0 &&
        availableDims.includes("day") &&
        selectedKeys.length > 0
      ) {
        return ["day"];
      }
      return pruned.length === prev.length ? prev : pruned;
    });
  }, [availableDims, selectedKeys.length]);

  const toggleMetric = (key: string): void => {
    setSelectedKeys((prev) => {
      if (prev.includes(key)) return prev.filter((k) => k !== key);
      if (!canAddMetric(prev.length)) return prev; // honest cap
      return [...prev, key];
    });
  };

  const toggleDim = (dim: string): void => {
    setSelectedDims((prev) => {
      if (prev.includes(dim)) return prev.filter((d) => d !== dim);
      if (!canAddDimension(prev.length)) return prev;
      return [...prev, dim];
    });
  };

  const draftRequest = useMemo(
    () => buildReportRequest(reportName, selectedKeys, selectedDims),
    [reportName, selectedDims, selectedKeys],
  );
  const draftFingerprint = useMemo(
    () => reportRequestFingerprint(draftRequest),
    [draftRequest],
  );
  const draftFingerprintRef = useRef(draftFingerprint);
  draftFingerprintRef.current = draftFingerprint;
  const savedDefinitionIsCurrent =
    savedDefId != null && savedRequestFingerprint === draftFingerprint;
  const savedDefinitionIsDirty =
    savedDefId != null && savedRequestFingerprint !== draftFingerprint;
  const previousDraftFingerprintRef = useRef(draftFingerprint);
  useEffect(() => {
    if (previousDraftFingerprintRef.current === draftFingerprint) return;
    previousDraftFingerprintRef.current = draftFingerprint;
    setPreviewErr(null);
    setRunErr(null);
  }, [draftFingerprint]);

  const runPreview = async (): Promise<void> => {
    if (selectedKeys.length === 0 || previewingRef.current) return;
    const request = draftRequest;
    const requestFingerprint = draftFingerprint;
    previewingRef.current = true;
    setPreviewing(true);
    setPreviewErr(null);
    // Clear the prior preview too — otherwise a stale `valid:false` banner
    // (or stale rows) shows during the new in-flight request, a misleading
    // "fake failure" while a fresh valid preview is loading.
    setPreview(null);
    // A fresh preview invalidates any prior run result shown below.
    setRun(null);
    setRunRequestFingerprint(null);
    setRunErr(null);
    try {
      const res = await reportingApi.preview(request);
      if (!mountedRef.current) return;
      if (draftFingerprintRef.current !== requestFingerprint) return;
      if (res.error) {
        setPreviewErr(remoteFailureFromError(res.error).message);
        setPreview(null);
        return;
      }
      setPreviewRequestFingerprint(requestFingerprint);
      setPreview(res.data ?? null);
    } catch {
      if (!mountedRef.current) return;
      setPreviewErr(remoteFailureFromError({ kind: "network" }).message);
      setPreview(null);
    } finally {
      previewingRef.current = false;
      if (mountedRef.current) setPreviewing(false);
    }
  };

  const saveDefinition = async (): Promise<void> => {
    if (!canAdmin || savingRef.current || selectedKeys.length === 0) return;
    if (!reportName.trim()) {
      toast.error("Give the report a name before saving.");
      return;
    }
    const request = draftRequest;
    const requestFingerprint = draftFingerprint;
    savingRef.current = true;
    setSaving(true);
    try {
      const res = await reportingApi.upsertDefinition(request);
      if (!mountedRef.current) return;
      if (draftFingerprintRef.current !== requestFingerprint) {
        toast.error(
          "The report changed while it was saving. Review the current draft and save it again.",
        );
        return;
      }
      if (res.error) {
        toast.error(
          res.error.status === 403
            ? "Saving a report needs an admin-scoped API key — this key can't."
            : `Save failed. ${remoteFailureFromError(res.error).message}`,
        );
        return;
      }
      const id = res.data?.id ?? null;
      setSavedDefId(id);
      setSavedRequestFingerprint(requestFingerprint);
      toast.success(`Saved "${res.data?.name ?? reportName.trim()}"`);
    } catch {
      if (!mountedRef.current) return;
      toast.error(
        `Save failed. ${remoteFailureFromError({ kind: "network" }).message}`,
      );
    } finally {
      savingRef.current = false;
      if (mountedRef.current) setSaving(false);
    }
  };

  const runSaved = async (): Promise<void> => {
    if (
      !canAdmin ||
      runningRef.current ||
      !savedDefId ||
      !savedDefinitionIsCurrent
    )
      return;
    const definitionId = savedDefId;
    const requestFingerprint = draftFingerprint;
    runningRef.current = true;
    setRunning(true);
    setRunErr(null);
    setRun(null);
    setRunRequestFingerprint(requestFingerprint);
    try {
      const res = await reportingApi.runDefinition(definitionId);
      if (!mountedRef.current) return;
      if (draftFingerprintRef.current !== requestFingerprint) return;
      if (res.error) {
        setRunErr(
          res.error.status === 403
            ? "Running a report needs an admin-scoped API key — this key can't."
            : remoteFailureFromError(res.error).message,
        );
        return;
      }
      let current = res.data ?? null;
      setRun(current);

      // Poll getRun until terminal (or we hit the ceiling). Honest about
      // status the whole time; render result rows only when complete.
      let attempts = 0;
      while (
        current &&
        !isTerminalRunStatus(current.status) &&
        attempts < RUN_POLL_MAX
      ) {
        attempts += 1;
        await new Promise((resolve) => setTimeout(resolve, RUN_POLL_MS));
        if (!mountedRef.current) return;
        if (draftFingerprintRef.current !== requestFingerprint) return;
        const poll = await reportingApi.getRun(current.id);
        if (!mountedRef.current) return;
        if (draftFingerprintRef.current !== requestFingerprint) return;
        if (poll.error) {
          setRunErr(remoteFailureFromError(poll.error).message);
          break;
        }
        current = poll.data ?? current;
        setRun(current);
      }
      if (!mountedRef.current) return;
      if (current && isTerminalRunStatus(current.status) && current.error) {
        setRunErr(
          "The report run ended with a recorded failure. Use the run reference when contacting support.",
        );
      } else if (
        current &&
        !isTerminalRunStatus(current.status) &&
        attempts >= RUN_POLL_MAX
      ) {
        setRunErr(
          `Run is still ${current.status || "in progress"} after waiting — check the Runs list later.`,
        );
      }
    } catch {
      if (!mountedRef.current) return;
      setRunErr(remoteFailureFromError({ kind: "network" }).message);
    } finally {
      runningRef.current = false;
      if (mountedRef.current) setRunning(false);
    }
  };

  // --- Which rows are currently shown: run result (when complete) wins,
  //     otherwise the preview rows. CSV/table both read from this. ---
  const visiblePreview =
    previewRequestFingerprint === draftFingerprint ? preview : null;
  const visibleRun = runRequestFingerprint === draftFingerprint ? run : null;
  const { runComplete, showingRunRows, shownRows } = resolveShownReportRows(
    visiblePreview,
    visibleRun,
  );

  const columns = useMemo(
    () => deriveColumns(draftRequest, shownRows),
    [draftRequest, shownRows],
  );

  const downloadCsv = async (): Promise<void> => {
    if (exportingRef.current || shownRows.length === 0) return;
    exportingRef.current = true;
    setExporting(true);
    const csv = rowsToCsv(columns, shownRows);
    const base = reportName.trim() || "report";
    try {
      const { saveFile } = await import("../../lib/file-transfer");
      const saved = await saveFile({
        data: csv,
        suggestedName: `${base.replace(/[^\w.-]+/g, "_")}.csv`,
        label: "Analytics report export",
        privacy: "personal",
        mimeType: "text/csv;charset=utf-8",
      });
      if (mountedRef.current && !saved.ok) toast.error(saved.message);
    } catch {
      if (mountedRef.current) {
        toast.error("The CSV export couldn't be prepared.");
      }
    } finally {
      exportingRef.current = false;
      if (mountedRef.current) setExporting(false);
    }
  };

  const {
    warnings: previewWarnings,
    errors: previewErrors,
    invalid: previewInvalid,
  } = reportPreviewFeedback(visiblePreview);

  return (
    <div className="card" style={{ marginTop: 12, padding: 0 }}>
      <ReportBuilderHeader
        open={open}
        onToggle={() => setOpen((current) => !current)}
      />

      {open ? (
        <div style={{ padding: "0 16px 16px", display: "grid", gap: 14 }}>
          <ReportBuilderFields
            registry={registry}
            allMetrics={allMetrics}
            groups={metricsByArea(allMetrics)}
            selectedKeys={selectedKeys}
            metricCount={selectedKeys.length}
            regLoading={regLoading}
            regErr={regErr}
            selectedDefs={selectedDefs}
            dimCount={selectedDims.length}
            availableDims={availableDims}
            selectedDims={selectedDims}
            reportName={reportName}
            loadRegistry={loadRegistry}
            toggleMetric={toggleMetric}
            toggleDim={toggleDim}
            setReportName={setReportName}
          />
          {savedDefinitionIsDirty ? (
            <div className="notice" role="status">
              Draft changed after the last save. Save this exact revision again
              before Run is enabled. Prior preview and run output was detached.
            </div>
          ) : null}
          <ReportBuilderOutput
            metricCount={selectedKeys.length}
            previewing={previewing}
            reportNameReady={reportName.trim().length > 0}
            canAdmin={canAdmin}
            saving={saving}
            savedDefId={savedDefinitionIsCurrent ? savedDefId : null}
            running={running}
            shownRows={shownRows}
            exporting={exporting}
            previewErr={previewErr}
            previewInvalid={previewInvalid}
            previewErrors={previewErrors}
            previewWarnings={previewWarnings}
            runErr={runErr}
            run={visibleRun}
            runComplete={runComplete}
            showingRunRows={showingRunRows}
            columns={columns}
            preview={visiblePreview}
            runPreview={runPreview}
            saveDefinition={saveDefinition}
            runSaved={runSaved}
            downloadCsv={downloadCsv}
          />
        </div>
      ) : null}
    </div>
  );
}
