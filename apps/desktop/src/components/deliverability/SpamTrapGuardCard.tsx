import {
  type ReactElement,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";

import { spamTrapGuardApi } from "../../lib/api-client";
import { useCanAdmin } from "../../lib/store";
import { ConfirmModal } from "../ConfirmModal";
import { Icon } from "../Icon";
import { DataTable, type DataTableColumn } from "../table/DataTable";
import { toast } from "../Toast";
import { formatWhen } from "./remediation-helpers";
import {
  parseSpamTrapHits,
  parseSpamTrapRunReceipt,
  parseSpamTrapStats,
  type SpamTrapHitEvidence,
  type SpamTrapRunReceipt,
  type SpamTrapStats,
} from "./remediation-response-contract";

export function SpamTrapGuardCard(): ReactElement {
  const canAdmin = useCanAdmin();
  const [stats, setStats] = useState<SpamTrapStats | null>(null);
  const [hits, setHits] = useState<SpamTrapHitEvidence[] | null>(null);
  const [statsFailed, setStatsFailed] = useState(false);
  const [hitsFailed, setHitsFailed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [running, setRunning] = useState(false);
  const [receipt, setReceipt] = useState<SpamTrapRunReceipt | null>(null);
  const requestIdRef = useRef(0);
  const mountedRef = useRef(true);
  const runInFlightRef = useRef(false);
  const reviewButtonRef = useRef<HTMLButtonElement | null>(null);
  const reviewDescriptionId = useId();
  const retryDescriptionId = useId();

  const load = useCallback(async (): Promise<void> => {
    if (!mountedRef.current) return;
    const requestId = ++requestIdRef.current;
    setLoading(true);
    setStatsFailed(false);
    setHitsFailed(false);
    const [statsResult, hitsResult] = await Promise.allSettled([
      spamTrapGuardApi.stats(),
      spamTrapGuardApi.hits(),
    ]);
    if (!mountedRef.current || requestId !== requestIdRef.current) return;

    const parsedStats =
      statsResult.status === "fulfilled" && !statsResult.value.error
        ? parseSpamTrapStats(statsResult.value.data)
        : null;
    const parsedHits =
      hitsResult.status === "fulfilled" && !hitsResult.value.error
        ? parseSpamTrapHits(hitsResult.value.data)
        : null;
    if (parsedStats) setStats(parsedStats);
    else setStatsFailed(true);
    if (parsedHits) setHits(parsedHits);
    else setHitsFailed(true);
    setLoading(false);
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void load();
    return () => {
      mountedRef.current = false;
      requestIdRef.current += 1;
    };
  }, [load]);

  const runSweep = async (): Promise<void> => {
    if (
      !canAdmin ||
      loading ||
      !stats ||
      stats.eligible_now === 0 ||
      runInFlightRef.current
    ) {
      return;
    }
    runInFlightRef.current = true;
    setRunning(true);
    try {
      const result = await spamTrapGuardApi.runNow();
      if (!mountedRef.current) return;
      const nextReceipt = result.error
        ? null
        : parseSpamTrapRunReceipt(result.data);
      if (!nextReceipt) {
        toast.error("The spam-trap sweep was not confirmed by the server.");
        return;
      }
      setConfirmOpen(false);
      setReceipt(nextReceipt);
      toast.success(
        `${nextReceipt.blocklisted.toLocaleString()} eligible recipient${nextReceipt.blocklisted === 1 ? "" : "s"} blocklisted.`,
      );
      await load();
    } catch {
      if (mountedRef.current) {
        toast.error("The spam-trap sweep could not be confirmed.");
      }
    } finally {
      runInFlightRef.current = false;
      if (mountedRef.current) setRunning(false);
    }
  };

  const reviewUnavailableReason = !canAdmin
    ? "Admin access is required to review and apply manual containment."
    : loading
      ? "Wait for the current containment evidence request to finish."
      : running
        ? "Wait for the current containment operation to finish."
        : !stats
          ? "Containment impact must be verified before manual containment can be reviewed."
          : stats.eligible_now === 0
            ? "No recipients are currently eligible for manual containment."
            : null;

  const columns: readonly DataTableColumn<SpamTrapHitEvidence>[] = [
    {
      id: "address",
      header: "Recipient",
      width: "210px",
      cell: (hit) => (
        <span className="pw-table-truncate">{hit.masked_email}</span>
      ),
    },
    {
      id: "hits",
      header: "Recorded hits",
      width: "120px",
      align: "end",
      className: "tabular",
      cell: (hit) => hit.hit_count.toLocaleString(),
    },
    {
      id: "last-hit",
      header: "Last observed",
      width: "150px",
      cell: (hit) => (
        <span className="muted tabular">{formatWhen(hit.last_hit_at)}</span>
      ),
    },
  ];

  return (
    <section
      className="card dhw-spam-guard"
      aria-labelledby="dhw-spam-guard-title"
    >
      <header>
        <span className="dhw-spam-guard-icon">
          <Icon name="shield-check" size={17} />
        </span>
        <div>
          <small>Post-bounce containment</small>
          <h3 id="dhw-spam-guard-title">Spam-trap guard</h3>
        </div>
        <button
          ref={reviewButtonRef}
          type="button"
          className={`btn btn-sm${reviewUnavailableReason ? " pw-discoverable-unavailable" : ""}`}
          aria-disabled={reviewUnavailableReason ? true : undefined}
          aria-describedby={reviewDescriptionId}
          onClick={() => {
            if (!reviewUnavailableReason) setConfirmOpen(true);
          }}
        >
          {running ? "Applying containment…" : "Review containment"}
        </button>
      </header>

      <p className="dhw-spam-guard-summary">
        Contains recipients after Moosewave records spam-trap bounce evidence. It
        cannot prevent the first trap hit and does not prove inbox placement.
      </p>
      <p id={reviewDescriptionId} className="pw-action-status" role="status">
        {reviewUnavailableReason ??
          "Review the currently eligible recipients before applying containment."}
      </p>

      {statsFailed ? (
        <div className="dhw-spam-guard-error" role="alert">
          <Icon name="alert-triangle" size={16} />
          <span>Containment impact could not be verified.</span>
          <button
            type="button"
            className={`btn btn-sm${loading ? " pw-discoverable-unavailable" : ""}`}
            onClick={() => {
              if (!loading) void load();
            }}
            aria-disabled={loading || undefined}
            aria-describedby={retryDescriptionId}
          >
            Retry
          </button>
          <span id={retryDescriptionId} className="visually-hidden">
            {loading
              ? "Wait for the current containment evidence request to finish."
              : "Retry loading containment impact and recent evidence."}
          </span>
        </div>
      ) : null}

      {loading && !stats ? (
        <div className="dhw-spam-guard-skeleton" aria-busy="true">
          <div className="skel" />
          <div className="skel" />
          <div className="skel" />
          <span className="visually-hidden" role="status">
            Loading spam-trap containment evidence
          </span>
        </div>
      ) : stats ? (
        <>
          <dl>
            <SpamTrapFact
              label="Eligible now"
              value={stats.eligible_now.toLocaleString()}
              detail="Not yet blocklisted"
              tone={stats.eligible_now > 0 ? "danger" : "neutral"}
            />
            <SpamTrapFact
              label="Recorded hits · 30d"
              value={stats.hits_last_30_days.toLocaleString()}
            />
            <SpamTrapFact
              label="All blocklisted recipients"
              value={stats.blocklisted_count.toLocaleString()}
              detail="Includes every blocklist reason"
            />
          </dl>
          <p className="dhw-spam-guard-observed">
            Impact observed {formatWhen(stats.observed_at)}. A background sweep
            may change this count before confirmation.
          </p>
        </>
      ) : null}

      {receipt ? (
        <div className="dhw-spam-guard-receipt" role="status">
          Manual containment completed {formatWhen(receipt.completed_at)} ·{" "}
          {receipt.blocklisted.toLocaleString()} recipient
          {receipt.blocklisted === 1 ? "" : "s"} blocklisted.
        </div>
      ) : null}

      {!canAdmin ? (
        <p className="dhw-spam-guard-permission">
          Admin access is required to run manual containment. Read-only evidence
          remains available.
        </p>
      ) : null}

      <div className="dhw-spam-guard-table">
        <DataTable
          caption="Recent spam-trap evidence"
          description={
            loading && hits
              ? "Refreshing · showing the last verified, masked evidence"
              : "Recipient identifiers are masked on this shared operational surface"
          }
          columns={columns}
          rows={hits ?? []}
          getRowKey={(hit) => hit.row_key}
          loading={loading && hits === null}
          loadingLabel="Loading spam-trap evidence…"
          emptyState={
            hitsFailed && hits === null
              ? "Spam-trap evidence is unavailable. Retry before drawing a conclusion."
              : "No recorded spam-trap evidence was returned for this window. This is not proof that every provider feed is complete."
          }
          density="compact"
        />
        {hitsFailed && hits !== null ? (
          <p className="dhw-spam-guard-stale" role="status">
            Refresh failed; the last verified masked evidence remains visible.
          </p>
        ) : null}
      </div>

      <ConfirmModal
        open={confirmOpen}
        title="Blocklist eligible spam-trap recipients?"
        description="This changes subscriber lifecycle status and adds a canonical spam-trap suppression. It does not undo provider reputation damage from the original hit."
        confirmLabel="Apply containment"
        typeToConfirm="BLOCK ELIGIBLE RECIPIENTS"
        danger
        busy={running}
        returnFocusRef={reviewButtonRef}
        onClose={() => setConfirmOpen(false)}
        onConfirm={runSweep}
      >
        <div className="dhw-repair-confirmation">
          <strong>Current server-derived impact</strong>
          <ul>
            <li>
              {stats?.eligible_now.toLocaleString() ?? "Unknown"} recipient
              {stats?.eligible_now === 1 ? "" : "s"} were eligible when last
              observed.
            </li>
            <li>
              Only recipients with recorded spam-trap bounce evidence and a
              non-blocklisted status are selected.
            </li>
            <li>
              The background worker can race this review, so the final receipt
              may be lower than the preview.
            </li>
          </ul>
        </div>
      </ConfirmModal>
    </section>
  );
}

function SpamTrapFact({
  label,
  value,
  detail,
  tone = "neutral",
}: {
  label: string;
  value: string;
  detail?: string;
  tone?: "danger" | "neutral";
}): ReactElement {
  return (
    <div data-tone={tone}>
      <dt>{label}</dt>
      <dd>
        <span>{value}</span>
        {detail ? <small>{detail}</small> : null}
      </dd>
    </div>
  );
}
