/**
 * Authoritative audience evidence for the campaign send ceremony.
 *
 * This panel deliberately fails closed. A static audience description is useful
 * context, but it is not evidence that the current campaign can be sent safely.
 * Only a complete, internally consistent response for the current campaign and
 * request may unlock Send.
 */

import {
  type ReactElement,
  type RefObject,
  useEffect,
  useRef,
  useState,
} from "react";

import { api, type CampaignSendPreview } from "../lib/api-client";

export type AudiencePreviewEvidence =
  | { status: "idle"; campaignId: string | null; requestId: number }
  | { status: "loading"; campaignId: string; requestId: number }
  | {
      status: "ready";
      campaignId: string;
      requestId: number;
      preview: CampaignSendPreview;
    }
  | {
      status: "error";
      campaignId: string;
      requestId: number;
      message: string;
    };

interface Props {
  campaignId: string | number;
  evidence: AudiencePreviewEvidence;
  onEvidenceChange: (evidence: AudiencePreviewEvidence) => void;
  retryFocusRef?: RefObject<HTMLButtonElement | null>;
}

const NUM = new Intl.NumberFormat();

function n(value: number): string {
  return NUM.format(value);
}

function audienceLabel(preview: CampaignSendPreview): string {
  if (preview.audience_kind === "segment") {
    return preview.segment_label
      ? `segment "${preview.segment_label}"`
      : "a segment";
  }
  if (preview.audience_kind === "list") return "a list";
  return "every subscribed recipient";
}

function isWholeNonNegative(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

/**
 * Validate the wire response before treating it as send authorization evidence.
 * Sentinel values are useful for read-only dashboards, but a suppression or cap
 * calculation that is unavailable cannot safely authorize a destructive send.
 */
export function audiencePreviewProblem(
  preview: CampaignSendPreview,
  campaignId: string,
): string | null {
  if (String(preview.campaign_id) !== campaignId) {
    return "The audience result belongs to a different campaign.";
  }
  if (!new Set(["segment", "list", "workspace"]).has(preview.audience_kind)) {
    return "The audience type returned by the server is invalid.";
  }
  if (
    !isWholeNonNegative(preview.recipients) ||
    !isWholeNonNegative(preview.deliverable)
  ) {
    return "The recipient totals returned by the server are unavailable.";
  }
  if (!isWholeNonNegative(preview.suppressed_excluded)) {
    return "Suppression exclusions could not be verified.";
  }
  if (
    preview.suppressed_excluded > preview.recipients ||
    preview.deliverable !== preview.recipients - preview.suppressed_excluded
  ) {
    return "The recipient and suppression totals do not reconcile.";
  }
  if (!Number.isFinite(Date.parse(preview.counted_at))) {
    return "The audience result has no valid verification time.";
  }

  if (preview.tier_cap_today === -1) {
    if (
      preview.tier_cap_remaining !== -1 ||
      preview.tier_cap_remaining_after !== -1 ||
      preview.over_cap
    ) {
      return "The warmup-cap result is internally inconsistent.";
    }
    return null;
  }

  if (
    !isWholeNonNegative(preview.tier_cap_today) ||
    !isWholeNonNegative(preview.tier_cap_remaining) ||
    !isWholeNonNegative(preview.tier_cap_remaining_after) ||
    preview.tier_cap_remaining > preview.tier_cap_today ||
    preview.tier_cap_remaining_after !==
      Math.max(0, preview.tier_cap_remaining - preview.deliverable) ||
    preview.over_cap !== preview.deliverable > preview.tier_cap_remaining
  ) {
    return "The warmup-cap result is incomplete or inconsistent.";
  }
  return null;
}

export function isCurrentAudiencePreviewReady(
  evidence: AudiencePreviewEvidence,
  campaignId: string,
): evidence is Extract<AudiencePreviewEvidence, { status: "ready" }> {
  return (
    evidence.status === "ready" &&
    evidence.campaignId === campaignId &&
    audiencePreviewProblem(evidence.preview, campaignId) == null
  );
}

function unexpectedErrorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim()
    ? error.message
    : "The audience request failed unexpectedly.";
}

