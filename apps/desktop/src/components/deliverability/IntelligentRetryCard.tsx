import {
  type ReactElement,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";

import {
  type IntelligentRetryEvent,
  intelligentRetryApi,
} from "../../lib/api-client";
import { useCanAdmin, useMe, useRoleStatus } from "../../lib/store";
import { DataTable, type DataTableColumn } from "../table/DataTable";
import { Icon } from "../Icon";
import { Notice } from "../Notice";
import { formatWhen, retryStatusBadgeClass } from "./remediation-helpers";
import { parseIntelligentRetryEvents } from "./remediation-response-contract";

const EVENT_LIMIT = 50;

export function IntelligentRetryCard(): ReactElement {
  const canAdmin = useCanAdmin();
  const me = useMe();
  const roleStatus = useRoleStatus();
  const tenantID = me?.tenant.trim() ?? "";
  const identity =
    roleStatus === "resolved" && canAdmin && tenantID ? tenantID : null;
  const [rows, setRows] = useState<IntelligentRetryEvent[] | null>(null);
  const [rowsOwner, setRowsOwner] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [failureOwner, setFailureOwner] = useState<string | null>(null);
  const requestIdRef = useRef(0);
  const mountedRef = useRef(true);
  const actionInFlightRef = useRef<Promise<void> | null>(null);
  const refreshDescriptionId = useId();

  const load = useCallback((): Promise<void> => {
    if (!mountedRef.current || identity === null) return Promise.resolve();
    if (actionInFlightRef.current) return actionInFlightRef.current;
    const request = ++requestIdRef.current;
    const operation = (async (): Promise<void> => {
      setLoading(true);
      setFailed(false);
      setFailureOwner(null);
      try {
        const result = await intelligentRetryApi.events({
          limit: EVENT_LIMIT,
        });
        if (!mountedRef.current || request !== requestIdRef.current) return;
        const parsed = result.error
          ? null
          : parseIntelligentRetryEvents(result.data, identity);
        if (parsed) {
          setRows(parsed);
          setRowsOwner(identity);
        } else {
          setFailed(true);
          setFailureOwner(identity);
        }
      } catch {
        if (mountedRef.current && request === requestIdRef.current) {
          setFailed(true);
          setFailureOwner(identity);
        }
      } finally {
        if (mountedRef.current && request === requestIdRef.current) {
          setLoading(false);
        }
      }
    })();
    actionInFlightRef.current = operation;
    void operation.finally(() => {
      if (actionInFlightRef.current === operation) {
        actionInFlightRef.current = null;
      }
    });
    return operation;
  }, [identity]);

  useEffect(() => {
    mountedRef.current = true;
    requestIdRef.current += 1;
    actionInFlightRef.current = null;
    setLoading(identity !== null);
    setFailed(false);
    setFailureOwner(null);
    if (identity !== null) void load();
    return () => {
      mountedRef.current = false;
      requestIdRef.current += 1;
      actionInFlightRef.current = null;
    };
  }, [identity, load]);

  const verifiedRows = rowsOwner === identity ? rows : null;
  const currentFailed = failureOwner === identity && failed;
  const statusCounts = countStatuses(verifiedRows ?? []);
  return (
    <section
      className="card dhw-retry-evidence"
      aria-labelledby="dhw-retry-title"
    >
      <header>
        <span>
          <Icon name="clock" size={17} />
        </span>
        <div>
          <small>Queue evidence</small>
          <h3 id="dhw-retry-title">Deferred email recipients</h3>
        </div>
        {identity !== null ? (
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => {
              if (!loading) void load();
            }}
            aria-disabled={loading || undefined}
            aria-describedby={loading ? refreshDescriptionId : undefined}
          >
            {loading ? "Refreshing…" : "Refresh queue"}
          </button>
        ) : null}
      </header>

      <p className="dhw-retry-summary">
        Email recipients withheld during queue admission and the worker outcome
        recorded afterward. SMS and push cap skips stay withheld without
        entering this email-only retry queue. A row is operational evidence, not
        a promise that a message was or will be delivered.
      </p>

      {identity === null ? (
        <Notice tone="neutral" announcement="off">
          {roleStatus === "loading"
            ? "Verifying workspace authority before requesting private retry evidence."
            : "Workspace owner or admin access is required to read deferred-recipient evidence."}
        </Notice>
      ) : null}

      {identity !== null ? (
        <div className="dhw-retry-counts" aria-label="Retry status summary">
          <RetryCount label="Waiting" value={statusCounts.pending} />
          <RetryCount label="Processing" value={statusCounts.retrying} />
          <RetryCount label="Retried" value={statusCounts.retried} />
          <RetryCount
            label="Failed"
            value={statusCounts.failed}
            tone="danger"
          />
          <RetryCount label="Dismissed" value={statusCounts.dismissed} />
        </div>
      ) : null}

      {identity !== null ? (
        <Notice tone="warning" announcement="off">
          Manual promotion controls are not exposed in this workspace. A retry
          marked ready still re-evaluates tenant caps and subscriber pause
          authority before queue admission; it cannot force delivery.
        </Notice>
      ) : null}

      {identity !== null && currentFailed ? (
        <div className="dhw-retry-error" role="alert">
          <Icon name="alert-triangle" size={16} />
          <span>
            Retry evidence could not be verified.
            {verifiedRows ? " The last verified queue remains visible." : ""}
          </span>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => {
              if (!loading) void load();
            }}
            aria-disabled={loading || undefined}
            aria-describedby={loading ? refreshDescriptionId : undefined}
          >
            Retry
          </button>
        </div>
      ) : null}

      {identity !== null ? (
        <DataTable
          caption="Deferred recipient evidence"
          description={
            loading && verifiedRows
              ? "Refreshing · showing the last verified queue"
              : `Up to ${EVENT_LIMIT} recent events`
          }
          columns={retryColumns}
          rows={verifiedRows ?? []}
          getRowKey={(row) => row.id}
          loading={loading && verifiedRows === null}
          loadingLabel="Loading deferred recipient evidence…"
          emptyState={
            currentFailed
              ? "Retry evidence is unavailable. Retry the request to verify it."
              : "No deferred recipient event is recorded."
          }
          density="compact"
        />
      ) : null}
      <span id={refreshDescriptionId} className="visually-hidden">
        {loading
          ? "Wait for the current retry-evidence request to finish."
          : "Refresh the deferred-recipient evidence."}
      </span>
    </section>
  );
}

