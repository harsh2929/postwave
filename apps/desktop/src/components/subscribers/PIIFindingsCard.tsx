import {
  type ReactElement,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import {
  type PIIScanConfig,
  piiFindingsApi,
} from "../../lib/api/pii-findings";
import { fmtDateTime } from "../../lib/format-date";
import { PIIFindingsModal } from "./PIIFindingsModal";
import {
  describePIIFailure,
  type PIISurfaceFailure,
} from "./pii-findings-ui";

interface Props {
  canAdmin: boolean;
}

interface CountSnapshot {
  pending: number;
  reviewed: number;
  verifiedAt: string;
}

const ADMIN_REQUIRED: PIISurfaceFailure = {
  kind: "admin_required",
  title: "Admin access required",
  message:
    "Shadow-PII evidence is restricted to workspace administrators. Ask an admin to review this queue.",
};

const CAPABILITY_UNAVAILABLE: PIISurfaceFailure = {
  kind: "unavailable",
  title: "Scanner capability unavailable",
  message:
    "The scanner is not wired in this deployment. Moosewave is not claiming that the audience is clear of undeclared PII.",
};

function thrownFailure(error: unknown): PIISurfaceFailure {
  void error;
  return {
    kind: "service_unavailable",
    title: "Scanner service unavailable",
    message:
      "The review queue could not be verified. Retry when the service is healthy.",
  };
}

/** Tenant-wide, protected-fingerprint Shadow-PII governance entry point. */
export function PIIFindingsCard({ canAdmin }: Props): ReactElement {
  const [snapshot, setSnapshot] = useState<CountSnapshot | null>(null);
  const [config, setConfig] = useState<PIIScanConfig | null>(null);
  const [failure, setFailure] = useState<PIISurfaceFailure | null>(null);
  const [loading, setLoading] = useState<boolean>(canAdmin);
  const [refreshing, setRefreshing] = useState<boolean>(false);
  const [open, setOpen] = useState<boolean>(false);
  const snapshotRef = useRef<CountSnapshot | null>(null);
  const requestRef = useRef<AbortController | null>(null);
  const requestSequenceRef = useRef(0);

  const loadCount = useCallback(async (): Promise<void> => {
    if (!canAdmin) return;
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    const sequence = ++requestSequenceRef.current;
    const hasVerifiedData = snapshotRef.current !== null;
    setFailure(null);
    setLoading(!hasVerifiedData);
    setRefreshing(hasVerifiedData);

    try {
      const configResponse = await piiFindingsApi.getScanConfig({
        signal: controller.signal,
      });
      if (controller.signal.aborted || sequence !== requestSequenceRef.current) {
        return;
      }
      if (configResponse.error) {
        setFailure(describePIIFailure(configResponse.error));
        return;
      }
      setConfig(configResponse.data);
      if (
        !configResponse.data.available ||
        configResponse.data.status === "unavailable"
      ) {
        setFailure(CAPABILITY_UNAVAILABLE);
        return;
      }
      const [pending, reviewed] = await Promise.all([
        piiFindingsApi.list({
          status: "pending",
          page: 1,
          perPage: 1,
          signal: controller.signal,
        }),
        piiFindingsApi.list({
          status: "reviewed",
          page: 1,
          perPage: 1,
          signal: controller.signal,
        }),
      ]);
      if (controller.signal.aborted || sequence !== requestSequenceRef.current) {
        return;
      }
      // A count is only verified when both probes succeed. Never convert one
      // failed status into a believable zero.
      if (pending.error || reviewed.error) {
        setFailure(describePIIFailure((pending.error ?? reviewed.error)!));
        return;
      }
      const nextSnapshot = {
        pending: pending.data.total,
        reviewed: reviewed.data.total,
        verifiedAt: new Date().toISOString(),
      };
      snapshotRef.current = nextSnapshot;
      setSnapshot(nextSnapshot);
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
  }, [canAdmin]);

  useEffect(() => {
    if (canAdmin) void loadCount();
    return () => requestRef.current?.abort();
  }, [canAdmin, loadCount]);

  useEffect(() => {
    if (canAdmin) return;
    requestRef.current?.abort();
    requestSequenceRef.current += 1;
    snapshotRef.current = null;
    setSnapshot(null);
    setConfig(null);
    setFailure(null);
    setLoading(false);
    setRefreshing(false);
    setOpen(false);
  }, [canAdmin]);

  const disabled = config?.status === "disabled";
  const total = snapshot ? snapshot.pending + snapshot.reviewed : null;
  const visibleFailure = canAdmin ? failure : ADMIN_REQUIRED;
  const ready =
    canAdmin &&
    config?.available === true &&
    config.status !== "unavailable" &&
    snapshot !== null;
  const scannerEnabled = ready && !disabled;

  return (
    <>
      <section
        className={`pii-review-card${visibleFailure ? ` is-${visibleFailure.kind}` : ""}`}
        aria-label="Shadow-PII findings"
        aria-busy={loading || refreshing || undefined}
      >
        <div className="pii-review-card-glow" aria-hidden="true" />
        <header className="pii-review-card-header">
          <div className="pii-review-card-identity">
            <span className="pii-review-card-mark" aria-hidden="true">
              <span />
            </span>
            <div>
              <span className="pii-review-eyebrow">Privacy intelligence</span>
              <h3>Shadow-PII review</h3>
              <p>
                Triage undeclared personal-data patterns without revealing the
                matched values.
              </p>
            </div>
          </div>
          <span
            className={`pii-review-health${scannerEnabled ? " is-limited" : disabled ? " is-disabled" : ""}`}
          >
            <span aria-hidden="true" />
            {loading
              ? "Verifying scanner"
              : refreshing
                ? "Refreshing"
                : disabled
                    ? "Scanner disabled"
                    : scannerEnabled
                      ? "Best-effort scanner enabled"
                    : visibleFailure?.title ?? "Not verified"}
          </span>
        </header>

        {disabled ? (
          <div className="pii-review-card-state">
            <strong>Continuous scanning is off</strong>
            <p>
              New subscriber writes are not being inspected. Existing findings
              remain available for review and no clean-audience claim is being made.
            </p>
          </div>
        ) : null}

        {scannerEnabled ? (
          <div className="pii-review-coverage-notice" role="note">
            <strong>Coverage is unverified</strong>
            <p>
              Partial hooks inspect some subscriber write flows on a best-effort
              basis. There is no durable scan intent, retry/dead-letter queue, or
              coverage-gap ledger, and direct writers may bypass hooks. This queue is
              evidence to review—not proof that every write was scanned or that the
              audience is clear.
            </p>
          </div>
        ) : null}

        {loading && !snapshot ? (
          <div className="pii-review-card-loading" aria-label="Loading review queue">
            <span className="skel" />
            <span className="skel" />
            <span className="skel" />
          </div>
        ) : visibleFailure && !snapshot ? (
          <div className="pii-review-card-state" role="status">
            <strong>{visibleFailure.title}</strong>
            <p>{visibleFailure.message}</p>
          </div>
        ) : snapshot ? (
          <div className="pii-review-card-metrics">
            <div className="is-primary">
              <span>Needs review</span>
              <strong className="tabular">{snapshot.pending.toLocaleString()}</strong>
              <small>awaiting a documented decision</small>
            </div>
            <div>
              <span>Reviewed</span>
              <strong className="tabular">{snapshot.reviewed.toLocaleString()}</strong>
              <small>confirmed, remediated, or accepted</small>
            </div>
            <div>
              <span>Active queue</span>
              <strong className="tabular">{total?.toLocaleString()}</strong>
              <small>dismissed findings excluded</small>
            </div>
          </div>
        ) : null}

        {visibleFailure && snapshot ? (
          <div className="pii-review-stale-notice" role="status">
            <span>
              <strong>{visibleFailure.title}.</strong> {visibleFailure.message}
              {snapshot ? ` Last verified ${fmtDateTime(snapshot.verifiedAt)}.` : ""}
            </span>
            <button type="button" className="btn btn-sm" onClick={() => void loadCount()}>
              Retry
            </button>
          </div>
        ) : null}

        <footer className="pii-review-card-footer">
          <div className="pii-review-provenance">
            {config ? (
              <>
                <span>
                  Detector <strong>{config.detector_name}</strong> {config.detector_version}
                </span>
                <span>
                  Policy <strong>{config.policy_name}</strong> {config.policy_version}
                </span>
                <span>
                  Reliability <strong>best effort</strong>
                </span>
                <span>
                  Coverage <strong>unverified</strong>
                </span>
                {config.fingerprint_scheme && config.fingerprint_key_version ? (
                  <span>
                    Fingerprints <strong>HMAC-SHA256</strong> · key{" "}
                    {config.fingerprint_key_version}
                  </span>
                ) : null}
                <span>
                  Scheduled scans <strong>not available</strong>
                </span>
                <span>
                  Scan caps <strong>{config.max_scan_fields} fields</strong> ·{" "}
                  {config.max_scan_field_bytes / 1024} KiB/field ·{" "}
                  {config.max_detections_per_field} detections/field ·{" "}
                  {config.max_detections_per_subscriber}/subscriber
                </span>
              </>
            ) : (
              <span>Scanner provenance has not been verified.</span>
            )}
          </div>
          <div className="pii-review-card-actions">
            {canAdmin && failure ? (
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                onClick={() => void loadCount()}
                disabled={loading || refreshing}
              >
                {loading || refreshing ? "Checking…" : "Retry verification"}
              </button>
            ) : null}
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => setOpen(true)}
              disabled={!ready}
              aria-describedby={!ready ? "pii-review-action-explanation" : undefined}
            >
              {disabled ? "Review existing findings" : "Review findings"}
            </button>
          </div>
          {!ready ? (
            <span id="pii-review-action-explanation" className="visually-hidden">
              Review becomes available after an administrator verifies an active scanner and queue.
            </span>
          ) : null}
        </footer>
      </section>

      {open ? (
        <PIIFindingsModal
          open
          config={config}
          onClose={() => {
            setOpen(false);
            void loadCount();
          }}
        />
      ) : null}
    </>
  );
}
