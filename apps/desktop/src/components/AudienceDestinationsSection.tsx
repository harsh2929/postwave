/**
 * AudienceDestinationsSection — SUB-113 ad-platform audience foundations.
 *
 * Lists the tenant's ad-platform destinations (Meta / Google Ads / TikTok
 * / LinkedIn / Snap), each built from a list or segment and readiness-gated
 * for Custom Audience delivery with consent-aware exclusion. Provides:
 *   - create / edit via AudienceDestinationModal (provider tabs, OAuth
 *     credential entry + readiness probe, source picker, consent preview)
 *   - "Sync now" → records a sync job, including readiness failures
 *   - sync-history drilldown per destination
 *   - delete with confirm
 *
 * Honest-UI: a 404 means the audience-destinations surface isn't enabled;
 * we say so rather than rendering an onboarding hero. RBAC: `canAdmin`
 * gates every mutator.
 *
 * Backend: apps/api/internal/audience_destinations/handlers.go.
 */

import {
  useCallback,
  useEffect,
  useState,
  type ReactElement,
} from "react";

import { AudienceDestinationModal } from "./AudienceDestinationModal";
import { ConfirmModal } from "./ConfirmModal";
import { Modal, ModalFooter } from "./Modal";
import { SectionHeader } from "./SectionHeader";
import { toast } from "./Toast";
import {
  audienceDestinationsApi,
  type AudienceDestination,
  type AudienceDestinationJob,
} from "../lib/api-client";
import { useCapabilityReporter } from "../lib/capability-observations";

const COLS = "1fr 1.4fr 110px 150px 160px";

const PROVIDER_LABELS: Record<string, string> = {
  meta: "Meta",
  google_ads: "Google Ads",
  tiktok: "TikTok",
  linkedin: "LinkedIn",
  snap: "Snap",
};