const retryColumns: readonly DataTableColumn<IntelligentRetryEvent>[] = [
  {
    id: "subscriber",
    header: "Recipient",
    width: "190px",
    cell: (row) => (
      <span className="pw-table-truncate">
        {maskEmail(row.subscriber_email)}
      </span>
    ),
  },
  {
    id: "campaign",
    header: "Campaign",
    width: "150px",
    cell: (row) => (
      <span className="muted tabular">{compactReference(row.campaign_id)}</span>
    ),
  },
  {
    id: "reason",
    header: "Held by",
    width: "150px",
    cell: (row) => (
      <span className="muted">{row.reason.replaceAll("_", " ")}</span>
    ),
  },
  {
    id: "status",
    header: "Recorded state",
    width: "120px",
    cell: (row) => (
      <span className={retryStatusBadgeClass(row.status)}>{row.status}</span>
    ),
  },
  {
    id: "retry-after",
    header: "Eligible after",
    width: "170px",
    cell: (row) => (
      <span className="muted tabular">{formatWhen(row.retry_after)}</span>
    ),
  },
  {
    id: "attempts",
    header: "Attempts",
    width: "90px",
    align: "end",
    cell: (row) => (
      <span className="tabular">{row.attempts.toLocaleString()}</span>
    ),
  },
];

function RetryCount({
  label,
  value,
  tone = "neutral",
}: {
  label: string;
  value: number;
  tone?: "neutral" | "danger";
}): ReactElement {
  return (
    <div data-tone={tone}>
      <span>{label}</span>
      <strong>{value.toLocaleString()}</strong>
    </div>
  );
}

function countStatuses(
  rows: IntelligentRetryEvent[],
): Record<"pending" | "retrying" | "retried" | "failed" | "dismissed", number> {
  const counts = {
    pending: 0,
    retrying: 0,
    retried: 0,
    failed: 0,
    dismissed: 0,
  };
  for (const row of rows) {
    if (row.status === "pending" || row.status === "ready") counts.pending += 1;
    else if (row.status === "retrying") counts.retrying += 1;
    else if (row.status === "retried") counts.retried += 1;
    else if (row.status === "failed") counts.failed += 1;
    else if (row.status === "dismissed") counts.dismissed += 1;
  }
  return counts;
}

function maskEmail(value: string): string {
  const at = value.lastIndexOf("@");
  if (at <= 0) return "••••";
  const local = value.slice(0, at);
  return `${local.slice(0, 1)}${"•".repeat(Math.min(5, Math.max(2, local.length - 1)))}@${value.slice(at + 1)}`;
}

function compactReference(value: string): string {
  return value.length <= 16 ? value : `${value.slice(0, 7)}…${value.slice(-5)}`;
}
