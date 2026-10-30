import {
  type ReactElement,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";

import { softBounceRecoveryApi } from "../../lib/api-client";
import { useCanAdmin } from "../../lib/store";
import { ConfirmModal } from "../ConfirmModal";
import { Icon } from "../Icon";
import { toast } from "../Toast";
import {
  parseSoftBounceCleanupCount,
  parseSoftBounceStats,
  type SoftBounceStats,
} from "./remediation-response-contract";

export function SoftBounceRecoveryCard(): ReactElement {
  const canAdmin = useCanAdmin();
  const [stats, setStats] = useState<SoftBounceStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [running, setRunning] = useState(false);
  const [lastExpired, setLastExpired] = useState<number | null>(null);
  const requestIdRef = useRef(0);
  const mountedRef = useRef(true);
  const runInFlightRef = useRef(false);
  const runButtonRef = useRef<HTMLButtonElement | null>(null);
  const runDescriptionId = useId();
  const retryDescriptionId = useId();

  const load = useCallback(async (): Promise<void> => {
    if (!mountedRef.current) return;
    const request = ++requestIdRef.current;
    setLoading(true);
    setFailed(false);
    try {
      const result = await softBounceRecoveryApi.stats();
      if (!mountedRef.current || request !== requestIdRef.current) return;
      const parsed = result.error ? null : parseSoftBounceStats(result.data);
      if (parsed) setStats(parsed);
      else setFailed(true);
    } catch {
      if (mountedRef.current && request === requestIdRef.current)
        setFailed(true);
    } finally {
      if (mountedRef.current && request === requestIdRef.current)
        setLoading(false);
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void load();
    return () => {
      mountedRef.current = false;
      requestIdRef.current += 1;
    };
  }, [load]);

  const runCleanup = async (): Promise<void> => {
    if (!canAdmin || loading || runInFlightRef.current) return;
    runInFlightRef.current = true;
    setRunning(true);
    try {
      const result = await softBounceRecoveryApi.runNow();
      if (!mountedRef.current) return;
      const expired = result.error
        ? null
        : parseSoftBounceCleanupCount(result.data);
      if (expired === null) {
        toast.error("The suppression cleanup was not confirmed.");
        return;
      }
      setConfirmOpen(false);
      setLastExpired(expired);
      toast.success(
        `${expired.toLocaleString()} expired transient suppression${expired === 1 ? "" : "s"} removed. Subscriber status was unchanged.`,
      );
      await load();
    } catch {
      if (mountedRef.current) {
        toast.error(
          "The transient-suppression cleanup could not be confirmed.",
        );
      }
    } finally {
      runInFlightRef.current = false;
      if (mountedRef.current) setRunning(false);
    }
  };

  const runUnavailableReason = !canAdmin
    ? "Admin access is required to run a cleanup."
    : loading
      ? "Wait for cleanup evidence to finish loading."
      : running
        ? "The cleanup request is already in progress."
        : !stats
          ? "Verified cleanup evidence is required before reviewing this action."
          : null;

  return (
    <section
      className="card dhw-soft-recovery"
      aria-labelledby="dhw-soft-recovery-title"
    >
      <header>
        <span>
          <Icon name="clock" size={17} />
        </span>
        <div>
          <small>Transient suppression hygiene</small>
          <h3 id="dhw-soft-recovery-title">Soft-bounce expiry</h3>
        </div>
        <button
          ref={runButtonRef}
          type="button"
          className={`btn btn-sm${runUnavailableReason ? " pw-discoverable-unavailable" : ""}`}
          aria-disabled={runUnavailableReason !== null}
          aria-describedby={runDescriptionId}
          onClick={() => {
            if (!runUnavailableReason) setConfirmOpen(true);
          }}
        >
          {running ? "Cleaning up…" : "Review cleanup"}
        </button>
      </header>

      <p className="dhw-soft-recovery-summary">
        Removes only expired, identity-linked transient suppressions whose
        latest bounce evidence is still old and soft. It never enables a
        subscriber or changes lifecycle status.
      </p>
      <p id={runDescriptionId} className="pw-action-status" role="status">
        {runUnavailableReason ??
          "Opens a typed confirmation before removing eligible expired transient suppressions."}
      </p>

      {failed ? (
        <div className="dhw-soft-recovery-error" role="alert">
          <Icon name="alert-triangle" size={16} />
          <span>Cleanup evidence could not be verified.</span>
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
              ? "Cleanup evidence is already loading."
              : "Retry the cleanup evidence read."}
          </span>
        </div>
      ) : null}

      {loading && !stats ? (
        <div className="dhw-soft-recovery-skeleton" aria-busy="true">
          <div className="skel" />
          <div className="skel" />
          <div className="skel" />
          <span className="visually-hidden" role="status">
            Loading soft-bounce expiry evidence
          </span>
        </div>
      ) : stats ? (
        <dl>
          <RecoveryFact
            label="Eligible suppressions"
            value={stats.eligible_suppressions_now.toLocaleString()}
          />
          <RecoveryFact
            label="Evidence window"
            value={`${stats.recovery_window_days} days`}
          />
          <RecoveryFact
            label="Subscriber reactivation"
            value={stats.automatic_reactivation_active ? "On" : "Off"}
          />
          <RecoveryFact
            label="Disabled subscribers"
            value={stats.disabled_count.toLocaleString()}
            detail="Context only; never changed here"
          />
        </dl>
      ) : null}

      {lastExpired !== null ? (
        <div className="dhw-soft-recovery-receipt" role="status">
          Last manual cleanup removed {lastExpired.toLocaleString()} expired
          transient suppression{lastExpired === 1 ? "" : "s"}; subscriber status
          remained unchanged.
        </div>
      ) : null}

      {!canAdmin ? (
        <p className="dhw-soft-recovery-permission">
          Admin access is required to run a cleanup. Read-only evidence remains
          available.
        </p>
      ) : null}

      <ConfirmModal
        open={confirmOpen}
        title="Expire eligible transient suppressions?"
        description="This can make recipients eligible for future send-policy evaluation, but it never re-enables a disabled subscriber."
        confirmLabel="Run suppression cleanup"
        typeToConfirm="EXPIRE TRANSIENT SUPPRESSIONS"
        busy={running}
        returnFocusRef={runButtonRef}
        onClose={() => setConfirmOpen(false)}
        onConfirm={runCleanup}
      >
        <div className="dhw-repair-confirmation">
          <strong>Scope of this cleanup</strong>
          <ul>
            <li>
              Only already-expired soft-bounce-threshold suppressions are
              considered.
            </li>
            <li>
              The latest bounce must still be soft and older than the evidence
              window.
            </li>
            <li>Subscriber lifecycle status is never changed.</li>
          </ul>
        </div>
      </ConfirmModal>
    </section>
  );
}

function RecoveryFact({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail?: string;
}): ReactElement {
  return (
    <div>
      <dt>{label}</dt>
      <dd>
        <span>{value}</span>
        {detail ? <small>{detail}</small> : null}
      </dd>
    </div>
  );
}
