/**
 * ContentOptimizerCard — coverage item #14 (content_optimizer).
 *
 * Shows the latest optimizer run for a campaign (GET, 404 = none
 * yet), lets the operator preview a bandit allocation without
 * persisting (POST .../preview), and start a persisted run (POST).
 * Arms default to server-derived (A/B variants when present, a
 * "control" arm otherwise) — we send an empty config and render
 * exactly what the server allocated.
 */

import { type ReactElement, useEffect, useId, useRef, useState } from "react";

import {
  type OptimizerArmAllocation,
  type OptimizerPreviewResponse,
  type OptimizerRun,
  contentOptimizerApi,
} from "../../lib/api-client";
import { Notice } from "../Notice";
import { SectionHeader } from "../SectionHeader";
import { Skeleton } from "../Skeleton";
import { toast } from "../Toast";

interface Props {
  campaignId: string | number;
  canMutate: boolean;
}

// Persisted optimizer runs are not consumed by recipient dispatch yet. Keep
// previewing available, but do not let production UI create a configuration
// that looks active while changing nothing at send time.
const CONTENT_OPTIMIZER_DISPATCH_ENABLED = false;

function AllocationTable({
  arms,
}: {
  arms: OptimizerArmAllocation[];
}): ReactElement {
  return (
    <table className="link-table">
      <tbody>
        {arms.map((arm) => (
          <tr key={arm.key}>
            <td style={{ fontWeight: 600, fontSize: 12, whiteSpace: "nowrap" }}>
              {arm.key}
            </td>
            <td
              className="muted"
              style={{
                fontSize: 11,
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
                maxWidth: 180,
              }}
              title={arm.subject ?? arm.reason}
            >
              {arm.subject ?? arm.reason}
            </td>
            <td
              className="tabular"
              style={{ whiteSpace: "nowrap" }}
              title={`explore ${arm.exploration_percent.toFixed(1)}% · exploit ${arm.exploitation_percent.toFixed(1)}% · score ${arm.score.toFixed(3)}`}
            >
              {arm.allocation_percent.toFixed(1)}%
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function ContentOptimizerCard({
  campaignId,
  canMutate,
}: Props): ReactElement {
  const [run, setRun] = useState<OptimizerRun | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadErr, setLoadErr] = useState<string | null>(null);

  const [preview, setPreview] = useState<OptimizerPreviewResponse | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [previewErr, setPreviewErr] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const startDescriptionId = useId();
  const startInFlightRef = useRef(false);

  const load = async (): Promise<void> => {
    setLoading(true);
    setLoadErr(null);
    const res = await contentOptimizerApi.get(campaignId);
    setLoading(false);
    if (res.error) {
      if (res.error.status === 404) {
        setRun(null); // no run yet — a real state
        return;
      }
      setLoadErr(res.error.message);
      return;
    }
    setRun(res.data);
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [campaignId]);

  const runPreview = async (): Promise<void> => {
    setPreviewing(true);
    setPreviewErr(null);
    const res = await contentOptimizerApi.preview(campaignId);
    setPreviewing(false);
    if (res.error) {
      setPreviewErr(res.error.message);
      return;
    }
    setPreview(res.data);
  };

  const start = async (): Promise<void> => {
    if (
      !CONTENT_OPTIMIZER_DISPATCH_ENABLED ||
      !canMutate ||
      startInFlightRef.current
    )
      return;
    startInFlightRef.current = true;
    setStarting(true);
    try {
      const res = await contentOptimizerApi.createRun(campaignId);
      if (res.error) {
        toast.error(`Couldn't start optimizer run: ${res.error.message}`);
        return;
      }
      // GAP-3#9: be honest — persisting a run records the allocation but no
      // dispatcher consumes it, so nothing shifts at send yet.
      toast.success("Optimizer run saved (not yet applied at send)");
      setPreview(null);
      setRun(res.data);
    } catch {
      toast.error(
        "Couldn't start optimizer run. Check your connection and retry.",
      );
    } finally {
      startInFlightRef.current = false;
      setStarting(false);
    }
  };

  const startUnavailableReason = !CONTENT_OPTIMIZER_DISPATCH_ENABLED
    ? "Activation is unavailable until recipient dispatch consumes the reviewed allocation."
    : !canMutate
      ? "Viewer role can't start optimizer runs."
      : starting
        ? "An optimizer run is already being started."
        : null;

  return (
    <div style={{ marginTop: 16 }}>
      <SectionHeader
        title="Content optimizer"
        description="Planning preview of a bandit-style allocation across content arms. Recorded runs are not applied at send yet — nothing in the dispatch path reads them."
        actions={
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => void load()}
            disabled={loading}
          >
            {loading ? "Refreshing…" : "Refresh"}
          </button>
        }
      />

      {loading ? (
        <Skeleton lines={2} aria-label="Loading optimizer state" />
      ) : loadErr ? (
        <Notice
          tone="danger"
          title="Couldn't load optimizer state"
          action={
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => void load()}
            >
              Retry
            </button>
          }
        >
          {loadErr}
        </Notice>
      ) : run ? (
        <div style={{ display: "grid", gap: 6 }}>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <span className="badge accent">{run.status}</span>
            <span className="muted" style={{ fontSize: 11 }}>
              {run.preview.method} · optimizing {run.preview.primary_metric} ·{" "}
              {(run.preview.exploration_rate * 100).toFixed(0)}% exploration
            </span>
          </div>
          <AllocationTable arms={run.preview.recommended_arms} />
          {/* GAP-3#9: no send-path reader consumes optimizer runs today. */}
          <div className="muted" style={{ fontSize: 11 }}>
            Recorded allocation — not yet applied to what gets sent.
          </div>
          <div className="muted" style={{ fontSize: 11 }}>
            Run {run.id.slice(0, 8)}… · created{" "}
            {new Date(run.created_at).toLocaleString()}
          </div>
        </div>
      ) : (
        <div style={{ display: "grid", gap: 6 }}>
          <div className="muted" style={{ fontSize: 12 }}>
            No optimizer run yet for this campaign.
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => void runPreview()}
              disabled={previewing}
            >
              {previewing ? "Previewing…" : "Preview allocation"}
            </button>
            <button
              type="button"
              className="btn btn-sm btn-primary"
              onClick={() => void start()}
              disabled={startUnavailableReason !== null}
              aria-disabled={startUnavailableReason !== null || undefined}
              aria-describedby={startDescriptionId}
              aria-busy={starting || undefined}
            >
              {starting ? "Starting…" : "Activation unavailable"}
            </button>
            <span id={startDescriptionId} className="visually-hidden">
              {startUnavailableReason ??
                "Save the planning allocation. Recorded runs are not yet applied at send."}
            </span>
          </div>
          {previewErr ? (
            <Notice
              tone="danger"
              title="Preview failed"
              action={
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => void runPreview()}
                >
                  Retry
                </button>
              }
            >
              {previewErr}
            </Notice>
          ) : null}
          {preview ? (
            <div style={{ display: "grid", gap: 4 }}>
              <div className="muted" style={{ fontSize: 11 }}>
                Allocation preview ({preview.method}, optimizing{" "}
                {preview.primary_metric}) — nothing persisted yet:
              </div>
              <AllocationTable arms={preview.recommended_arms} />
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
