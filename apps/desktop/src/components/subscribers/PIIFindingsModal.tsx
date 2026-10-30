import {
  type FormEvent,
  type ReactElement,
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  type PIIDetectionType,
  type PIIFinding,
  type PIIFindingPage,
  type PIIFindingStatus,
  type PIIReviewInput,
  type PIIReviewReceipt,
  type PIIScanConfig,
  piiFindingsApi,
} from "../../lib/api/pii-findings";
import { Modal } from "../Modal";
import { toast } from "../Toast";
import { PIIFindingRecord } from "./PIIFindingRecord";
import {
  describePIIFailure,
  PII_TYPE_OPTIONS,
  type PIISurfaceFailure,
} from "./pii-findings-ui";
import { PIIReviewReceiptView } from "./PIIReviewReceiptView";

const DEFAULT_PAGE_SIZE = 20;

interface CachedPage {
  key: string;
  data: PIIFindingPage;
  verifiedAt: string;
}

interface ActiveDecision {
  findingId: string;
  outcome: Exclude<PIIFindingStatus, "pending">;
}

interface Props {
  open: boolean;
  config: PIIScanConfig | null;
  onClose: () => void;
}

function thrownFailure(error: unknown): PIISurfaceFailure {
  void error;
  return {
    kind: "service_unavailable",
    title: "Review queue unavailable",
    message: "The review queue could not be loaded. Retry the request.",
  };
}

function mutationMessage(status: number | undefined, message: string): string {
  if (status === 409 || status === 412) {
    return "This finding changed or was already decided in another session. Refresh the queue before deciding again.";
  }
  if (status === 401 || status === 403) {
    return "Your session no longer has administrator access. Re-authenticate or ask a workspace owner.";
  }
  if (status !== undefined && status >= 500) {
    return "The review service could not commit the receipt. No decision was assumed.";
  }
  return message || "The review service did not accept this decision.";
}

