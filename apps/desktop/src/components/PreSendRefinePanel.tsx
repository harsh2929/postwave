/**
 * PreSendRefinePanel — SUB-067 pre-send audience refine / optimization.
 *
 * Before a campaign goes out, the churn-risk gate can suppress likely-
 * unsubscribers and give them a cooling-off window instead of another
 * email that pushes them to churn. This panel — mounted inside the
 * SendChecklist on draft campaigns — previews the refinement and lets
 * the operator commit (or clear) the exclusion set:
 *
 *   - Churn threshold slider (40..100, default 80): subscribers scoring
 *     at/above this are excluded for a 24h recovery window.
 *   - "Exclude recently paused" toggle: also drops subscribers already
 *     cooling-off under another campaign.
 *   - Preview summary: excluded count, cooling-off count + window, and a
 *     sample of the top-3 highest-risk excluded subscribers with scores.
 *   - "Apply refinement" commits the exclusion set; "Send anyway" /
 *     "Clear" removes it (operator override → everyone re-enters).
 *
 * Backed by (apps/api/internal/subscribers/presend_refine.go):
 *   POST   /api/v1/campaigns/{id}/presend-refine   (dry_run preview / commit)
 *   GET    /api/v1/campaigns/{id}/presend-refine   (active set)
 *   DELETE /api/v1/campaigns/{id}/presend-refine   (clear / force re-entry)
 *
 * Graceful degradation: a 404 (routes not deployed) hides the panel.
 */