function fmtTime(s: string | null | undefined): string {
  if (!s) return "never";
  const t = Date.parse(s);
  if (Number.isNaN(t)) return s;
  return new Date(t).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function statusBadge(status: string): ReactElement {
  const s = (status || "").toLowerCase();
  const tone =
    s === "active"
      ? " success"
      : s === "error"
        ? " danger"
        : s === "syncing"
          ? " warning"
          : "";
  return <span className={`badge${tone}`}>{status || "draft"}</span>;
}

function jobEvidenceParts(job: AudienceDestinationJob): string[] {
  const parts: string[] = [];
  const pollAttempts = job.provider_poll_attempts ?? 0;
  if (job.provider_status) parts.push(`Provider ${job.provider_status}`);
  if (job.external_job_id) parts.push(`Job ${job.external_job_id}`);
  if (job.external_audience_id) parts.push(`Audience ${job.external_audience_id}`);
  if (job.provider_message) parts.push(job.provider_message);
  if (job.provider_checked_at) parts.push(`Checked ${fmtTime(job.provider_checked_at)}`);
  if (job.provider_next_check_at) parts.push(`Next ${fmtTime(job.provider_next_check_at)}`);
  if (pollAttempts > 0) {
    parts.push(`${pollAttempts} poll attempt${pollAttempts === 1 ? "" : "s"}`);
  }
  return parts;
}

function sourceLabel(d: AudienceDestination): string {
  if (d.segment_id) return `Segment · ${d.segment_id.slice(0, 8)}…`;
  if (d.list_id) return `List · ${String(d.list_id).slice(0, 8)}…`;
  return "—";
}

export function AudienceDestinationsSection({
  canAdmin,
}: {
  canAdmin: boolean;
}): ReactElement {
  const { available, fromApiError, partialNotConfigured } =
    useCapabilityReporter("audienceSyncs", "ad-platforms");
  const [rows, setRows] = useState<AudienceDestination[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [formTarget, setFormTarget] = useState<
    AudienceDestination | null | undefined
  >(undefined);
  const [deleting, setDeleting] = useState<AudienceDestination | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [syncingId, setSyncingId] = useState<string | null>(null);
  const [jobsFor, setJobsFor] = useState<AudienceDestination | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setErr(null);
    const res = await audienceDestinationsApi.list();
    if (res.error) {
      if (res.error.status === 404 || res.error.status === 405) {
        partialNotConfigured(
          "Ad-platform audience destinations are not enabled on this server. Webhook sync and writeback tools remain independently available.",
        );
      } else {
        fromApiError(res.error, { impact: "partial" });
      }
      setErr(
        res.error.status === 404 || res.error.status === 405
          ? "Ad-platform destinations aren't enabled on this Moosewave server."
          : res.error.message,
      );
      setRows([]);
      return;
    }
    available();
    setRows(res.data?.items ?? []);
  }, [available, fromApiError, partialNotConfigured]);

  useEffect(() => {
    void load();
  }, [load]);

  const syncNow = async (d: AudienceDestination): Promise<void> => {
    if (!canAdmin || syncingId) return;
    setSyncingId(d.id);
    const res = await audienceDestinationsApi.sync(d.id);
    setSyncingId(null);
    if (res.error) {
      toast.error({ message: "Sync failed to start", detail: res.error.message });
      return;
    }
    if (res.queued) {
      toast.error("You're offline — syncs need a live server.");
      return;
    }
    // The server records a job; readiness failures are visible in history.
    toast.success(
      res.data.status === "failed"
        ? "Sync recorded — open history to resolve readiness issues."
        : "Sync accepted — open the history to follow it.",
    );
    await load();
  };

  const confirmDelete = async (): Promise<void> => {
    if (!deleting) return;
    setDeleteBusy(true);
    const res = await audienceDestinationsApi.remove(deleting.id);
    setDeleteBusy(false);
    if (res.error) {
      toast.error({ message: "Delete failed", detail: res.error.message });
      return;
    }
    toast.success("Destination deleted");
    setDeleting(null);
    await load();
  };

  return (
    <div style={{ marginTop: 28 }}>
      <SectionHeader
        title="Ad-platform destinations"
        description="Configure readiness-gated Meta / Google Ads / TikTok / LinkedIn / Snap audience foundations from a list or segment, with consent-aware exclusion. Hashed emails only."
        actions={
          canAdmin && rows && rows.length > 0 ? (
            <button
              type="button"
              className="btn btn-sm btn-primary"
              onClick={() => setFormTarget(null)}
            >
              + New destination
            </button>
          ) : undefined
        }
      />

      {err ? (
        <div className="notice" role="alert">
          <span>{err}</span>
        </div>
      ) : rows === null ? (
        <p className="muted">Loading destinations…</p>
      ) : rows.length === 0 ? (
        <div
          style={{
            border: "1px dashed var(--pw-border)",
            borderRadius: 8,
            padding: "16px 18px",
          }}
        >
          <p className="muted" style={{ fontSize: 13, margin: 0 }}>
            No ad-platform destinations yet. Configure Meta, Google Ads, TikTok,
            LinkedIn, or Snap and stage a consent-aware audience from one of your
            lists or segments.
          </p>
          {canAdmin ? (
            <button
              type="button"
              className="btn btn-sm btn-primary"
              style={{ marginTop: 10 }}
              onClick={() => setFormTarget(null)}
            >
              + New destination
            </button>
          ) : null}
        </div>
      ) : (
        <div className="list">
          <div className="list-header" style={{ gridTemplateColumns: COLS }}>
            <div>Platform</div>
            <div>Source</div>
            <div>Status</div>
            <div>Last synced</div>
            <div></div>
          </div>
          {rows.map((d) => (
            <div
              key={d.id}
              className="list-row"
              style={{ gridTemplateColumns: COLS, cursor: "default" }}
            >
              <div style={{ fontWeight: 500 }}>
                {PROVIDER_LABELS[d.provider] ?? d.provider}
              </div>
              <div className="muted tabular" style={{ fontSize: 12 }}>
                {sourceLabel(d)}
                {d.external_audience_id ? (
                  <span className="mono" style={{ marginLeft: 6 }}>
                    · {d.external_audience_id}
                  </span>
                ) : null}
              </div>
              <div>{statusBadge(d.status)}</div>
              <div className="muted tabular" style={{ fontSize: 12 }}>
                {fmtTime(d.last_synced_at)}
              </div>
              <div
                style={{
                  display: "flex",
                  justifyContent: "flex-end",
                  alignItems: "center",
                  gap: 6,
                }}
              >
                <button
                  type="button"
                  className="btn btn-sm btn-ghost"
                  onClick={() => setJobsFor(d)}
                >
                  History
                </button>
                {canAdmin ? (
                  <>
                    <button
                      type="button"
                      className="btn btn-sm"
                      disabled={syncingId !== null}
                      onClick={() => void syncNow(d)}
                    >
                      {syncingId === d.id ? "Syncing…" : "Sync now"}
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm btn-ghost"
                      onClick={() => setFormTarget(d)}
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm btn-ghost"
                      onClick={() => setDeleting(d)}
                    >
                      Delete
                    </button>
                  </>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      )}

      {formTarget !== undefined ? (
        <AudienceDestinationModal
          destination={formTarget}
          onClose={() => setFormTarget(undefined)}
          onSaved={async () => {
            setFormTarget(undefined);
            await load();
          }}
        />
      ) : null}

      {jobsFor ? (
        <JobsModal
          destination={jobsFor}
          onClose={() => setJobsFor(null)}
        />
      ) : null}

      <ConfirmModal
        open={deleting !== null}
        title="Delete audience destination?"
        description={
          deleting
            ? `The ${PROVIDER_LABELS[deleting.provider] ?? deleting.provider} destination and its sync history will be removed. The platform-side audience is not deleted.`
            : undefined
        }
        confirmLabel="Delete destination"
        danger
        busy={deleteBusy}
        onConfirm={() => void confirmDelete()}
        onClose={() => (deleteBusy ? undefined : setDeleting(null))}
      />
    </div>
  );
}

function JobsModal({
  destination,
  onClose,
}: {
  destination: AudienceDestination;
  onClose: () => void;
}): ReactElement {
  const [jobs, setJobs] = useState<AudienceDestinationJob[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const res = await audienceDestinationsApi.listJobs(destination.id);
      if (cancelled) return;
      if (res.error) {
        setErr(res.error.message);
        setJobs([]);
        return;
      }
      setJobs(res.data?.items ?? []);
    })();
    return () => {
      cancelled = true;
    };
  }, [destination.id]);

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={`Sync history — ${PROVIDER_LABELS[destination.provider] ?? destination.provider}`}
      description="Every recorded sync for this destination, newest first."
    >
      {err ? (
        <div className="notice" role="alert">
          <span>Couldn&apos;t load history: {err}</span>
        </div>
      ) : jobs === null ? (
        <p className="muted">Loading history…</p>
      ) : jobs.length === 0 ? (
        <p className="muted" style={{ fontSize: 13 }}>
          No syncs recorded yet — use "Sync now" to push the audience.
        </p>
      ) : (
        <div className="list">
          <div
            className="list-header"
            style={{ gridTemplateColumns: "110px 1fr 90px 160px" }}
          >
            <div>Status</div>
            <div>Detail</div>
            <div>Members</div>
            <div>Started</div>
          </div>
          {jobs.map((j) => {
            const evidence = jobEvidenceParts(j);
            const secondary = j.error ? evidence : evidence.slice(1);
            return (
              <div
                key={j.id}
                className="list-row"
                style={{
                  gridTemplateColumns: "110px 1fr 90px 160px",
                  cursor: "default",
                }}
              >
                <div>{statusBadge(j.status)}</div>
                <div
                  className="muted"
                  style={{ fontSize: 12, minWidth: 0 }}
                  title={[j.error, ...evidence].filter(Boolean).join(" · ") || undefined}
                >
                  <div
                    style={{
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      color: j.error ? "var(--pw-danger)" : undefined,
                    }}
                  >
                    {j.error || evidence[0] || "—"}
                  </div>
                  {secondary.length > 0 ? (
                    <div
                      style={{
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                      }}
                    >
                      {secondary.join(" · ")}
                    </div>
                  ) : null}
                </div>
                <div className="muted tabular" style={{ fontSize: 12 }}>
                  {(j.members_synced || 0).toLocaleString()}
                </div>
                <div className="muted tabular" style={{ fontSize: 12 }}>
                  {fmtTime(j.started_at)}
                </div>
              </div>
            );
          })}
        </div>
      )}
      <ModalFooter>
        <button type="button" className="btn" onClick={onClose}>
          Close
        </button>
      </ModalFooter>
    </Modal>
  );
}
