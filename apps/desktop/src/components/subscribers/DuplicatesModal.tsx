/**
 * Exhaustive subscriber duplicate review.
 *
 * Discovery is materialized by the server as an immutable, cursor-paged scan.
 * The modal never turns a partial browser sample into a "no duplicates" claim.
 * Every apply is bound to the scan, both row versions, and the exact dry-run
 * fingerprint the operator reviewed.
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
  type MergeApplyResponse,
  type SubscriberDuplicatePair,
  type SubscriberDuplicateScan,
  api,
  deduplicationSettingsApi,
  mergeApplyApi,
} from "../../lib/api-client";
import { useCanAdmin } from "../../lib/store";
import { ConfirmModal } from "../ConfirmModal";
import { Modal, ModalFooter } from "../Modal";
import { toast } from "../Toast";
import {
  buildPlanRows,
  isAlreadyMerged,
  moveCountersCopy,
} from "./merge-plan-helpers";

import "./subscribers-dedupe.css";

interface Props {
  open: boolean;
  onClose: () => void;
  onMerged: () => void;
}

const THRESHOLD_LS_KEY = "postwave.subscribers.dedupe.threshold";
const THRESHOLD_MIN = 0.8;
const THRESHOLD_MAX = 1;
const PAGE_SIZE = 50;

const KIND_LABEL: Record<string, string> = {
  case_diff: "Email normalization",
  plus_alias: "Plus alias",
  dot_alias: "Gmail dots",
  domain_substitution: "Equivalent domain",
  homoglyph: "Look-alike characters",
  phone_collision: "Shared phone",
  external_id_collision: "Shared upstream ID",
};

type PairState = "ready" | "merged" | "stale" | "failed";

interface MergeDirection {
  primaryId: string;
  primaryEmail: string;
  primaryUpdatedAt: string;
  duplicateId: string;
  duplicateEmail: string;
  duplicateUpdatedAt: string;
}

function pairKey(pair: SubscriberDuplicatePair): string {
  return `${pair.primary_id}:${pair.duplicate_id}`;
}

function clampThreshold(value: number): number {
  if (!Number.isFinite(value)) return 0.85;
  return Math.min(THRESHOLD_MAX, Math.max(THRESHOLD_MIN, value));
}

function readThreshold(): number {
  try {
    const value = localStorage.getItem(THRESHOLD_LS_KEY);
    return value ? clampThreshold(Number(value)) : 0.85;
  } catch {
    return 0.85;
  }
}

function writeThreshold(value: number): void {
  try {
    localStorage.setItem(THRESHOLD_LS_KEY, String(value));
  } catch {
    // Storage can be unavailable in private/native profiles. The current
    // session remains fully functional.
  }
}

function scanErrorCopy(code?: string): string {
  switch (code) {
    case "aborted":
      return "The scan was cancelled.";
    case "offline":
      return "Connect to the internet to run a complete duplicate scan.";
    case "scan_expired":
      return "That scan expired. Start a fresh scan before reviewing rows.";
    case "duplicate_scan_in_progress":
      return "Another complete scan is already running for this workspace. Wait a moment, then try again.";
    case "invalid_subscriber_response_contract":
      return "The scanner returned an incomplete manifest. Merge controls stayed disabled.";
    default:
      return "The complete scan could not be verified. No merge controls were enabled; try again.";
  }
}

function applyErrorCopy(code?: string): string {
  switch (code) {
    case "stale_review":
      return "One of these rows changed after review. Refresh the scan before merging.";
    case "candidate_stale":
    case "scan_expired":
      return "This candidate is no longer covered by the verified scan. Start a fresh scan.";
    case "idempotency_key_in_progress":
      return "This merge is still being confirmed. Wait a moment, then retry the same candidate.";
    case "offline":
      return "Reconnect before applying this merge.";
    default:
      return "The merge could not be verified. The candidate was kept for a safe retry.";
  }
}

function resolveDirection(
  pair: SubscriberDuplicatePair,
  swapped: boolean,
): MergeDirection {
  return swapped
    ? {
        primaryId: pair.duplicate_id,
        primaryEmail: pair.duplicate_email,
        primaryUpdatedAt: pair.duplicate_updated_at,
        duplicateId: pair.primary_id,
        duplicateEmail: pair.primary_email,
        duplicateUpdatedAt: pair.primary_updated_at,
      }
    : {
        primaryId: pair.primary_id,
        primaryEmail: pair.primary_email,
        primaryUpdatedAt: pair.primary_updated_at,
        duplicateId: pair.duplicate_id,
        duplicateEmail: pair.duplicate_email,
        duplicateUpdatedAt: pair.duplicate_updated_at,
      };
}

function ThresholdControl({
  value,
  saved,
  saving,
  unavailable,
  error,
  canAdmin,
  helpId,
  onChange,
  onSave,
}: {
  value: number;
  saved: number | null;
  saving: boolean;
  unavailable: boolean;
  error: string | null;
  canAdmin: boolean;
  helpId: string;
  onChange: (value: number) => void;
  onSave: () => void;
}): ReactElement {
  const dirty = saved !== null && saved !== value;
  return (
    <section className="dedupe-threshold" aria-labelledby={`${helpId}-label`}>
      <div className="dedupe-threshold__row">
        <label id={`${helpId}-label`} htmlFor="dedupe-threshold">
          Review confidence
        </label>
        <input
          id="dedupe-threshold"
          type="range"
          min={THRESHOLD_MIN}
          max={THRESHOLD_MAX}
          step={0.01}
          value={value}
          onChange={(event) => onChange(Number(event.target.value))}
          aria-describedby={helpId}
        />
        <output htmlFor="dedupe-threshold" className="tabular">
          {(value * 100).toFixed(0)}%
        </output>
        {!unavailable ? (
          <button
            type="button"
            className="btn btn-sm"
            onClick={onSave}
            disabled={saving || !canAdmin || !dirty}
          >
            {saving ? "Saving…" : "Save default"}
          </button>
        ) : null}
      </div>
      <p id={helpId}>
        {unavailable
          ? "The workspace default is unavailable. Your local filter remains active on this device."
          : !canAdmin
            ? "Your local filter is active. Workspace admins can change the cross-device default."
            : saved === null
              ? "Loading the workspace default. The complete manifest remains unchanged."
              : dirty
                ? `Local review filter differs from the ${(saved * 100).toFixed(0)}% workspace default.`
                : `Showing candidates at or above the ${(saved * 100).toFixed(0)}% workspace default.`}
      </p>
      {error ? (
        <p className="field-error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}

function ScanSummary({
  scan,
  loaded,
  visible,
  merged,
}: {
  scan: SubscriberDuplicateScan;
  loaded: number;
  visible: number;
  merged: number;
}): ReactElement {
  return (
    <section className="dedupe-summary" aria-label="Verified scan summary">
      <div>
        <strong>{scan.subscriber_count.toLocaleString()}</strong>
        <span>active profiles checked</span>
      </div>
      <div>
        <strong>{scan.candidate_count.toLocaleString()}</strong>
        <span>candidate pairs found</span>
      </div>
      <div>
        <strong>{loaded.toLocaleString()}</strong>
        <span>pairs loaded</span>
      </div>
      <div>
        <strong>{visible.toLocaleString()}</strong>
        <span>above this filter</span>
      </div>
      <div>
        <strong>{merged.toLocaleString()}</strong>
        <span>merged this session</span>
      </div>
    </section>
  );
}

function CandidateTable({
  pairs,
  states,
  activeKey,
  onReview,
}: {
  pairs: SubscriberDuplicatePair[];
  states: Record<string, PairState>;
  activeKey: string | null;
  onReview: (pair: SubscriberDuplicatePair) => void;
}): ReactElement {
  /* eslint-disable jsx-a11y/no-noninteractive-tabindex -- This named overflow region must be keyboard-focusable so arrow keys can scroll its wide evidence table. */
  return (
    <div
      className="dedupe-table-scroll"
      role="region"
      aria-label="Duplicate candidate pairs"
      tabIndex={0}
    >
      <table className="dedupe-table">
        <caption className="sr-only">
          Subscriber pairs, server evidence, confidence, review state, and merge
          controls
        </caption>
        <thead>
          <tr>
            <th scope="col">Subscriber pair</th>
            <th scope="col">Server evidence</th>
            <th scope="col">Confidence</th>
            <th scope="col">Review state</th>
            <th scope="col">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {pairs.map((pair) => {
            const key = pairKey(pair);
            const state = pair.stale ? "stale" : (states[key] ?? "ready");
            const disabled =
              activeKey !== null || state === "merged" || state === "stale";
            return (
              <tr key={key} data-state={state}>
                <td data-label="Subscriber pair">
                  <span className="dedupe-pair__label">Suggested survivor</span>
                  <strong className="dedupe-email" title={pair.primary_email}>
                    {pair.primary_email || "Unavailable profile"}
                  </strong>
                  <span className="dedupe-pair__arrow" aria-hidden="true">
                    ←
                  </span>
                  <span className="dedupe-email" title={pair.duplicate_email}>
                    {pair.duplicate_email || "Unavailable profile"}
                  </span>
                </td>
                <td data-label="Server evidence">
                  <ul className="dedupe-evidence-list">
                    {pair.evidence.map((evidence) => (
                      <li key={evidence.kind}>
                        <span className="dedupe-evidence-kind">
                          {KIND_LABEL[evidence.kind] ?? evidence.kind}
                        </span>
                        <span>{evidence.reason}</span>
                        <span className="sr-only">
                          {` Confidence ${(evidence.confidence * 100).toFixed(0)} percent.`}
                        </span>
                      </li>
                    ))}
                  </ul>
                </td>
                <td data-label="Confidence">
                  <span className="dedupe-confidence tabular">
                    {(pair.confidence * 100).toFixed(0)}%
                  </span>
                  <span className="dedupe-confidence__label">
                    {pair.confidence >= 0.98
                      ? "Strong identity signal"
                      : pair.confidence >= 0.9
                        ? "Review recommended"
                        : "High scrutiny"}
                  </span>
                </td>
                <td data-label="Review state">
                  <span
                    className={`dedupe-state dedupe-state--${state}`}
                    role="status"
                  >
                    {state === "ready"
                      ? "Ready to review"
                      : state === "merged"
                        ? "Merged"
                        : state === "failed"
                          ? "Retry available"
                          : "Rescan required"}
                  </span>
                </td>
                <td>
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => onReview(pair)}
                    disabled={disabled}
                    aria-label={`${state === "failed" ? "Retry review" : "Review merge"} for candidate pair`}
                  >
                    {activeKey === key
                      ? "Working…"
                      : state === "failed"
                        ? "Retry review"
                        : "Review merge"}
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
  /* eslint-enable jsx-a11y/no-noninteractive-tabindex */
}

function MergeReview({
  pair,
  scanID,
  swapped,
  plan,
  loading,
  applying,
  error,
  onSwap,
  onRetryPlan,
  onClose,
  onConfirm,
}: {
  pair: SubscriberDuplicatePair | null;
  scanID: string | null;
  swapped: boolean;
  plan: MergeApplyResponse | null;
  loading: boolean;
  applying: boolean;
  error: string | null;
  onSwap: (swapped: boolean) => void;
  onRetryPlan: () => void;
  onClose: () => void;
  onConfirm: () => void;
}): ReactElement {
  const initialReviewRef = useRef<HTMLInputElement | null>(null);
  const direction = pair ? resolveDirection(pair, swapped) : null;
  const validPlan =
    plan !== null &&
    direction !== null &&
    plan.primary_id === direction.primaryId &&
    plan.duplicate_id === direction.duplicateId;
  return (
    <ConfirmModal
      open={pair !== null}
      title="Review one subscriber merge"
      description="Choose the surviving row, inspect every server decision, then type MERGE."
      confirmLabel="Apply reviewed merge"
      typeToConfirm="MERGE"
      danger
      busy={applying}
      confirmDisabled={!validPlan || loading || Boolean(error) || !scanID}
      initialFocusRef={initialReviewRef}
      onClose={onClose}
      onConfirm={onConfirm}
    >
      {pair && direction ? (
        <div className="dedupe-review">
          <section
            className="dedupe-review__evidence"
            aria-labelledby="merge-evidence-title"
          >
            <h3 id="merge-evidence-title">Why this pair was surfaced</h3>
            <ul>
              {pair.evidence.map((evidence) => (
                <li key={evidence.kind}>
                  <strong>{KIND_LABEL[evidence.kind] ?? evidence.kind}</strong>
                  <span>{evidence.reason}</span>
                  <span className="tabular">
                    {(evidence.confidence * 100).toFixed(0)}%
                  </span>
                </li>
              ))}
            </ul>
          </section>

          <fieldset
            className="dedupe-primary-choice"
            disabled={applying || loading}
          >
            <legend>Row that survives</legend>
            {[false, true].map((isSwapped) => {
              const choice = resolveDirection(pair, isSwapped);
              const choiceID = `dedupe-primary-${pairKey(pair)}-${isSwapped ? "duplicate" : "primary"}`;
              return (
                <label key={String(isSwapped)} htmlFor={choiceID}>
                  <span className="sr-only">Keep this subscriber as primary</span>
                  <input
                    ref={!isSwapped ? initialReviewRef : undefined}
                    id={choiceID}
                    type="radio"
                    name="merge-primary"
                    checked={swapped === isSwapped}
                    onChange={() => onSwap(isSwapped)}
                  />
                  <span>
                    <strong>{choice.primaryEmail}</strong>
                    <small>
                      {isSwapped
                        ? "Keep this row instead"
                        : "Server suggestion · oldest matching row"}
                    </small>
                  </span>
                </label>
              );
            })}
          </fieldset>

          <div className="dedupe-review__direction" role="note">
            <strong>{direction.primaryEmail}</strong> survives.{" "}
            <strong>{direction.duplicateEmail}</strong> becomes disabled and
            auditable; it is not erased.
          </div>

          <section
            className="dedupe-plan"
            aria-labelledby="merge-plan-title"
            aria-busy={loading}
          >
            <div className="dedupe-plan__heading">
              <h3 id="merge-plan-title">Exact server plan</h3>
              {error ? (
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={onRetryPlan}
                  disabled={loading || applying}
                >
                  Recompute plan
                </button>
              ) : null}
            </div>
            {loading ? (
              <div className="dedupe-plan__loading" role="status">
                <span className="dedupe-spinner" aria-hidden="true" />
                Locking the row versions and computing the plan…
              </div>
            ) : error ? (
              <p className="field-error" role="alert">
                {error}
              </p>
            ) : plan ? (
              <>
                <dl className="dedupe-plan__rows">
                  {buildPlanRows(plan.plan).map((row) => (
                    <div key={row.label}>
                      <dt>{row.label}</dt>
                      <dd>{row.value}</dd>
                    </div>
                  ))}
                </dl>
                <section
                  className="dedupe-conflicts"
                  aria-labelledby="merge-conflicts-title"
                >
                  <h4 id="merge-conflicts-title">
                    {plan.plan.conflicts.length.toLocaleString()} conflict
                    {plan.plan.conflicts.length === 1 ? "" : "s"}
                  </h4>
                  {plan.plan.conflicts.length === 0 ? (
                    <p>No overlapping values disagree.</p>
                  ) : (
                    <div className="dedupe-conflicts__scroll">
                      <table>
                        <thead>
                          <tr>
                            <th scope="col">Field</th>
                            <th scope="col">Survivor value</th>
                            <th scope="col">Source value</th>
                            <th scope="col">Outcome</th>
                          </tr>
                        </thead>
                        <tbody>
                          {plan.plan.conflicts.map((conflict) => (
                            <tr key={conflict.field}>
                              <th scope="row">{conflict.field}</th>
                              <td>{String(conflict.primary_value ?? "—")}</td>
                              <td>{String(conflict.duplicate_value ?? "—")}</td>
                              <td>
                                {conflict.resolution === "most_restrictive_wins"
                                  ? "Most restrictive wins"
                                  : "Survivor wins"}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </section>
                <section
                  className="dedupe-preserved"
                  aria-labelledby="merge-preserved-title"
                >
                  <h4 id="merge-preserved-title">
                    Remains on the disabled source row
                  </h4>
                  <ul>
                    {plan.plan.preserved_on_duplicate.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                  <p>{moveCountersCopy(plan)}</p>
                </section>
              </>
            ) : null}
          </section>
        </div>
      ) : null}
    </ConfirmModal>
  );
}

export function DuplicatesModal({
  open,
  onClose,
  onMerged,
}: Props): ReactElement {
  const canAdmin = useCanAdmin();
  const thresholdHelpId = useId();
  const requestGeneration = useRef(0);
  const loadedPairKeys = useRef(new Set<string>());
  const scanAbort = useRef<AbortController | null>(null);
  const pageAbort = useRef<AbortController | null>(null);
  const planAbort = useRef<AbortController | null>(null);

  const [scan, setScan] = useState<SubscriberDuplicateScan | null>(null);
  const [pairs, setPairs] = useState<SubscriberDuplicatePair[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [loadingPage, setLoadingPage] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [threshold, setThreshold] = useState(readThreshold);
  const [savedThreshold, setSavedThreshold] = useState<number | null>(null);
  const [thresholdUnavailable, setThresholdUnavailable] = useState(false);
  const [thresholdError, setThresholdError] = useState<string | null>(null);
  const [savingThreshold, setSavingThreshold] = useState(false);
  const thresholdSaveBusy = useRef(false);
  const [pairStates, setPairStates] = useState<Record<string, PairState>>({});
  const [pending, setPending] = useState<SubscriberDuplicatePair | null>(null);
  const [swapped, setSwapped] = useState(false);
  const [plan, setPlan] = useState<MergeApplyResponse | null>(null);
  const [planLoading, setPlanLoading] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);

  const cancelRequests = useCallback((): void => {
    scanAbort.current?.abort();
    pageAbort.current?.abort();
    planAbort.current?.abort();
    scanAbort.current = null;
    pageAbort.current = null;
    planAbort.current = null;
  }, []);

  const resetReview = useCallback((): void => {
    planAbort.current?.abort();
    planAbort.current = null;
    setPending(null);
    setPlan(null);
    setPlanError(null);
    setPlanLoading(false);
    setSwapped(false);
  }, []);

  const loadPage = useCallback(
    async (scanID: string, cursor?: string): Promise<void> => {
      pageAbort.current?.abort();
      const controller = new AbortController();
      pageAbort.current = controller;
      const generation = requestGeneration.current;
      setLoadingPage(true);
      const result = await api.listSubscriberDuplicateScanPairs(scanID, {
        cursor,
        limit: PAGE_SIZE,
        signal: controller.signal,
      });
      if (controller.signal.aborted || generation !== requestGeneration.current)
        return;
      setLoadingPage(false);
      pageAbort.current = null;
      if (result.error) {
        setScanError(scanErrorCopy(result.error.code));
        return;
      }
      if (
        result.data.pairs.some((pair) => loadedPairKeys.current.has(pairKey(pair)))
      ) {
        setScanError(scanErrorCopy("invalid_subscriber_response_contract"));
        return;
      }
      for (const pair of result.data.pairs) {
        loadedPairKeys.current.add(pairKey(pair));
      }
      setScan(result.data.scan);
      setPairs((current) => [...current, ...result.data.pairs]);
      setNextCursor(result.data.next_cursor ?? null);
    },
    [],
  );

  const startScan = useCallback(async (): Promise<void> => {
    cancelRequests();
    const controller = new AbortController();
    scanAbort.current = controller;
    const generation = ++requestGeneration.current;
    resetReview();
    setScanning(true);
    setLoadingPage(false);
    setScanError(null);
    setScan(null);
    setPairs([]);
    loadedPairKeys.current.clear();
    setPairStates({});
    setNextCursor(null);
    const result = await api.startSubscriberDuplicateScan({
      signal: controller.signal,
    });
    if (controller.signal.aborted || generation !== requestGeneration.current)
      return;
    scanAbort.current = null;
    setScanning(false);
    if (result.error) {
      setScanError(scanErrorCopy(result.error.code));
      return;
    }
    setScan(result.data);
    await loadPage(result.data.scan_id);
  }, [cancelRequests, loadPage, resetReview]);

  useEffect(() => {
    if (!open) {
      requestGeneration.current += 1;
      cancelRequests();
      resetReview();
      setScan(null);
      setPairs([]);
      loadedPairKeys.current.clear();
      setNextCursor(null);
      setScanError(null);
      setScanning(false);
      setLoadingPage(false);
      setApplying(false);
      setSavingThreshold(false);
      thresholdSaveBusy.current = false;
      return;
    }
    void startScan();
    return () => {
      requestGeneration.current += 1;
      cancelRequests();
    };
  }, [open, cancelRequests, resetReview, startScan]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setSavedThreshold(null);
    setThresholdUnavailable(false);
    setThresholdError(null);
    void (async () => {
      const result = await deduplicationSettingsApi.get();
      if (cancelled) return;
      if (result.error) {
        setThresholdUnavailable(true);
        return;
      }
      setThresholdUnavailable(false);
      const value = clampThreshold(result.data.merge_confidence_threshold);
      setSavedThreshold(value);
      setThreshold(value);
      writeThreshold(value);
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  const saveThreshold = async (): Promise<void> => {
    if (!canAdmin || thresholdSaveBusy.current || savedThreshold === threshold)
      return;
    thresholdSaveBusy.current = true;
    const generation = requestGeneration.current;
    setSavingThreshold(true);
    setThresholdError(null);
    const result = await deduplicationSettingsApi.update({
      merge_confidence_threshold: threshold,
    });
    thresholdSaveBusy.current = false;
    if (generation !== requestGeneration.current) return;
    setSavingThreshold(false);
    if (result.error) {
      setThresholdError(
        "The workspace review default could not be saved. Your local filter is unchanged.",
      );
      return;
    }
    const value = clampThreshold(result.data.merge_confidence_threshold);
    setSavedThreshold(value);
    setThreshold(value);
    writeThreshold(value);
    toast.success({
      message: "Duplicate-review default saved",
      detail: `The workspace now starts at ${(value * 100).toFixed(0)}% confidence.`,
    });
  };

  const requestPlan = useCallback(
    async (
      pair: SubscriberDuplicatePair,
      isSwapped: boolean,
    ): Promise<void> => {
      if (!scan) return;
      planAbort.current?.abort();
      const controller = new AbortController();
      planAbort.current = controller;
      const generation = requestGeneration.current;
      const direction = resolveDirection(pair, isSwapped);
      setPlan(null);
      setPlanError(null);
      setPlanLoading(true);
      const result = await mergeApplyApi.apply(
        {
          primary_id: direction.primaryId,
          duplicate_id: direction.duplicateId,
          scan_id: scan.scan_id,
          expected_primary_updated_at: direction.primaryUpdatedAt,
          expected_duplicate_updated_at: direction.duplicateUpdatedAt,
          dry_run: true,
        },
        { signal: controller.signal },
      );
      if (
        controller.signal.aborted ||
        generation !== requestGeneration.current ||
        (pending && pairKey(pending) !== pairKey(pair))
      )
        return;
      planAbort.current = null;
      setPlanLoading(false);
      if (result.error) {
        setPlanError(applyErrorCopy(result.error.code));
        if (result.error.code === "scan_expired") {
          setScanError(scanErrorCopy("scan_expired"));
        }
        const stale = [
          "stale_review",
          "candidate_stale",
          "scan_expired",
        ].includes(result.error.code ?? "");
        setPairStates((current) => ({
          ...current,
          [pairKey(pair)]: stale ? "stale" : "failed",
        }));
        return;
      }
      setPlan(result.data);
    },
    [scan, pending],
  );

  useEffect(() => {
    if (!pending) return;
    void requestPlan(pending, swapped);
    return () => planAbort.current?.abort();
  }, [pending, swapped, requestPlan]);

  const applyMerge = async (): Promise<void> => {
    if (!pending || !plan || !scan || applying) return;
    const pair = pending;
    const key = pairKey(pair);
    const direction = resolveDirection(pair, swapped);
    const generation = requestGeneration.current;
    setApplying(true);
    setPlanError(null);
    const result = await mergeApplyApi.apply({
      primary_id: direction.primaryId,
      duplicate_id: direction.duplicateId,
      scan_id: scan.scan_id,
      expected_primary_updated_at: direction.primaryUpdatedAt,
      expected_duplicate_updated_at: direction.duplicateUpdatedAt,
      expected_plan_fingerprint: plan.plan_fingerprint,
      dry_run: false,
    });
    if (generation !== requestGeneration.current) return;
    setApplying(false);
    if (result.error) {
      if (result.error.code === "scan_expired") {
        setScanError(scanErrorCopy("scan_expired"));
      }
      if (isAlreadyMerged(result)) {
        setPairStates((current) => ({ ...current, [key]: "merged" }));
        resetReview();
        onMerged();
        return;
      }
      const stale = [
        "stale_review",
        "candidate_stale",
        "scan_expired",
      ].includes(result.error.code ?? "");
      setPairStates((current) => ({
        ...current,
        [key]: stale ? "stale" : "failed",
      }));
      setPlanError(applyErrorCopy(result.error.code));
      return;
    }
    setPairStates((current) => ({ ...current, [key]: "merged" }));
    resetReview();
    toast.success({
      message: "Subscriber rows merged",
      detail:
        moveCountersCopy(result.data) +
        " The disabled source row remains auditable.",
    });
    onMerged();
  };

  const visiblePairs = useMemo(
    () => pairs.filter((pair) => pair.confidence >= threshold),
    [pairs, threshold],
  );
  const mergedCount = Object.values(pairStates).filter(
    (state) => state === "merged",
  ).length;
  const activeKey = applying && pending ? pairKey(pending) : null;

  return (
    <Modal
      open={open}
      onClose={() => {
        if (!applying) onClose();
      }}
      closeDisabled={applying}
      closeOnBackdrop={!applying}
      closeOnEscape={!applying}
      size="xl"
      title="Duplicate review workspace"
      description="A complete server scan, evidence for every candidate, and one version-bound review per merge."
    >
      <div className="dedupe-workspace">
        <div className="dedupe-workspace__toolbar">
          <div>
            <span className="dedupe-eyebrow">Identity resolution</span>
            <p>
              Deterministic email, phone, and upstream-ID equivalence rules are
              checked across every active profile. Edit-distance guesses are
              intentionally excluded.
            </p>
          </div>
          <button
            type="button"
            className="btn"
            onClick={() => void startScan()}
            disabled={scanning || applying}
          >
            {scanning
              ? "Scanning every profile…"
              : scan
                ? "Start fresh scan"
                : "Run complete scan"}
          </button>
        </div>

        {scanning ? (
          <div className="dedupe-scanning" role="status" aria-live="polite">
            <span className="dedupe-spinner" aria-hidden="true" />
            <div>
              <strong>Building a complete manifest</strong>
              <span>
                The server is evaluating indexed identity signals. No partial
                result will be called complete.
              </span>
            </div>
          </div>
        ) : null}

        {scanError ? (
          <div className="dedupe-error" role="alert">
            <span>{scanError}</span>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => void startScan()}
              disabled={scanning}
            >
              Try a fresh scan
            </button>
          </div>
        ) : null}

        {scan ? (
          <>
            <ScanSummary
              scan={scan}
              loaded={pairs.length}
              visible={visiblePairs.length}
              merged={mergedCount}
            />
            <ThresholdControl
              value={threshold}
              saved={savedThreshold}
              saving={savingThreshold}
              unavailable={thresholdUnavailable}
              error={thresholdError}
              canAdmin={canAdmin}
              helpId={thresholdHelpId}
              onChange={(value) => {
                const next = clampThreshold(value);
                setThreshold(next);
                writeThreshold(next);
              }}
              onSave={() => void saveThreshold()}
            />

            {scan.candidate_count === 0 ? (
              <div className="dedupe-empty" role="status">
                <span aria-hidden="true">✓</span>
                <div>
                  <strong>No deterministic duplicate candidates</strong>
                  <p>
                    All {scan.subscriber_count.toLocaleString()} active profiles
                    were checked. This scan is complete, not sampled.
                  </p>
                </div>
              </div>
            ) : visiblePairs.length === 0 && !loadingPage ? (
              <div className="dedupe-empty" role="status">
                <span aria-hidden="true">↕</span>
                <div>
                  <strong>No loaded pairs meet this confidence filter</strong>
                  <p>
                    Lower the review threshold or load more of the verified
                    manifest.
                  </p>
                </div>
              </div>
            ) : (
              <CandidateTable
                pairs={visiblePairs}
                states={pairStates}
                activeKey={scanError ? "scan-unavailable" : activeKey}
                onReview={(pair) => {
                  setSwapped(false);
                  setPending(pair);
                  setPlanError(null);
                }}
              />
            )}

            {nextCursor ? (
              <div className="dedupe-load-more">
                <span>
                  {pairs.length.toLocaleString()} of{" "}
                  {scan.candidate_count.toLocaleString()} pairs loaded
                </span>
                <button
                  type="button"
                  className="btn"
                  onClick={() => void loadPage(scan.scan_id, nextCursor)}
                  disabled={loadingPage || Boolean(scanError)}
                >
                  {loadingPage ? "Loading next pairs…" : "Load next 50 pairs"}
                </button>
              </div>
            ) : scan.candidate_count > 0 ? (
              <p className="dedupe-manifest-end" role="status">
                Entire verified manifest loaded.
              </p>
            ) : null}
          </>
        ) : null}
      </div>

      <ModalFooter>
        <p className="dedupe-footer-note">
          Scans expire after 24 hours. A changed row is marked stale and can
          never reuse its old review.
        </p>
        <button
          type="button"
          className="btn"
          onClick={onClose}
          disabled={applying}
        >
          Close workspace
        </button>
      </ModalFooter>

      <MergeReview
        pair={pending}
        scanID={scan?.scan_id ?? null}
        swapped={swapped}
        plan={plan}
        loading={planLoading}
        applying={applying}
        error={planError}
        onSwap={setSwapped}
        onRetryPlan={() => {
          if (pending) void requestPlan(pending, swapped);
        }}
        onClose={() => {
          if (!applying) resetReview();
        }}
        onConfirm={() => void applyMerge()}
      />
    </Modal>
  );
}
