import { type ReactElement, useId } from "react";

import { type CampaignDetail } from "../lib/api-client";
import {
  CAMPAIGN_SCHEDULING_AVAILABLE,
  CAMPAIGN_SCHEDULING_UNAVAILABLE_REASON,
} from "../lib/campaign-operational-availability";

export function campaignStatusBadge(status: string | undefined): ReactElement {
  const normalized = (status ?? "draft").toLowerCase();
  if (normalized === "sent" || normalized === "running") {
    return <span className="badge success">Sent</span>;
  }
  if (normalized === "scheduled") {
    return <span className="badge warning">Scheduled</span>;
  }
  if (normalized === "draft") return <span className="badge">Draft</span>;
  if (normalized === "sending") {
    return <span className="badge warning">Sending</span>;
  }
  if (normalized === "paused") {
    return <span className="badge warning">Paused</span>;
  }
  if (normalized === "failed") {
    return <span className="badge danger">Failed</span>;
  }
  return <span className="badge">{status ?? "—"}</span>;
}

export function defaultCampaignScheduleAt(now: Date): string {
  const scheduled = new Date(now.getTime() + 60 * 60 * 1000);
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${scheduled.getFullYear()}-${pad(scheduled.getMonth() + 1)}-${pad(scheduled.getDate())}T${pad(scheduled.getHours())}:${pad(scheduled.getMinutes())}`;
}

export function personalizedWindowTitle(detail: CampaignDetail): string {
  if (detail.send_window_start && detail.send_window_end) {
    return `Each recipient sent at their best hour between ${new Date(
      detail.send_window_start,
    ).toLocaleString()} and ${new Date(detail.send_window_end).toLocaleString()}`;
  }
  return "Each recipient sent at their best hour within the send window";
}

interface CampaignDetailHeaderProps {
  detail: CampaignDetail;
  isDraft: boolean;
  canPauseSend: boolean;
  canResumeSend: boolean;
  canCancelSend: boolean;
  busy: boolean;
  canMutate: boolean;
  canAdmin: boolean;
  authoringLocked: boolean;
  detailErr: string | null;
  scheduleAt: string;
  onScheduleAtChange: (value: string) => void;
  onEdit: () => void;
  onOpenSchedule: () => void;
  onOpenSend: () => void;
  onRunControl: (action: "pause" | "resume") => Promise<void>;
  onDuplicate: () => Promise<void>;
  onSaveAsTemplate: () => void;
  onTranslate: () => void;
  onUtm: () => void;
  onOpenCancel: () => void;
  onOpenDelete: () => void;
}

export function CampaignDetailHeader({
  detail,
  isDraft,
  canPauseSend,
  canResumeSend,
  canCancelSend,
  busy,
  canMutate,
  canAdmin,
  authoringLocked,
  detailErr,
  scheduleAt,
  onScheduleAtChange,
  onEdit,
  onOpenSchedule,
  onOpenSend,
  onRunControl,
  onDuplicate,
  onSaveAsTemplate,
  onTranslate,
  onUtm,
  onOpenCancel,
  onOpenDelete,
}: CampaignDetailHeaderProps): ReactElement {
  const mutationsDisabled =
    busy || !canMutate || detailErr != null || authoringLocked;
  const mutationReasonId = useId();
  const scheduleReasonId = useId();
  const adminReasonId = useId();
  const pauseDescriptionId = useId();
  const cancelDescriptionId = useId();
  const templateDescriptionId = useId();
  const mutationReason = detailErr
    ? "Actions are unavailable until the latest campaign detail reloads."
    : busy
      ? "Another campaign action is still in progress."
      : authoringLocked
        ? "Save or cancel the open editor before acting on the persisted campaign."
        : !canMutate
          ? "Your viewer role cannot change campaigns or control sends."
          : null;
  const adminReason = detailErr
    ? "Actions are unavailable until the latest campaign detail reloads."
    : busy
      ? "Another campaign action is still in progress."
      : authoringLocked
        ? "Save or cancel the open editor before saving the persisted campaign as a template."
        : !canMutate
          ? "Your current role cannot change campaigns."
          : !canAdmin
            ? "Saving a campaign as a template requires the admin role."
            : null;

  return (
    <>
      <div>
        <div
          id="campaign-slideover-title"
          className="page-title"
          style={{
            fontSize: 15,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {detail.name ?? detail.subject ?? "Untitled"}
        </div>
        <div
          className="muted"
          style={{
            fontSize: 12,
            display: "flex",
            gap: 8,
            alignItems: "center",
          }}
        >
          {campaignStatusBadge(detail.status)}
          {detail.per_recipient_optimize ? (
            <span
              className="badge accent"
              aria-label={`Personalized within window. ${personalizedWindowTitle(detail)}`}
            >
              Personalized within window
            </span>
          ) : null}
          {detail.subject ? (
            <>
              <span>·</span>
              <span
                style={{
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                {detail.subject}
              </span>
            </>
          ) : null}
        </div>
      </div>

      {detailErr ? (
        <div className="notice" role="alert" style={{ marginTop: 8 }}>
          Couldn&apos;t load the latest campaign detail: {detailErr}. Editing,
          sending, and scheduling are disabled until it reloads.
        </div>
      ) : null}

      <div className="campaign-actions">
        {isDraft ? (
          <button
            type="button"
            className="btn"
            onClick={() => {
              if (mutationsDisabled) return;
              onEdit();
            }}
            disabled={mutationsDisabled}
            aria-describedby={mutationsDisabled ? mutationReasonId : undefined}
          >
            Edit
          </button>
        ) : null}
        {isDraft ? (
          <button
            type="button"
            className="btn"
            onClick={() => {
              if (mutationsDisabled) return;
              if (!CAMPAIGN_SCHEDULING_AVAILABLE) return;
              if (!scheduleAt) {
                onScheduleAtChange(defaultCampaignScheduleAt(new Date()));
              }
              onOpenSchedule();
            }}
            disabled={mutationsDisabled || !CAMPAIGN_SCHEDULING_AVAILABLE}
            aria-describedby={
              mutationsDisabled ? mutationReasonId : scheduleReasonId
            }
          >
            Schedule
          </button>
        ) : null}
        {isDraft ? (
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => {
              if (mutationsDisabled) return;
              onOpenSend();
            }}
            disabled={mutationsDisabled}
            aria-describedby={mutationsDisabled ? mutationReasonId : undefined}
          >
            Send
          </button>
        ) : null}
        {canPauseSend ? (
          <button
            type="button"
            className="btn"
            onClick={() => {
              if (mutationsDisabled) return;
              void onRunControl("pause");
            }}
            disabled={mutationsDisabled}
            aria-describedby={
              mutationsDisabled ? mutationReasonId : pauseDescriptionId
            }
          >
            Pause
          </button>
        ) : null}
        {canResumeSend ? (
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => {
              if (mutationsDisabled) return;
              void onRunControl("resume");
            }}
            disabled={mutationsDisabled}
            aria-describedby={mutationsDisabled ? mutationReasonId : undefined}
          >
            Resume
          </button>
        ) : null}
        <button
          type="button"
          className="btn"
          onClick={() => {
            if (mutationsDisabled) return;
            void onDuplicate();
          }}
          disabled={mutationsDisabled}
          aria-describedby={mutationsDisabled ? mutationReasonId : undefined}
        >
          Duplicate
        </button>
        <button
          type="button"
          className="btn"
          onClick={() => {
            if (mutationsDisabled || !canAdmin) return;
            onSaveAsTemplate();
          }}
          disabled={mutationsDisabled || !canAdmin}
          aria-describedby={adminReason ? adminReasonId : templateDescriptionId}
        >
          Save as template
        </button>
        <button
          type="button"
          className="btn"
          onClick={() => {
            if (mutationsDisabled) return;
            onTranslate();
          }}
          disabled={mutationsDisabled}
          aria-describedby={mutationsDisabled ? mutationReasonId : undefined}
        >
          Translate
        </button>
        <button
          type="button"
          className="btn"
          onClick={() => {
            if (mutationsDisabled) return;
            onUtm();
          }}
          disabled={mutationsDisabled}
          aria-describedby={mutationsDisabled ? mutationReasonId : undefined}
        >
          UTM
        </button>
        <span className="spacer" />
        {canCancelSend ? (
          <button
            type="button"
            className="btn btn-danger"
            onClick={() => {
              if (mutationsDisabled) return;
              onOpenCancel();
            }}
            disabled={mutationsDisabled}
            aria-describedby={
              mutationsDisabled ? mutationReasonId : cancelDescriptionId
            }
          >
            Cancel send
          </button>
        ) : null}
        <button
          type="button"
          className="btn btn-danger"
          onClick={() => {
            if (mutationsDisabled) return;
            onOpenDelete();
          }}
          disabled={mutationsDisabled}
          aria-describedby={mutationsDisabled ? mutationReasonId : undefined}
        >
          Delete
        </button>
      </div>
      <div
        className="muted"
        style={{ display: "grid", gap: 2, fontSize: 11, lineHeight: 1.4 }}
        aria-live="polite"
      >
        {mutationReason ? (
          <span id={mutationReasonId}>{mutationReason}</span>
        ) : null}
        {isDraft && !CAMPAIGN_SCHEDULING_AVAILABLE && !mutationReason ? (
          <span id={scheduleReasonId}>
            {CAMPAIGN_SCHEDULING_UNAVAILABLE_REASON}
          </span>
        ) : null}
        {adminReason && adminReason !== mutationReason ? (
          <span id={adminReasonId}>{adminReason}</span>
        ) : adminReason ? (
          <span id={adminReasonId} className="sr-only">
            {adminReason}
          </span>
        ) : null}
        {canPauseSend && !mutationsDisabled ? (
          <span id={pauseDescriptionId}>
            Pausing holds queued messages until you resume the send.
          </span>
        ) : null}
        {canCancelSend && !mutationsDisabled ? (
          <span id={cancelDescriptionId}>
            Cancel stops every remaining message and cannot be undone.
          </span>
        ) : null}
        {!adminReason ? (
          <span id={templateDescriptionId} className="sr-only">
            Save the campaign body, subject, and preview as a reusable template.
          </span>
        ) : null}
      </div>
    </>
  );
}