export function PIIFindingsModal({ open, config, onClose }: Props): ReactElement | null {
  const [status, setStatus] = useState<PIIFindingStatus | "">("pending");
  const [detectedType, setDetectedType] = useState<PIIDetectionType | "">("");
  const [queryDraft, setQueryDraft] = useState("");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [perPage, setPerPage] = useState(DEFAULT_PAGE_SIZE);
  const [result, setResult] = useState<CachedPage | null>(null);
  const [failure, setFailure] = useState<PIISurfaceFailure | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [activeDecision, setActiveDecision] = useState<ActiveDecision | null>(null);
  const [decisionError, setDecisionError] = useState<string | null>(null);
  const [lastReceipt, setLastReceipt] = useState<PIIReviewReceipt | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const resultRef = useRef<CachedPage | null>(result);
  resultRef.current = result;
  const pageCacheRef = useRef(new Map<string, CachedPage>());
  const requestRef = useRef<AbortController | null>(null);
  const requestSequenceRef = useRef(0);
  const mutationRef = useRef<AbortController | null>(null);
  const returnFocusRef = useRef<HTMLButtonElement | null>(null);
  const receiptFocusRef = useRef<HTMLDivElement | null>(null);
  const resultsHeadingRef = useRef<HTMLDivElement | null>(null);

  const queryKey = useMemo(
    () => [status || "all", detectedType || "all", query, page, perPage].join("|"),
    [detectedType, page, perPage, query, status],
  );

  const load = useCallback(async (
    { retainCurrent = false }: { retainCurrent?: boolean } = {},
  ): Promise<void> => {
    if (!open) return;
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    const sequence = ++requestSequenceRef.current;
    const cached = pageCacheRef.current.get(queryKey) ?? null;
    const retained = retainCurrent ? resultRef.current : cached;
    if (!retainCurrent) {
      resultRef.current = cached;
      setResult(cached);
    }
    setFailure(null);
    setLoading(!retained);
    setRefreshing(Boolean(retained));
    try {
      const response = await piiFindingsApi.list({
        ...(status ? { status } : {}),
        ...(detectedType ? { detectedType } : {}),
        ...(query ? { query } : {}),
        page,
        perPage,
        signal: controller.signal,
      });
      if (controller.signal.aborted || sequence !== requestSequenceRef.current) return;
      if (response.error) {
        setFailure(describePIIFailure(response.error));
        return;
      }
      const verified: CachedPage = {
        key: queryKey,
        data: response.data,
        verifiedAt: new Date().toISOString(),
      };
      pageCacheRef.current.set(queryKey, verified);
      resultRef.current = verified;
      setResult(verified);
    } catch (error) {
      if (!controller.signal.aborted && sequence === requestSequenceRef.current) {
        setFailure(thrownFailure(error));
      }
    } finally {
      if (!controller.signal.aborted && sequence === requestSequenceRef.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [detectedType, open, page, perPage, query, queryKey, status]);

  useEffect(() => {
    if (open) void load();
    return () => requestRef.current?.abort();
  }, [load, open]);

  useEffect(
    () => () => {
      requestRef.current?.abort();
      mutationRef.current?.abort();
    },
    [],
  );

  function restoreDecisionFocus(preferReceipt = false): void {
    const target = returnFocusRef.current;
    returnFocusRef.current = null;
    window.setTimeout(() => {
      const destination = preferReceipt
        ? receiptFocusRef.current ?? resultsHeadingRef.current
        : target?.isConnected
          ? target
          : resultsHeadingRef.current;
      destination?.focus();
    }, 0);
  }

  function cancelDecision(): void {
    if (busyId) return;
    setActiveDecision(null);
    setDecisionError(null);
    restoreDecisionFocus();
  }

  function beginDecision(
    findingId: string,
    outcome: Exclude<PIIFindingStatus, "pending">,
    trigger: HTMLButtonElement,
  ): void {
    if (busyId) return;
    returnFocusRef.current = trigger;
    setDecisionError(null);
    setActiveDecision({ findingId, outcome });
  }

  async function submitDecision(
    finding: PIIFinding,
    input: PIIReviewInput,
  ): Promise<boolean> {
    if (busyId || mutationRef.current) return false;
    const controller = new AbortController();
    mutationRef.current = controller;
    setBusyId(finding.id);
    setDecisionError(null);
    try {
      const response = await piiFindingsApi.review(finding.id, input, {
        signal: controller.signal,
      });
      if (controller.signal.aborted) return false;
      if (response.error) {
        setDecisionError(mutationMessage(response.error.status, response.error.message));
        return false;
      }
      const receipt = response.data.review_receipt;
      if (!receipt) {
        setDecisionError("The service omitted the immutable receipt. No local state was changed.");
        return false;
      }
      const updated = response.data;
      const leavesCurrentFilter = Boolean(status && status !== updated.status);
      const current = resultRef.current;
      const mustClampPage =
        leavesCurrentFilter &&
        current !== null &&
        current.data.items.length === 1 &&
        page > 1;
      // A terminal decision can change both membership and page fill. Never
      // manufacture a locally "verified" sparse page; clear every affected
      // cache and ask the server for the authoritative replacement row/count.
      pageCacheRef.current.clear();
      setLastReceipt(receipt);
      setActiveDecision(null);
      setDecisionError(null);
      if (mustClampPage) {
        resultRef.current = null;
        setResult(null);
        setPage((value) => Math.max(1, value - 1));
      } else {
        void load({ retainCurrent: true });
      }
      restoreDecisionFocus(true);
      toast.success(
        updated.status === "reviewed"
          ? "Reviewed decision recorded with an immutable receipt."
          : "Dismissal recorded with an immutable receipt.",
      );
      return true;
    } catch {
      if (!controller.signal.aborted) {
        setDecisionError(mutationMessage(undefined, ""));
      }
      return false;
    } finally {
      if (mutationRef.current === controller) mutationRef.current = null;
      if (!controller.signal.aborted) setBusyId(null);
    }
  }

  if (!open) return null;

  const rows = result?.data.items ?? [];
  const total = result?.data.total ?? 0;
  const rangeStart = total === 0 || rows.length === 0 ? 0 : (page - 1) * perPage + 1;
  const rangeEnd = rangeStart === 0 ? 0 : Math.min(total, rangeStart + rows.length - 1);
  const hasFilters = Boolean(status || detectedType || query);
  const queueBusy = Boolean(busyId) || refreshing;

  function applySearch(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const next = queryDraft.trim();
    setActiveDecision(null);
    setDecisionError(null);
    setPage(1);
    if (next === query) void load();
    else setQuery(next);
  }

  function clearFilters(): void {
    setStatus("");
    setDetectedType("");
    setQueryDraft("");
    setQuery("");
    setPage(1);
    setActiveDecision(null);
    setDecisionError(null);
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Shadow-PII review queue"
      description="Inspect privacy-safe evidence, document every terminal decision, and retain an immutable receipt. Matched values are never shown."
      size="xl"
      closeDisabled={Boolean(busyId)}
      closeOnBackdrop={!busyId}
      closeOnEscape={!busyId}
    >
      <div className="pii-review-modal">
        <PIIReviewSafetyStrip config={config} />

        {lastReceipt ? (
          <div
            ref={receiptFocusRef}
            className="pii-review-receipt-confirmation"
            role="status"
            tabIndex={-1}
            aria-label="Decision recorded"
          >
            <PIIReviewReceiptView receipt={lastReceipt} compact />
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => setLastReceipt(null)}>
              Dismiss receipt summary
            </button>
          </div>
        ) : null}

        <PIIReviewToolbar
          status={status}
          detectedType={detectedType}
          queryDraft={queryDraft}
          hasFilters={hasFilters}
          disabled={queueBusy}
          onSubmit={applySearch}
          onClear={clearFilters}
          onQueryDraftChange={setQueryDraft}
          onStatusChange={(nextStatus) => {
            setStatus(nextStatus);
            setPage(1);
            setActiveDecision(null);
          }}
          onDetectedTypeChange={(nextType) => {
            setDetectedType(nextType);
            setPage(1);
            setActiveDecision(null);
          }}
        />

        <PIIReviewResults
          headingRef={resultsHeadingRef}
          result={result}
          failure={failure}
          loading={loading}
          refreshing={refreshing}
          busy={queueBusy}
          status={status}
          detectedType={detectedType}
          query={query}
          hasFilters={hasFilters}
          rows={rows}
          total={total}
          activeDecision={activeDecision}
          decisionError={decisionError}
          rangeStart={rangeStart}
          rangeEnd={rangeEnd}
          perPage={perPage}
          page={page}
          onRefresh={() => void load()}
          onClearFilters={clearFilters}
          onBeginDecision={beginDecision}
          onCancelDecision={cancelDecision}
          onSubmitDecision={submitDecision}
          onPerPageChange={(nextPerPage) => {
            setPerPage(nextPerPage);
            setPage(1);
            setActiveDecision(null);
          }}
          onPreviousPage={() => setPage((value) => Math.max(1, value - 1))}
          onNextPage={() => setPage((value) => value + 1)}
        />
      </div>
    </Modal>
  );
}

function PIIReviewSafetyStrip({
  config,
}: {
  config: PIIScanConfig | null;
}): ReactElement {
  return (
    <div className="pii-review-safety-strip" role="note">
      <span className="pii-review-card-mark" aria-hidden="true">
        <span />
      </span>
      <div>
        <strong>Privacy-safe review boundary</strong>
        <p>
          Search covers field names, exact finding/subscriber IDs, or protected
          HMAC fingerprint prefixes—not subscriber content. Legacy redacted tokens
          are intentionally not searchable.
        </p>
      </div>
      {config ? (
        <dl>
          <div>
            <dt>Detector</dt>
            <dd>{config.detector_name} {config.detector_version}</dd>
          </div>
          <div>
            <dt>Policy</dt>
            <dd>{config.policy_name} {config.policy_version}</dd>
          </div>
          <div>
            <dt>Execution</dt>
            <dd>Partial write hooks · best effort</dd>
          </div>
          <div>
            <dt>Coverage</dt>
            <dd>Unverified</dd>
          </div>
        </dl>
      ) : null}
    </div>
  );
}

interface PIIReviewToolbarProps {
  status: PIIFindingStatus | "";
  detectedType: PIIDetectionType | "";
  queryDraft: string;
  hasFilters: boolean;
  disabled: boolean;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onClear: () => void;
  onQueryDraftChange: (query: string) => void;
  onStatusChange: (status: PIIFindingStatus | "") => void;
  onDetectedTypeChange: (detectedType: PIIDetectionType | "") => void;
}

function PIIReviewToolbar({
  status,
  detectedType,
  queryDraft,
  hasFilters,
  disabled,
  onSubmit,
  onClear,
  onQueryDraftChange,
  onStatusChange,
  onDetectedTypeChange,
}: PIIReviewToolbarProps): ReactElement {
  return (
    <form className="pii-review-toolbar" role="search" onSubmit={onSubmit}>
      <label>
        <span>Status</span>
        <select
          value={status}
          onChange={(event) =>
            onStatusChange(event.currentTarget.value as PIIFindingStatus | "")
          }
          disabled={disabled}
        >
          <option value="">All statuses</option>
          <option value="pending">Needs review</option>
          <option value="reviewed">Reviewed</option>
          <option value="dismissed">Dismissed</option>
        </select>
      </label>
      <label>
        <span>Detected type</span>
        <select
          value={detectedType}
          onChange={(event) =>
            onDetectedTypeChange(
              event.currentTarget.value as PIIDetectionType | "",
            )
          }
          disabled={disabled}
        >
          <option value="">All types</option>
          {PII_TYPE_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
      <label className="pii-review-search-field">
        <span>Safe metadata search</span>
        <span className="pii-review-search-control">
          <input
            type="search"
            value={queryDraft}
            onChange={(event) => onQueryDraftChange(event.currentTarget.value)}
            placeholder="Field, exact UUID, or protected fingerprint"
            maxLength={128}
            autoComplete="off"
            spellCheck={false}
            disabled={disabled}
          />
          <button type="submit" className="btn btn-sm" disabled={disabled}>
            Search
          </button>
        </span>
      </label>
      {hasFilters ? (
        <button
          type="button"
          className="btn btn-sm btn-ghost pii-review-clear"
          onClick={onClear}
          disabled={disabled}
        >
          Clear filters
        </button>
      ) : null}
    </form>
  );
}

interface PIIReviewResultsProps {
  headingRef: RefObject<HTMLDivElement | null>;
  result: CachedPage | null;
  failure: PIISurfaceFailure | null;
  loading: boolean;
  refreshing: boolean;
  busy: boolean;
  status: PIIFindingStatus | "";
  detectedType: PIIDetectionType | "";
  query: string;
  hasFilters: boolean;
  rows: PIIFinding[];
  total: number;
  activeDecision: ActiveDecision | null;
  decisionError: string | null;
  rangeStart: number;
  rangeEnd: number;
  perPage: number;
  page: number;
  onRefresh: () => void;
  onClearFilters: () => void;
  onBeginDecision: (
    findingId: string,
    outcome: Exclude<PIIFindingStatus, "pending">,
    trigger: HTMLButtonElement,
  ) => void;
  onCancelDecision: () => void;
  onSubmitDecision: (
    finding: PIIFinding,
    input: PIIReviewInput,
  ) => Promise<boolean>;
  onPerPageChange: (perPage: number) => void;
  onPreviousPage: () => void;
  onNextPage: () => void;
}

function PIIReviewResults(props: PIIReviewResultsProps): ReactElement {
  const {
    headingRef,
    result,
    failure,
    loading,
    refreshing,
    busy,
    status,
    detectedType,
    query,
    hasFilters,
    rows,
    total,
    activeDecision,
    decisionError,
    rangeStart,
    rangeEnd,
    perPage,
    page,
    onRefresh,
    onClearFilters,
    onBeginDecision,
    onCancelDecision,
    onSubmitDecision,
    onPerPageChange,
    onPreviousPage,
    onNextPage,
  } = props;
  const defaultEmpty = status === "pending" && !detectedType && !query;
  return (
    <>
      <div
        ref={headingRef}
        className="pii-review-results-heading"
        tabIndex={-1}
      >
        <div>
          <span className="pii-review-eyebrow">Verified server results</span>
          <h3>
            {loading
              ? "Loading findings…"
              : `${total.toLocaleString()} ${total === 1 ? "finding" : "findings"}`}
          </h3>
        </div>
        <div className="pii-review-results-actions">
          {refreshing ? (
            <span className="pii-review-refreshing" role="status">
              Refreshing…
            </span>
          ) : null}
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            onClick={onRefresh}
            disabled={loading || refreshing || busy}
          >
            Refresh
          </button>
        </div>
      </div>

      {failure ? (
        <div
          className={`pii-review-load-error is-${failure.kind}`}
          role={result ? "status" : "alert"}
        >
          <div>
            <strong>{failure.title}</strong>
            <p>{failure.message}</p>
            {result ? (
              <small>Showing the last verified result for these exact filters.</small>
            ) : null}
          </div>
          <button
            type="button"
            className="btn btn-sm"
            onClick={onRefresh}
            disabled={loading || refreshing}
          >
            Retry
          </button>
        </div>
      ) : null}

      {loading && !result ? (
        <div className="pii-review-list is-loading" aria-label="Loading PII findings">
          <span className="skel" />
          <span className="skel" />
          <span className="skel" />
        </div>
      ) : !result && failure ? null : rows.length === 0 ? (
        <div className="pii-review-empty">
          <span className="pii-review-card-mark" aria-hidden="true">
            <span />
          </span>
          <strong>
            {defaultEmpty
              ? "No findings need review"
              : "No findings match these filters"}
          </strong>
          <p>
            {defaultEmpty
              ? "The verified pending queue is clear. This is not a guarantee that no PII exists."
              : "Broaden or clear the server filters; no local-only filtering has been applied."}
          </p>
          {hasFilters ? (
            <button type="button" className="btn btn-sm" onClick={onClearFilters}>
              Clear filters
            </button>
          ) : null}
        </div>
      ) : (
        <div className="pii-review-list" aria-live="polite">
          {rows.map((finding) => (
            <PIIFindingRecord
              key={finding.id}
              finding={finding}
              activeOutcome={
                activeDecision?.findingId === finding.id
                  ? activeDecision.outcome
                  : null
              }
              decisionError={
                activeDecision?.findingId === finding.id ? decisionError : null
              }
              decisionsDisabled={busy}
              onBeginDecision={(outcome, trigger) =>
                onBeginDecision(finding.id, outcome, trigger)
              }
              onCancelDecision={onCancelDecision}
              onSubmitDecision={(input) => onSubmitDecision(finding, input)}
            />
          ))}
        </div>
      )}

      {result ? (
        <nav className="pii-review-pagination" aria-label="PII findings pages">
          <span className="tabular">
            {rangeStart.toLocaleString()}–{rangeEnd.toLocaleString()} of{" "}
            {total.toLocaleString()}
          </span>
          <label>
            <span>Rows</span>
            <select
              value={perPage}
              onChange={(event) =>
                onPerPageChange(Number(event.currentTarget.value))
              }
              disabled={busy}
            >
              <option value={10}>10</option>
              <option value={20}>20</option>
              <option value={50}>50</option>
            </select>
          </label>
          <div>
            <button
              type="button"
              className="btn btn-sm"
              onClick={onPreviousPage}
              disabled={page <= 1 || busy}
            >
              Previous
            </button>
            <span className="tabular">Page {page.toLocaleString()}</span>
            <button
              type="button"
              className="btn btn-sm"
              onClick={onNextPage}
              disabled={rangeEnd >= total || busy}
            >
              Next
            </button>
          </div>
        </nav>
      ) : null}
    </>
  );
}
