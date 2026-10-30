/**
 * Campaign-detail send, schedule, template, and engagement controls.
 *
 * These focused presentation boundaries keep modal validation and UI state
 * wiring out of the slideover's data-orchestration component.
 */

import {
  type Dispatch,
  type ReactElement,
  type SetStateAction,
  useEffect,
  useId,
  useRef,
} from "react";

import type { CampaignDetail } from "../lib/api-client";
import {
  CAMPAIGN_SCHEDULING_AVAILABLE,
  CAMPAIGN_SCHEDULING_UNAVAILABLE_REASON,
} from "../lib/campaign-operational-availability";
import {
  AudiencePreviewPanel,
  type AudiencePreviewEvidence,
  isCurrentAudiencePreviewReady,
} from "./AudiencePreviewPanel";
import { CampaignAssuranceSendStatus } from "./CampaignAssurancePanel";
import type { CampaignChecklistEvidence } from "./campaigns/useCampaignLifecycleController";
import { CAMPAIGN_CHECKLIST_OVERRIDE_AVAILABLE } from "./campaigns/useCampaignSendEvidence";
import { ConfirmModal } from "./ConfirmModal";
import { Modal, ModalFooter } from "./Modal";
import { SendTimeOptBanner } from "./SendTimeOptBanner";

export function toCampaignDateTimeLocal(iso: string): string {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return iso;
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(
    date.getDate(),
  )}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function CampaignSendConfirmationModal({
  confirmSendOpen,
  setConfirmSendOpen,
  detail,
  id,
  checklistEvidence,
  retryChecklist,
  audiencePreviewEvidence,
  setAudiencePreviewEvidence,
  checklistFailureOverride,
  setChecklistFailureOverride,
  busy,
  canMutate,
  authoringLocked,
  detailErr,
  send,
}: {
  confirmSendOpen: boolean;
  setConfirmSendOpen: Dispatch<SetStateAction<boolean>>;
  detail: CampaignDetail;
  id: string | number | null | undefined;
  checklistEvidence: CampaignChecklistEvidence;
  retryChecklist: () => void;
  audiencePreviewEvidence: AudiencePreviewEvidence;
  setAudiencePreviewEvidence: (evidence: AudiencePreviewEvidence) => void;
  checklistFailureOverride: boolean;
  setChecklistFailureOverride: Dispatch<SetStateAction<boolean>>;
  busy: boolean;
  canMutate: boolean;
  authoringLocked: boolean;
  detailErr: string | null;
  send: () => Promise<void>;
}): ReactElement {
  const sendReasonId = useId();
  const checklistRetryRef = useRef<HTMLButtonElement | null>(null);
  const audienceRetryRef = useRef<HTMLButtonElement | null>(null);
  const focusedFailureRef = useRef<string | null>(null);
  const campaignId = id == null ? null : String(id);
  const checklistIsCurrent =
    campaignId != null && checklistEvidence.campaignId === campaignId;
  const audienceIsCurrent =
    campaignId != null &&
    isCurrentAudiencePreviewReady(audiencePreviewEvidence, campaignId);
  const sendBlockedByCap =
    audienceIsCurrent && audiencePreviewEvidence.preview.over_cap;

  useEffect(() => {
    if (!confirmSendOpen) {
      focusedFailureRef.current = null;
      return;
    }
    const failureKey =
      checklistIsCurrent && checklistEvidence.status === "error"
        ? `checklist:${checklistEvidence.requestId}`
        : audiencePreviewEvidence.campaignId === campaignId &&
            audiencePreviewEvidence.status === "error"
          ? `audience:${audiencePreviewEvidence.requestId}`
          : null;
    if (failureKey == null || focusedFailureRef.current === failureKey) return;
    focusedFailureRef.current = failureKey;
    queueMicrotask(() => {
      if (failureKey.startsWith("checklist:")) {
        checklistRetryRef.current?.focus();
      } else {
        audienceRetryRef.current?.focus();
      }
    });
  }, [
    audiencePreviewEvidence,
    campaignId,
    checklistEvidence,
    checklistIsCurrent,
    confirmSendOpen,
  ]);

  const sendUnavailableReason = busy
    ? "The campaign is already being queued."
    : !canMutate
      ? "Your current role cannot send campaigns. Close this review or ask an admin to restore campaign write access."
      : authoringLocked
        ? "Save or cancel the open editor before sending the persisted campaign."
        : detailErr != null
          ? "Campaign detail failed to load — reopen the campaign before sending."
          : campaignId == null
            ? "Campaign identity is unavailable — reopen the campaign before sending."
            : !checklistIsCurrent || checklistEvidence.status === "idle"
              ? "The current pre-send checklist has not been verified."
              : checklistEvidence.status === "loading"
                ? "Wait for the current pre-send checklist to finish."
                : checklistEvidence.status === "error"
                  ? "Retry the failed pre-send checklist before sending."
                  : checklistEvidence.status === "not-ready" &&
                      (!CAMPAIGN_CHECKLIST_OVERRIDE_AVAILABLE ||
                        !checklistFailureOverride)
                    ? CAMPAIGN_CHECKLIST_OVERRIDE_AVAILABLE
                      ? "Review the failed checklist and acknowledge the risk before sending."
                      : "Resolve every failed pre-send check before sending. Checklist overrides are unavailable."
                    : audiencePreviewEvidence.campaignId !== campaignId ||
                        audiencePreviewEvidence.status === "idle"
                      ? "The current audience has not been verified."
                      : audiencePreviewEvidence.status === "loading"
                        ? "Wait for recipient and suppression verification to finish."
                        : audiencePreviewEvidence.status === "error"
                          ? "Retry the failed audience verification before sending."
                          : !audienceIsCurrent
                            ? "The audience evidence is stale or does not match this campaign."
                            : sendBlockedByCap
                              ? "This send exceeds today's warmup cap — wait until tomorrow or send to a smaller segment."
                              : null;

  return (
    <Modal
      open={confirmSendOpen}
      onClose={() => {
        setConfirmSendOpen(false);
      }}
      title="Send campaign?"
      description={
        detail.segment_id
          ? `This will queue "${detail.name ?? "this campaign"}" for immediate delivery to the configured segment.`
          : detail.list_id
            ? `This will queue "${detail.name ?? "this campaign"}" for immediate delivery to the configured list.`
            : `This will queue "${detail.name ?? "this campaign"}" for immediate delivery to every subscribed recipient in the workspace.`
      }
      closeOnBackdrop={!busy}
      closeOnEscape={!busy}
      closeDisabled={busy}
      role="alertdialog"
    >
      {id != null ? (
        <AudiencePreviewPanel
          campaignId={id}
          evidence={audiencePreviewEvidence}
          onEvidenceChange={setAudiencePreviewEvidence}
          retryFocusRef={audienceRetryRef}
        />
      ) : null}
      {campaignId != null ? (
        <CampaignAssuranceSendStatus campaignId={campaignId} />
      ) : null}
      <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
        {detail.segment_id ? (
          <>
            Audience: subscribers matching segment{" "}
            <span className="mono">{detail.segment_id.slice(0, 8)}…</span>.
          </>
        ) : detail.list_id ? (
          <>
            Audience: subscribers in list{" "}
            <span className="mono">{detail.list_id.slice(0, 8)}…</span>.
          </>
        ) : (
          <>Audience: every subscribed recipient in this workspace.</>
        )}
      </div>
      <div className="muted" style={{ fontSize: 11, marginBottom: 4 }}>
        Voice drift and inbox-placement advisories live in the AI copilot panel
        on the campaign view.
      </div>
      {!checklistIsCurrent || checklistEvidence.status === "idle" ? (
        <div className="notice" role="status" aria-live="polite">
          Preparing the pre-send checklist for this campaign…
        </div>
      ) : checklistEvidence.status === "loading" ? (
        <div className="notice" role="status" aria-live="polite">
          Running the pre-send checklist…
        </div>
      ) : checklistEvidence.status === "error" ? (
        <div className="notice" role="alert" style={{ fontSize: 12 }}>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>
            Pre-send checklist unavailable
          </div>
          <div className="muted" style={{ marginBottom: 8 }}>
            {checklistEvidence.message} Sending stays locked until the current
            checklist can be reviewed.
          </div>
          <button
            ref={checklistRetryRef}
            type="button"
            className="btn btn-sm"
            onClick={retryChecklist}
          >
            Retry pre-send checklist
          </button>
        </div>
      ) : checklistEvidence.status === "ready" ? (
        <div className="notice" role="status" aria-live="polite">
          Pre-send checklist passed for this campaign.
        </div>
      ) : (
        <div
          className="notice"
          role="alert"
          style={{ fontSize: 12, marginBottom: 8 }}
        >
          <div style={{ marginBottom: 6 }}>
            The current pre-send checklist has failing items. Close this dialog
            and resolve them before sending.
          </div>
          {CAMPAIGN_CHECKLIST_OVERRIDE_AVAILABLE ? (
            <label
              style={{
                display: "flex",
                gap: 8,
                alignItems: "center",
                cursor: "pointer",
              }}
            >
              <input
                type="checkbox"
                checked={checklistFailureOverride}
                onChange={(e) => setChecklistFailureOverride(e.target.checked)}
              />
              I reviewed the failed checks and accept the risk
            </label>
          ) : (
            <div className="muted">
              Failed checklist items cannot be overridden. Resolve them and
              rerun the checklist before sending.
            </div>
          )}
        </div>
      )}
      {sendUnavailableReason ? (
        <p
          id={sendReasonId}
          className="muted"
          role="status"
          aria-live="polite"
          style={{ fontSize: 11, margin: "0 0 8px" }}
        >
          {sendUnavailableReason}
        </p>
      ) : null}
      <ModalFooter>
        <button
          type="button"
          className="btn"
          onClick={() => {
            setConfirmSendOpen(false);
          }}
          disabled={busy}
        >
          Cancel
        </button>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => {
            if (sendUnavailableReason) return;
            void send();
          }}
          disabled={sendUnavailableReason != null}
          aria-disabled={sendUnavailableReason ? true : undefined}
          aria-describedby={sendUnavailableReason ? sendReasonId : undefined}
        >
          {busy
            ? "Sending…"
            : checklistEvidence.status === "loading" ||
                audiencePreviewEvidence.status === "loading"
              ? "Checking…"
              : "Send now"}
        </button>
      </ModalFooter>
    </Modal>
  );
}