import {
  type ReactElement,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";

import {
  type PreSendExcludedSubscriber,
  type PreSendRefineResult,
  presendRefineApi,
} from "../lib/api-client";
import { fmtDateTime } from "../lib/format-date";
import { ConfirmModal } from "./ConfirmModal";
import { toast } from "./Toast";

interface Props {
  campaignID: string | number;
  /** Editor gate — apply/clear require write scope. */
  canMutate?: boolean;
}

/** Slider bounds per the SUB-067 spec (40..100, default 80). */
const MIN_THRESHOLD = 40;
const MAX_THRESHOLD = 100;
const DEFAULT_THRESHOLD = 80;
/** Highest-risk excluded subscribers to surface inline. */
const SAMPLE_SHOWN = 3;

type ActiveRefinementStatus = "loading" | "ready" | "error";

function readError(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim()
    ? error.message
    : fallback;
}

interface RefinementPreviewProps {
  error: string | null;
  loading: boolean;
  preview: PreSendRefineResult | null;
  coolingHours: number;
  sample: PreSendExcludedSubscriber[];
  onRetry: () => void;
}

function RefinementPreview({
  error,
  loading,
  preview,
  coolingHours,
  sample,
  onRetry,
}: RefinementPreviewProps): ReactElement {
  return (
    <>
      {error ? (
        <div className="notice" role="alert" style={{ fontSize: 12 }}>
          <span>Couldn&apos;t preview refinement: {error}</span>
          <span className="spacer" style={{ flex: 1 }} />
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            onClick={onRetry}
          >
            Retry
          </button>
        </div>
      ) : (
        <div
          style={{
            display: "flex",
            gap: 16,
            flexWrap: "wrap",
            fontSize: 12,
            marginBottom: 8,
          }}
        >
          <div>
            <div className="muted" style={{ fontSize: 11 }}>
              Would exclude
            </div>
            <div className="tabular" style={{ fontWeight: 600, fontSize: 15 }}>
              {loading ? "…" : (preview?.excluded_count ?? 0).toLocaleString()}
            </div>
          </div>
          <div>
            <div className="muted" style={{ fontSize: 11 }}>
              Cooling-off ({coolingHours}h)
            </div>
            <div className="tabular" style={{ fontWeight: 600, fontSize: 15 }}>
              {loading
                ? "…"
                : (preview?.cooling_off_count ?? 0).toLocaleString()}
            </div>
          </div>
          {preview?.cooling_off_until ? (
            <div>
              <div className="muted" style={{ fontSize: 11 }}>
                Re-enter after
              </div>
              <div style={{ fontWeight: 600 }}>
                {fmtDateTime(preview.cooling_off_until)}
              </div>
            </div>
          ) : null}
        </div>
      )}

      {sample.length > 0 ? (
        <div style={{ marginBottom: 10 }}>
          <div className="muted" style={{ fontSize: 11 }}>
            Highest-risk excluded
          </div>
          <ul className="presend-risk-sample">
            {sample.map((subscriber) => (
              <li key={subscriber.subscriber_id}>
                <span className="badge warning" style={{ fontSize: 10 }}>
                  Score {subscriber.churn_score}
                </span>
                <span
                  style={{
                    overflowWrap: "anywhere",
                  }}
                >
                  {subscriber.email || subscriber.subscriber_id}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </>
  );
}

function PreSendRefinePanelBody({
  campaignID,
  canMutate = false,
}: Props): ReactElement | null {
  const activeRef = useRef(true);
  const activeRequestRef = useRef(0);
  const previewRequestRef = useRef(0);
  const previewFlightKeyRef = useRef<string | null>(null);
  const operationRef = useRef(false);
  const [threshold, setThreshold] = useState<number>(DEFAULT_THRESHOLD);
  const [excludeRecentlyPaused, setExcludeRecentlyPaused] =
    useState<boolean>(false);
  const [preview, setPreview] = useState<PreSendRefineResult | null>(null);
  const [active, setActive] = useState<PreSendRefineResult | null>(null);
  const [activeStatus, setActiveStatus] =
    useState<ActiveRefinementStatus>("loading");
  const [activeError, setActiveError] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [busy, setBusy] = useState<"apply" | "clear" | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [clearConfirmOpen, setClearConfirmOpen] = useState(false);
  // Latches the panel hidden when the routes 404 on an older deploy.
  const [unavailable, setUnavailable] = useState<boolean>(false);
  const idPrefix = useId();
  const thresholdId = `${idPrefix}-threshold`;
  const guidanceId = `${idPrefix}-guidance`;

  useEffect(() => {
    activeRef.current = true;
    return () => {
      activeRef.current = false;
      activeRequestRef.current += 1;
      previewRequestRef.current += 1;
    };
  }, []);

  /** Load the currently-committed exclusion set (GET). Non-fatal. */
  const loadActive = useCallback(async (): Promise<void> => {
    const requestId = ++activeRequestRef.current;
    setActiveStatus("loading");
    setActiveError(null);
    let res: Awaited<ReturnType<typeof presendRefineApi.get>>;
    try {
      res = await presendRefineApi.get(campaignID);
    } catch (error) {
      if (!activeRef.current || requestId !== activeRequestRef.current) return;
      setActiveStatus("error");
      setActiveError(readError(error, "The saved refinement request failed."));
      return;
    }
    if (!activeRef.current || requestId !== activeRequestRef.current) return;
    if (res.error) {
      if (res.error.status === 404) {
        setUnavailable(true);
        return;
      }
      setActiveStatus("error");
      setActiveError(res.error.message);
      return;
    }
    setActive(res.data);
    setActiveStatus("ready");
  }, [campaignID]);

  useEffect(() => {
    void loadActive();
  }, [loadActive]);

  /** Dry-run preview at the current controls (POST dry_run=true). */
  const runPreview = useCallback(async (): Promise<void> => {
    const requestKey = `${String(campaignID)}\u001f${threshold}\u001f${excludeRecentlyPaused}`;
    if (previewFlightKeyRef.current === requestKey) return;
    previewFlightKeyRef.current = requestKey;
    const requestId = ++previewRequestRef.current;
    setLoading(true);
    setErr(null);
    let res: Awaited<ReturnType<typeof presendRefineApi.preview>>;
    try {
      res = await presendRefineApi.preview(campaignID, {
        churn_threshold: threshold,
        exclude_recently_paused: excludeRecentlyPaused,
        dry_run: true,
      });
    } catch (error) {
      if (previewFlightKeyRef.current === requestKey) {
        previewFlightKeyRef.current = null;
      }
      if (!activeRef.current || requestId !== previewRequestRef.current) return;
      setLoading(false);
      setPreview(null);
      setErr(readError(error, "The preview request failed."));
      return;
    }
    if (previewFlightKeyRef.current === requestKey) {
      previewFlightKeyRef.current = null;
    }
    if (!activeRef.current || requestId !== previewRequestRef.current) return;
    setLoading(false);
    if (res.error) {
      if (res.error.status === 404) {
        setUnavailable(true);
        return;
      }
      setErr(res.error.message);
      setPreview(null);
      return;
    }
    setPreview(res.data);
  }, [campaignID, threshold, excludeRecentlyPaused]);

  // Re-run the preview whenever the controls change (the gate is a cheap
  // count query). Debounced lightly so dragging the slider doesn't fire
  // a request per pixel.
  useEffect(() => {
    if (unavailable) return;
    const t = setTimeout(() => void runPreview(), 250);
    return () => clearTimeout(t);
  }, [runPreview, unavailable]);

  const apply = useCallback(async (): Promise<void> => {
    if (
      !canMutate ||
      operationRef.current ||
      loading ||
      activeStatus !== "ready" ||
      err != null ||
      preview == null
    ) {
      return;
    }
    operationRef.current = true;
    const requestId = ++activeRequestRef.current;
    setBusy("apply");
    let res: Awaited<ReturnType<typeof presendRefineApi.preview>>;
    try {
      res = await presendRefineApi.preview(campaignID, {
        churn_threshold: threshold,
        exclude_recently_paused: excludeRecentlyPaused,
        dry_run: false,
      });
    } catch (error) {
      if (activeRef.current && requestId === activeRequestRef.current) {
        toast.error(
          `Couldn't apply refinement: ${readError(error, "The request failed.")}`,
        );
      }
      return;
    } finally {
      operationRef.current = false;
      if (activeRef.current && requestId === activeRequestRef.current) {
        setBusy(null);
      }
    }
    if (!activeRef.current || requestId !== activeRequestRef.current) return;
    if (res.error) {
      toast.error(`Couldn't apply refinement: ${res.error.message}`);
      return;
    }
    setActive(res.data);
    setActiveStatus("ready");
    setActiveError(null);
    toast.success(
      `Refinement applied — ${res.data.excluded_count.toLocaleString()} subscriber${
        res.data.excluded_count === 1 ? "" : "s"
      } excluded for this send.`,
    );
  }, [
    activeStatus,
    campaignID,
    threshold,
    excludeRecentlyPaused,
    canMutate,
    err,
    loading,
    preview,
  ]);

  const clear = useCallback(async (): Promise<void> => {
    if (
      !canMutate ||
      operationRef.current ||
      activeStatus !== "ready" ||
      (active?.excluded_count ?? 0) === 0
    )
      return;
    operationRef.current = true;
    const requestId = ++activeRequestRef.current;
    setBusy("clear");
    let res: Awaited<ReturnType<typeof presendRefineApi.clear>>;
    try {
      res = await presendRefineApi.clear(campaignID);
    } catch (error) {
      if (activeRef.current && requestId === activeRequestRef.current) {
        toast.error(
          `Couldn't clear exclusions: ${readError(error, "The request failed.")}`,
        );
      }
      return;
    } finally {
      operationRef.current = false;
      if (activeRef.current && requestId === activeRequestRef.current) {
        setBusy(null);
      }
    }
    if (!activeRef.current || requestId !== activeRequestRef.current) return;
    if (res.error) {
      toast.error(`Couldn't clear exclusions: ${res.error.message}`);
      return;
    }
    setActive(null);
    setActiveStatus("ready");
    setActiveError(null);
    setClearConfirmOpen(false);
    toast.success(
      `Send anyway — ${(res.data?.cleared ?? 0).toLocaleString()} exclusion${
        (res.data?.cleared ?? 0) === 1 ? "" : "s"
      } cleared; everyone re-enters this send.`,
    );
  }, [active?.excluded_count, activeStatus, campaignID, canMutate]);

  if (unavailable) return null;

  const activeCount = active?.excluded_count ?? 0;
  const coolingHours = preview?.cooling_off_hours ?? 24;
  const sample = (preview?.affected_subscribers_sample ?? []).slice(
    0,
    SAMPLE_SHOWN,
  );
  const actionGuidance = !canMutate
    ? "Editor access is required to change send exclusions."
    : activeStatus === "loading"
      ? "Wait while Moosewave verifies the currently saved exclusion set."
      : activeStatus === "error"
        ? "Retry saved-state verification before applying or clearing exclusions."
        : busy === "apply"
          ? "Applying this exclusion set. Keep this campaign open until it finishes."
          : busy === "clear"
            ? "Clearing exclusions. Keep this campaign open until it finishes."
            : loading
              ? "Wait for the current preview so the committed exclusion count matches these controls."
              : activeCount === 0
                ? "Apply a refinement before using Send anyway."
                : "Apply replaces the saved exclusion set. Send anyway clears every saved exclusion for this campaign.";

  return (
    <PreSendRefineView
      threshold={threshold}
      thresholdId={thresholdId}
      guidanceId={guidanceId}
      excludeRecentlyPaused={excludeRecentlyPaused}
      preview={preview}
      previewError={err}
      activeStatus={activeStatus}
      activeError={activeError}
      loading={loading}
      busy={busy}
      canMutate={canMutate}
      activeCount={activeCount}
      coolingHours={coolingHours}
      sample={sample}
      actionGuidance={actionGuidance}
      clearConfirmOpen={clearConfirmOpen}
      onThresholdChange={(value) => {
        previewRequestRef.current += 1;
        setLoading(false);
        setPreview(null);
        setThreshold(value);
      }}
      onExcludeRecentlyPausedChange={(value) => {
        previewRequestRef.current += 1;
        setLoading(false);
        setPreview(null);
        setExcludeRecentlyPaused(value);
      }}
      onRetry={() => void runPreview()}
      onRetryActive={() => void loadActive()}
      onApply={() => void apply()}
      onRequestClear={() => {
        if (
          !canMutate ||
          busy != null ||
          activeStatus !== "ready" ||
          activeCount === 0
        ) {
          return;
        }
        setClearConfirmOpen(true);
      }}
      onConfirmClear={clear}
      onCloseClear={() => {
        if (!operationRef.current) setClearConfirmOpen(false);
      }}
    />
  );
}

function PreSendRefineView({
  threshold,
  thresholdId,
  guidanceId,
  excludeRecentlyPaused,
  preview,
  previewError,
  activeStatus,
  activeError,
  loading,
  busy,
  canMutate,
  activeCount,
  coolingHours,
  sample,
  actionGuidance,
  clearConfirmOpen,
  onThresholdChange,
  onExcludeRecentlyPausedChange,
  onRetry,
  onRetryActive,
  onApply,
  onRequestClear,
  onConfirmClear,
  onCloseClear,
}: {
  threshold: number;
  thresholdId: string;
  guidanceId: string;
  excludeRecentlyPaused: boolean;
  preview: PreSendRefineResult | null;
  previewError: string | null;
  activeStatus: ActiveRefinementStatus;
  activeError: string | null;
  loading: boolean;
  busy: "apply" | "clear" | null;
  canMutate: boolean;
  activeCount: number;
  coolingHours: number;
  sample: PreSendExcludedSubscriber[];
  actionGuidance: string;
  clearConfirmOpen: boolean;
  onThresholdChange: (value: number) => void;
  onExcludeRecentlyPausedChange: (value: boolean) => void;
  onRetry: () => void;
  onRetryActive: () => void;
  onApply: () => void;
  onRequestClear: () => void;
  onConfirmClear: () => Promise<void>;
  onCloseClear: () => void;
}): ReactElement {
  return (
    <div
      style={{
        marginTop: 12,
        border: "1px solid var(--pw-border)",
        borderRadius: 6,
        padding: "10px 12px",
        background: "var(--pw-bg-elev)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          flexWrap: "wrap",
        }}
      >
        <span style={{ fontWeight: 600, fontSize: 13 }}>
          Audience refinement
        </span>
        {activeStatus === "loading" ? (
          <span className="badge" style={{ fontSize: 11 }}>
            Checking saved state…
          </span>
        ) : activeStatus === "error" ? (
          <span className="badge warning" style={{ fontSize: 11 }}>
            Saved state unavailable
          </span>
        ) : activeCount > 0 ? (
          <span className="badge accent" style={{ fontSize: 11 }}>
            {activeCount.toLocaleString()} excluded
          </span>
        ) : (
          <span className="badge" style={{ fontSize: 11 }}>
            Not applied
          </span>
        )}
      </div>
      {activeStatus === "error" ? (
        <div className="notice" role="alert" style={{ fontSize: 12 }}>
          <span>
            Couldn&apos;t verify the saved refinement
            {activeError ? `: ${activeError}` : "."}
          </span>
          <span className="spacer" style={{ flex: 1 }} />
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            onClick={onRetryActive}
          >
            Retry saved state
          </button>
        </div>
      ) : null}
      <p className="muted" style={{ fontSize: 12, margin: "4px 0 10px" }}>
        Suppress likely-unsubscribers at send time and give them a cooling-off
        window instead. Subscribers scoring &ge; {threshold} are ~2 days from
        unsubscribing; excluding them pauses them for a {coolingHours}h recovery
        window before they re-enter the eligible pool.
      </p>

      {/* Churn threshold slider */}
      <div style={{ marginBottom: 10 }}>
        <label
          htmlFor={thresholdId}
          className="muted"
          style={{
            fontSize: 12,
            display: "flex",
            justifyContent: "space-between",
          }}
        >
          <span>Churn-risk threshold</span>
          <span className="tabular" style={{ fontWeight: 600 }}>
            &ge; {threshold}
          </span>
        </label>
        <input
          id={thresholdId}
          type="range"
          min={MIN_THRESHOLD}
          max={MAX_THRESHOLD}
          step={1}
          value={threshold}
          disabled={busy != null}
          onChange={(event) => onThresholdChange(Number(event.target.value))}
          style={{ width: "100%" }}
          aria-valuemin={MIN_THRESHOLD}
          aria-valuemax={MAX_THRESHOLD}
          aria-valuenow={threshold}
          aria-valuetext={`Churn score ${threshold} and above`}
        />
        <div
          className="muted tabular"
          style={{
            fontSize: 10,
            display: "flex",
            justifyContent: "space-between",
          }}
        >
          <span>{MIN_THRESHOLD} (broad)</span>
          <span>{MAX_THRESHOLD} (only highest risk)</span>
        </div>
      </div>

      {/* Exclude-recently-paused toggle */}
      <label
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          fontSize: 12,
          marginBottom: 10,
          cursor: "pointer",
        }}
      >
        <input
          type="checkbox"
          checked={excludeRecentlyPaused}
          disabled={busy != null}
          onChange={(event) =>
            onExcludeRecentlyPausedChange(event.target.checked)
          }
        />
        <span>
          Also exclude subscribers already cooling-off under another campaign
        </span>
      </label>

      <RefinementPreview
        error={previewError}
        loading={loading}
        preview={preview}
        coolingHours={coolingHours}
        sample={sample}
        onRetry={onRetry}
      />

      <p
        id={guidanceId}
        className="muted"
        role="status"
        aria-live="polite"
        style={{ fontSize: 11, margin: "0 0 8px" }}
      >
        {actionGuidance}
      </p>

      {/* Actions */}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button
          type="button"
          className="btn btn-sm"
          onClick={onApply}
          disabled={
            busy != null ||
            !canMutate ||
            loading ||
            activeStatus !== "ready" ||
            previewError != null ||
            preview == null
          }
          aria-describedby={guidanceId}
        >
          {busy === "apply" ? "Applying…" : "Apply refinement"}
        </button>
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          onClick={onRequestClear}
          disabled={
            busy != null ||
            !canMutate ||
            activeStatus !== "ready" ||
            activeCount === 0
          }
          aria-describedby={guidanceId}
        >
          {busy === "clear" ? "Clearing…" : "Send anyway"}
        </button>
      </div>
      <ConfirmModal
        open={clearConfirmOpen}
        title="Clear audience refinement?"
        description={`All ${activeCount.toLocaleString()} saved exclusion${
          activeCount === 1 ? "" : "s"
        } will re-enter this send. This does not delete subscribers or change their churn scores.`}
        confirmLabel="Clear exclusions and send anyway"
        cancelLabel="Keep refinement"
        danger
        busy={busy === "clear"}
        onConfirm={onConfirmClear}
        onClose={onCloseClear}
      />
    </div>
  );
}

/** Reset request and result state when the checklist switches campaigns. */
export function PreSendRefinePanel(props: Props): ReactElement {
  return <PreSendRefinePanelBody key={props.campaignID} {...props} />;
}