export function AudiencePreviewPanel({
  campaignId,
  evidence,
  onEvidenceChange,
  retryFocusRef,
}: Props): ReactElement {
  const normalizedCampaignId = String(campaignId);
  const requestSequenceRef = useRef(0);
  const [retrySequence, setRetrySequence] = useState(0);

  useEffect(() => {
    const requestId = ++requestSequenceRef.current;
    let cancelled = false;
    onEvidenceChange({
      status: "loading",
      campaignId: normalizedCampaignId,
      requestId,
    });

    void (async () => {
      try {
        const result = await api.getCampaignSendPreview(campaignId);
        if (cancelled || requestSequenceRef.current !== requestId) return;
        if (result.error) {
          onEvidenceChange({
            status: "error",
            campaignId: normalizedCampaignId,
            requestId,
            message: result.error.message,
          });
          return;
        }
        const problem = audiencePreviewProblem(
          result.data,
          normalizedCampaignId,
        );
        if (problem) {
          onEvidenceChange({
            status: "error",
            campaignId: normalizedCampaignId,
            requestId,
            message: problem,
          });
          return;
        }
        onEvidenceChange({
          status: "ready",
          campaignId: normalizedCampaignId,
          requestId,
          preview: result.data,
        });
      } catch (error) {
        if (cancelled || requestSequenceRef.current !== requestId) return;
        onEvidenceChange({
          status: "error",
          campaignId: normalizedCampaignId,
          requestId,
          message: unexpectedErrorMessage(error),
        });
      }
    })();

    return () => {
      cancelled = true;
      requestSequenceRef.current += 1;
    };
  }, [campaignId, normalizedCampaignId, onEvidenceChange, retrySequence]);

  const currentEvidence =
    evidence.campaignId === normalizedCampaignId
      ? evidence
      : ({
          status: "loading",
          campaignId: normalizedCampaignId,
          requestId: requestSequenceRef.current,
        } satisfies AudiencePreviewEvidence);

  if (
    currentEvidence.status === "idle" ||
    currentEvidence.status === "loading"
  ) {
    return (
      <div
        className="audience-preview-panel"
        role="status"
        aria-live="polite"
        aria-busy="true"
        style={{
          border: "1px solid var(--pw-border)",
          borderRadius: 8,
          padding: 12,
          marginBottom: 12,
          fontSize: 13,
        }}
      >
        <span className="sr-only">
          Verifying the current recipients, suppressions, and send cap.
        </span>
        <div
          className="skel"
          style={{ height: 12, width: "55%", marginBottom: 8 }}
        />
        <div className="skel" style={{ height: 12, width: "70%" }} />
      </div>
    );
  }

  if (currentEvidence.status === "error") {
    return (
      <div
        className="notice"
        role="alert"
        style={{
          border: "1px solid var(--pw-danger)",
          borderRadius: 8,
          padding: 10,
          marginBottom: 12,
          fontSize: 12,
        }}
      >
        <div style={{ fontWeight: 600, marginBottom: 4 }}>
          Audience verification failed
        </div>
        <div className="muted" style={{ marginBottom: 8 }}>
          {currentEvidence.message} Sending stays locked until an exact current
          audience can be verified.
        </div>
        <button
          ref={retryFocusRef}
          type="button"
          className="btn btn-sm"
          onClick={() => setRetrySequence((attempt) => attempt + 1)}
        >
          Retry audience verification
        </button>
      </div>
    );
  }

  const preview = currentEvidence.preview;

  return (
    <div
      className="audience-preview-panel"
      role="status"
      aria-live="polite"
      style={{
        border: "1px solid var(--pw-border)",
        borderRadius: 8,
        padding: 12,
        marginBottom: 12,
        background: "var(--pw-bg-elev)",
        fontSize: 13,
      }}
    >
      <div style={{ marginBottom: 4 }}>
        <span className="tabular" style={{ fontWeight: 600 }}>
          {n(preview.recipients)}
        </span>{" "}
        recipient{preview.recipients === 1 ? "" : "s"} in{" "}
        {audienceLabel(preview)}
      </div>

      {preview.suppressed_excluded > 0 ? (
        <div className="muted" style={{ fontSize: 12 }}>
          − {n(preview.suppressed_excluded)} excluded by suppression
        </div>
      ) : null}

      <div
        className="tabular"
        style={{ marginTop: 6, fontSize: 13, fontWeight: 600 }}
      >
        = {n(preview.deliverable)} will receive this email
      </div>

      {preview.tier_cap_today >= 0 ? (
        <div
          className="muted"
          style={{
            marginTop: 8,
            paddingTop: 8,
            borderTop: "1px solid var(--pw-border)",
            fontSize: 12,
          }}
        >
          Today&rsquo;s cap: {n(preview.tier_cap_today)} ·{" "}
          {n(preview.tier_cap_remaining)} remaining ·{" "}
          <span
            className="tabular"
            style={{
              color: preview.over_cap
                ? "var(--pw-danger)"
                : "var(--pw-fg-muted)",
              fontWeight: preview.over_cap ? 600 : 400,
            }}
          >
            {n(preview.tier_cap_remaining_after)} left after send
          </span>
        </div>
      ) : (
        <div
          className="muted"
          style={{
            marginTop: 8,
            paddingTop: 8,
            borderTop: "1px solid var(--pw-border)",
            fontSize: 12,
          }}
        >
          No daily cap on this tier.
        </div>
      )}

      {preview.over_cap ? (
        <div
          role="alert"
          style={{
            marginTop: 10,
            padding: 8,
            border: "1px solid var(--pw-danger)",
            borderRadius: 6,
            background: "color-mix(in srgb, var(--pw-danger) 8%, transparent)",
            color: "var(--pw-danger)",
            fontSize: 12,
            fontWeight: 500,
          }}
        >
          This send exceeds today&rsquo;s warmup cap. Wait until tomorrow, send
          to a smaller audience, or contact support to raise the cap.
        </div>
      ) : null}
    </div>
  );
}