export function CampaignScheduleModal({
  scheduleOpen,
  setScheduleOpen,
  detail,
  id,
  setScheduleAt,
  scheduleAt,
  pstoOn,
  setPstoOn,
  pstoWindowStart,
  setPstoWindowStart,
  pstoWindowEnd,
  setPstoWindowEnd,
  busy,
  pstoSaving,
  scheduleDiscardConfirmOpen,
  keepScheduleDraft,
  discardScheduleDraft,
  schedule,
}: {
  scheduleOpen: boolean;
  setScheduleOpen: Dispatch<SetStateAction<boolean>>;
  detail: CampaignDetail;
  id: string | number | null | undefined;
  setScheduleAt: Dispatch<SetStateAction<string>>;
  scheduleAt: string;
  pstoOn: boolean;
  setPstoOn: Dispatch<SetStateAction<boolean>>;
  pstoWindowStart: string;
  setPstoWindowStart: Dispatch<SetStateAction<string>>;
  pstoWindowEnd: string;
  setPstoWindowEnd: Dispatch<SetStateAction<string>>;
  busy: boolean;
  pstoSaving: boolean;
  scheduleDiscardConfirmOpen: boolean;
  keepScheduleDraft: () => void;
  discardScheduleDraft: () => void;
  schedule: () => Promise<void>;
}): ReactElement {
  const scheduleLocked = busy || pstoSaving || !CAMPAIGN_SCHEDULING_AVAILABLE;
  const operationBusy = busy || pstoSaving;
  const availabilityDescription = CAMPAIGN_SCHEDULING_AVAILABLE
    ? undefined
    : "campaign-scheduling-availability";
  return (
    <>
      <Modal
        open={scheduleOpen}
        onClose={() => {
          if (!operationBusy) setScheduleOpen(false);
        }}
        closeOnBackdrop={!operationBusy}
        closeOnEscape={!operationBusy}
        closeDisabled={operationBusy}
        title="Schedule send"
        description={`Pick when "${
          detail.name ?? "this campaign"
        }" should go out. Recipients receive the email at the chosen time.`}
      >
        {!CAMPAIGN_SCHEDULING_AVAILABLE ? (
          <div
            id="campaign-scheduling-availability"
            className="notice"
            role="status"
            style={{ marginBottom: 12 }}
          >
            <strong>Scheduling is unavailable</strong>
            <div className="muted" style={{ marginTop: 4 }}>
              {CAMPAIGN_SCHEDULING_UNAVAILABLE_REASON}
            </div>
          </div>
        ) : null}
        {CAMPAIGN_SCHEDULING_AVAILABLE ? (
          <SendTimeOptBanner
            segmentId={detail.segment_id ?? null}
            campaignId={id ?? null}
            // datetime-local needs "YYYY-MM-DDTHH:mm" in local time.
            onApply={(iso) => setScheduleAt(toCampaignDateTimeLocal(iso))}
          />
        ) : null}
        <div className="field">
          <label className="field-label" htmlFor="cam-schedule-at">
            Send at
          </label>
          <input
            id="cam-schedule-at"
            type="datetime-local"
            className="input"
            value={scheduleAt}
            onChange={(e) => setScheduleAt(e.target.value)}
            disabled={scheduleLocked || pstoOn}
            aria-describedby={availabilityDescription}
          />
        </div>

        <div
          className="field"
          style={{
            border: "1px solid var(--pw-border)",
            borderRadius: 6,
            padding: 10,
            marginTop: 8,
          }}
        >
          <label
            style={{
              display: "flex",
              gap: 8,
              alignItems: "center",
              cursor: "pointer",
            }}
          >
            <input
              type="checkbox"
              checked={pstoOn}
              onChange={(e) => setPstoOn(e.target.checked)}
              disabled={scheduleLocked}
              aria-describedby={availabilityDescription}
            />
            <span style={{ fontWeight: 500 }}>
              Personalize send time within a window
            </span>
          </label>
          <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
            Each recipient receives the email at their personal best-engagement
            hour inside the window (max 30 days).
          </div>
          {pstoOn ? (
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                gap: 8,
                marginTop: 8,
              }}
            >
              <div>
                <label
                  className="field-label"
                  htmlFor="cam-psto-start"
                  style={{ fontSize: 11 }}
                >
                  Window start
                </label>
                <input
                  id="cam-psto-start"
                  type="datetime-local"
                  className="input"
                  value={pstoWindowStart}
                  onChange={(e) => setPstoWindowStart(e.target.value)}
                  disabled={scheduleLocked}
                  aria-describedby={availabilityDescription}
                />
              </div>
              <div>
                <label
                  className="field-label"
                  htmlFor="cam-psto-end"
                  style={{ fontSize: 11 }}
                >
                  Window end
                </label>
                <input
                  id="cam-psto-end"
                  type="datetime-local"
                  className="input"
                  value={pstoWindowEnd}
                  onChange={(e) => setPstoWindowEnd(e.target.value)}
                  disabled={scheduleLocked}
                  aria-describedby={availabilityDescription}
                />
              </div>
            </div>
          ) : null}
        </div>
        <ModalFooter>
          <button
            type="button"
            className="btn"
            onClick={() => setScheduleOpen(false)}
            disabled={busy || pstoSaving}
          >
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => {
              if (CAMPAIGN_SCHEDULING_AVAILABLE) void schedule();
            }}
            disabled={
              scheduleLocked ||
              (pstoOn ? !pstoWindowStart || !pstoWindowEnd : !scheduleAt)
            }
            aria-describedby={availabilityDescription}
          >
            {!CAMPAIGN_SCHEDULING_AVAILABLE
              ? "Scheduling unavailable"
              : scheduleLocked
                ? "Scheduling…"
                : "Schedule"}
          </button>
          {/* keep the explicit reference live so the linter doesn't
              strip the toggle wiring above on a future formatter pass */}
          {pstoOn && pstoWindowStart && pstoWindowEnd ? null : null}
        </ModalFooter>
      </Modal>
      <ConfirmModal
        open={scheduleDiscardConfirmOpen}
        title="Discard this schedule?"
        description="The selected send time and personalized delivery window have not been scheduled."
        confirmLabel="Discard schedule"
        danger
        onConfirm={discardScheduleDraft}
        onClose={keepScheduleDraft}
      />
    </>
  );
}

