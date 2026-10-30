import {
  type ReactElement,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import {
  type PIIFinding,
  type PIIFindingPage,
  type PIIFindingStatus,
  type PIIReviewInput,
  piiFindingsApi,
} from "../../lib/api/pii-findings";
import { responseIdentityMatches } from "../../lib/api/subscriber-response-integrity";
import { PIIFindingRecord } from "../subscribers/PIIFindingRecord";
import { describePIIFailure } from "../subscribers/pii-findings-ui";
import { toast } from "../Toast";

interface Props {
  subscriberId: string;
  canAdmin: boolean;
  /** Retained for caller compatibility. The tab now explains 404s explicitly. */
  onUnavailable?: () => void;
}

interface ActiveDecision {
  findingId: string;
  outcome: Exclude<PIIFindingStatus, "pending">;
}

const PAGE_SIZE = 20;

function controlledDecisionError(status?: number): string {
  if (status === 409 || status === 412) {
    return "This finding was changed or decided in another session. Refresh before deciding again.";
  }
  if (status === 401 || status === 403) {
    return "Your session no longer has administrator access. Re-authenticate or ask a workspace owner.";
  }
  if (status !== undefined && status >= 500) {
    return "The review service could not commit the receipt. No decision was assumed.";
  }
  return "The review service rejected this decision. Verify the form and refresh the finding before retrying.";
}

export function PIIFindingsPanel(props: Props): ReactElement {
  return <PIIFindingsPanelState key={props.subscriberId} {...props} />;
}

function PIIFindingsPanelState({ subscriberId, canAdmin }: Props): ReactElement {
  const [result, setResult] = useState<PIIFindingPage | null>(null);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(canAdmin);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeDecision, setActiveDecision] = useState<ActiveDecision | null>(null);
  const [decisionError, setDecisionError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const requestRef = useRef<AbortController | null>(null);
  const requestSequenceRef = useRef(0);
  const mutationRef = useRef<AbortController | null>(null);
  const returnFocusRef = useRef<HTMLButtonElement | null>(null);
  const headingRef = useRef<HTMLElement | null>(null);

  // `result` is deliberately not a dependency trigger: verified rows should
  // not cause a self-refresh loop. Page/subscriber changes still re-run.
  const resultRef = useRef(result);
  resultRef.current = result;
  const stableLoad = useCallback(async (): Promise<void> => {
    if (!canAdmin) return;
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    const sequence = ++requestSequenceRef.current;
    setError(null);
    setLoading(resultRef.current === null);
    setRefreshing(resultRef.current !== null);
    try {
      const response = await piiFindingsApi.listForSubscriber(subscriberId, {
        page,
        perPage: PAGE_SIZE,
        signal: controller.signal,
      });
      if (controller.signal.aborted || sequence !== requestSequenceRef.current) return;
      if (response.error) {
        if (
          page > 1 &&
          response.error.code === "invalid_subscriber_response_contract"
        ) {
          setResult(null);
          setPage((value) => Math.max(1, value - 1));
          return;
        }
        const failure = describePIIFailure(response.error);
        setError(`${failure.title}: ${failure.message}`);
      } else {
        setResult(response.data);
      }
    } catch {
      if (!controller.signal.aborted && sequence === requestSequenceRef.current) {
        setError("The PII review service is unavailable. Retry the request.");
      }
    } finally {
      if (!controller.signal.aborted && sequence === requestSequenceRef.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [canAdmin, page, subscriberId]);

  useEffect(() => {
    void stableLoad();
    return () => requestRef.current?.abort();
  }, [stableLoad]);

  useEffect(() => {
    if (canAdmin) return;
    requestRef.current?.abort();
    mutationRef.current?.abort();
    mutationRef.current = null;
    requestSequenceRef.current += 1;
    setResult(null);
    setPage(1);
    setLoading(false);
    setRefreshing(false);
    setError(null);
    setActiveDecision(null);
    setDecisionError(null);
    setBusyId(null);
    returnFocusRef.current = null;
  }, [canAdmin]);

  function restoreFocus(updatedFindingId?: string): void {
    const target = returnFocusRef.current;
    returnFocusRef.current = null;
    window.setTimeout(() => {
      const updated = updatedFindingId
        ? document.getElementById(`pii-finding-record-${updatedFindingId}`)
        : null;
      const destination = updated ?? (target?.isConnected ? target : headingRef.current);
      destination?.focus();
    }, 0);
  }

  function cancelDecision(): void {
    if (busyId) return;
    setActiveDecision(null);
    setDecisionError(null);
    restoreFocus();
  }

  async function submitDecision(
    finding: PIIFinding,
    input: PIIReviewInput,
  ): Promise<boolean> {
    if (!canAdmin || mutationRef.current) return false;
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
        setDecisionError(controlledDecisionError(response.error.status));
        return false;
      }
      if (!responseIdentityMatches(subscriberId, response.data.subscriber_id)) {
        setDecisionError(
          "The server returned a finding for a different subscriber. No local state was changed.",
        );
        return false;
      }
      const updated = response.data;
      setResult((current) =>
        current
          ? {
              ...current,
              items: current.items.map((item) =>
                item.id === updated.id ? updated : item,
              ),
            }
          : current,
      );
      setActiveDecision(null);
      restoreFocus(updated.id);
      toast.success("Decision recorded with an immutable PII review receipt.");
      return true;
    } catch {
      if (!controller.signal.aborted) {
        setDecisionError("The review service is unavailable. No decision was assumed.");
      }
      return false;
    } finally {
      if (mutationRef.current === controller) mutationRef.current = null;
      if (!controller.signal.aborted) setBusyId(null);
    }
  }

  if (!canAdmin) {
    return (
      <div className="pii-subscriber-panel-state" role="status">
        <strong>Admin access required</strong>
        <p>
          Shadow-PII evidence is restricted to workspace administrators. This tab remains visible so the restriction is explicit.
        </p>
      </div>
    );
  }

  const rows = result?.items ?? [];
  const total = result?.total ?? 0;
  const start = total === 0 || rows.length === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const end = start === 0 ? 0 : Math.min(total, start + rows.length - 1);

  function navigate(nextPage: number): void {
    setResult(null);
    setActiveDecision(null);
    setDecisionError(null);
    returnFocusRef.current = null;
    setPage(Math.max(1, nextPage));
  }

  return (
    <div className="pii-subscriber-panel">
      <header ref={headingRef} tabIndex={-1}>
        <div>
          <span className="pii-review-eyebrow">Privacy intelligence</span>
          <h3>Shadow-PII findings</h3>
          <p>
            The scanner exposes field metadata and protected fingerprints only.
            Every terminal decision requires evidence and produces a locked receipt;
            scanner coverage remains unverified.
          </p>
        </div>
        <button type="button" className="btn btn-sm btn-ghost" onClick={() => void stableLoad()} disabled={loading || refreshing || Boolean(busyId)}>
          {refreshing ? "Refreshing…" : "Refresh"}
        </button>
      </header>

      {error ? (
        <div className="pii-review-load-error" role={result ? "status" : "alert"}>
          <div><strong>Couldn’t verify findings</strong><p>{error}</p>{result ? <small>Showing the last verified page.</small> : null}</div>
          <button type="button" className="btn btn-sm" onClick={() => void stableLoad()}>Retry</button>
        </div>
      ) : null}

      {loading && !result ? (
        <div className="pii-review-list is-loading" aria-label="Loading PII findings">
          <span className="skel" /><span className="skel" />
        </div>
      ) : !result && error ? null : rows.length === 0 ? (
        <div className="pii-review-empty">
          <strong>No PII findings recorded</strong>
          <p>This verified subscriber queue is empty; that is not a guarantee that no PII exists.</p>
        </div>
      ) : (
        <div className="pii-review-list">
          {rows.map((finding) => (
            <PIIFindingRecord
              key={finding.id}
              finding={finding}
              activeOutcome={activeDecision?.findingId === finding.id ? activeDecision.outcome : null}
              decisionError={activeDecision?.findingId === finding.id ? decisionError : null}
              decisionsDisabled={Boolean(busyId)}
              onBeginDecision={(outcome, trigger) => {
                returnFocusRef.current = trigger;
                setDecisionError(null);
                setActiveDecision({ findingId: finding.id, outcome });
              }}
              onCancelDecision={cancelDecision}
              onSubmitDecision={(input) => submitDecision(finding, input)}
            />
          ))}
        </div>
      )}

      {result ? (
        <nav className="pii-review-pagination is-inline" aria-label="Subscriber PII finding pages">
          <span className="tabular">{start.toLocaleString()}–{end.toLocaleString()} of {total.toLocaleString()}</span>
          <div>
            <button type="button" className="btn btn-sm" onClick={() => navigate(page - 1)} disabled={page <= 1 || Boolean(busyId)}>Previous</button>
            <span className="tabular">Page {page.toLocaleString()}</span>
            <button type="button" className="btn btn-sm" onClick={() => navigate(page + 1)} disabled={rows.length === 0 || end >= total || Boolean(busyId)}>Next</button>
          </div>
        </nav>
      ) : null}
    </div>
  );
}