export function CampaignSaveTemplateModal({
  tplModalOpen,
  setTplModalOpen,
  tplSaving,
  tplName,
  setTplName,
  tplSlug,
  setTplSlug,
  tplErr,
  setTplErr,
  commitSaveAsTemplate,
  canMutate,
  canAdmin,
  authoringLocked,
}: {
  tplModalOpen: boolean;
  setTplModalOpen: Dispatch<SetStateAction<boolean>>;
  tplSaving: boolean;
  tplName: string;
  setTplName: Dispatch<SetStateAction<string>>;
  tplSlug: string;
  setTplSlug: Dispatch<SetStateAction<string>>;
  tplErr: string | null;
  setTplErr: Dispatch<SetStateAction<string | null>>;
  commitSaveAsTemplate: () => Promise<void>;
  canMutate: boolean;
  canAdmin: boolean;
  authoringLocked: boolean;
}): ReactElement {
  const authorityReason = !canMutate
    ? "Your current role cannot change campaigns."
    : !canAdmin
      ? "Saving campaigns as templates requires the admin role."
      : authoringLocked
        ? "Save or cancel the open campaign editor before templating the persisted version."
        : null;
  const authorityReasonId = useId();
  return (
    <Modal
      open={tplModalOpen}
      onClose={() => (tplSaving ? undefined : setTplModalOpen(false))}
      title="Save as template"
      description="Reuse this campaign's body, subject, and preview text as a starting point for future sends."
    >
      {authorityReason ? (
        <div
          id={authorityReasonId}
          className="notice"
          role="status"
          style={{ marginBottom: 12 }}
        >
          {authorityReason} Your template name and slug are kept for review, but
          saving is locked.
        </div>
      ) : null}
      <div className="field">
        <label className="field-label" htmlFor="cam-tpl-name">
          Template name
        </label>
        <input
          id="cam-tpl-name"
          type="text"
          className="input"
          value={tplName}
          onChange={(e) => {
            if (authorityReason) return;
            setTplName(e.target.value);
            if (tplErr) setTplErr(null);
          }}
          placeholder="Q3 newsletter template"
          autoComplete="off"
          readOnly={authorityReason != null}
          aria-describedby={authorityReason ? authorityReasonId : undefined}
        />
      </div>
      <div className="field">
        <label className="field-label" htmlFor="cam-tpl-slug">
          Slug
        </label>
        <input
          id="cam-tpl-slug"
          type="text"
          className="input mono"
          value={tplSlug}
          onChange={(e) => {
            if (authorityReason) return;
            setTplSlug(e.target.value);
            if (tplErr) setTplErr(null);
          }}
          placeholder="q3-newsletter"
          autoComplete="off"
          readOnly={authorityReason != null}
          aria-describedby={authorityReason ? authorityReasonId : undefined}
        />
        <div className="field-help">
          Lowercase letters, digits, dashes. Appears in template URLs and
          references.
        </div>
      </div>
      {tplErr ? <div className="field-error">{tplErr}</div> : null}
      <ModalFooter>
        <button
          type="button"
          className="btn"
          onClick={() => setTplModalOpen(false)}
          disabled={tplSaving}
        >
          Cancel
        </button>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => {
            if (authorityReason) return;
            void commitSaveAsTemplate();
          }}
          disabled={tplSaving || authorityReason != null}
          aria-describedby={authorityReason ? authorityReasonId : undefined}
        >
          {tplSaving ? "Saving…" : "Save template"}
        </button>
      </ModalFooter>
    </Modal>
  );
}

/**
 * G2: small two-button segmented toggle for Raw vs Human (MPP-stripped)
 * engagement counts. Keyboard-accessible via `aria-pressed`; ←/→ swap
 * the active option. Visually matches the small pill chrome the rest
 * of the slideover uses for inline toggles.
 */
export function EngagementModeToggle({
  value,
  onChange,
}: {
  value: "raw" | "human";
  onChange: (next: "raw" | "human") => void;
}): ReactElement {
  const descriptionIdPrefix = useId();
  const opts: { id: "raw" | "human"; label: string; hint: string }[] = [
    { id: "raw", label: "Raw", hint: "All opens + clicks, no bot filtering" },
    {
      id: "human",
      label: "Human",
      hint: "Excludes Apple MPP, Google Image Proxy, and link-scanner traffic",
    },
  ];
  return (
    <div
      role="group"
      aria-label="Engagement mode"
      style={{
        display: "inline-flex",
        gap: 0,
        padding: 2,
        border: "1px solid var(--pw-border)",
        borderRadius: 999,
        background: "var(--pw-bg-elev)",
        fontSize: 11,
      }}
    >
      {opts.map((o) => {
        const active = value === o.id;
        return (
          <button
            key={o.id}
            type="button"
            aria-pressed={active}
            aria-describedby={`${descriptionIdPrefix}-${o.id}`}
            onClick={() => onChange(o.id)}
            onKeyDown={(e) => {
              if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
                e.preventDefault();
                onChange(value === "raw" ? "human" : "raw");
              }
            }}
            style={{
              padding: "2px 10px",
              border: "none",
              background: active ? "var(--pw-fg)" : "transparent",
              color: active ? "var(--pw-bg)" : "var(--pw-fg-muted)",
              borderRadius: 999,
              cursor: "pointer",
              fontWeight: active ? 600 : 400,
              fontSize: 11,
            }}
          >
            {o.label}
            <span
              id={`${descriptionIdPrefix}-${o.id}`}
              className="visually-hidden"
            >
              {o.hint}
            </span>
          </button>
        );
      })}
    </div>
  );
}
