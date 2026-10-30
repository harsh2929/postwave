import { type ReactElement } from "react";

import { fmtRelative } from "../lib/format-date";

import {
  CampaignSaveTemplateModal,
  CampaignScheduleModal,
  CampaignSendConfirmationModal,
} from "./CampaignDetailActionModals";
import { CampaignActivityFeed } from "./CampaignActivityFeed";
import { CampaignAssurancePanel } from "./CampaignAssurancePanel";
import {
  HoldoutLiftPanel,
  VanityPathsPanel,
} from "./campaigns/CampaignMeasurementPanels";
import { CampaignPollReceiptsPanel } from "./campaigns/CampaignPollReceiptsPanel";
import { CampaignDetailEditor } from "./CampaignDetailEditor";
import { CampaignDetailHeader } from "./CampaignDetailHeader";
import {
  type CampaignEngagementMode,
  CampaignPerformancePanel,
  CampaignPostSendSummary,
  CampaignWebVersionCard,
} from "./CampaignDetailPanels";
import { CampaignFeedback } from "./CampaignFeedback";
import { CampaignRepliesSection } from "./CampaignRepliesSection";
import { CampaignTranslationsPanel } from "./campaigns/CampaignTranslationsPanel";
import { DraftCheckpointBanner } from "./campaigns/DraftCheckpointBanner";
import { type CampaignCheckpointContent } from "./campaigns/campaign-checkpoint-content";
import { type EditorCheckpointState } from "../lib/use-editor-checkpoint";
import {
  asCampaignString,
  type CampaignDetailData,
} from "./campaigns/useCampaignDetailData";
import { type CampaignEditorController } from "./campaigns/useCampaignEditorController";
import { type CampaignLifecycleController } from "./campaigns/useCampaignLifecycleController";
import { type CampaignScheduleController } from "./campaigns/useCampaignScheduleController";
import { ConfirmModal } from "./ConfirmModal";
import { ContentOptimizerCard } from "./composer/ContentOptimizerCard";
import { ContentRemixCard } from "./composer/ContentRemixCard";
import { CopilotRail } from "./composer/CopilotRail";
import { HoldoutCard } from "./composer/HoldoutCard";
import { TranslationsPanel } from "./composer/TranslationsPanel";
import { UTMTemplatesPanel } from "./composer/UTMTemplatesPanel";
import { DynamicContentPanel } from "./DynamicContentPanel";
import { Modal, ModalFooter } from "./Modal";
import { PendingSyncStatus } from "./PendingSyncStatus";
import { SendChecklist } from "./SendChecklist";
import {
  campaignHasAuthoritativeSemanticPoll,
  campaignStatusAllowsPollMaterialization,
} from "../lib/campaign-polls";

interface CampaignDetailPresentationProps {
  data: CampaignDetailData;
  editor: CampaignEditorController;
  checkpoint: EditorCheckpointState<CampaignCheckpointContent>;
  lifecycle: CampaignLifecycleController;
  schedule: CampaignScheduleController;
  busy: boolean;
  canMutate: boolean;
  canAdmin: boolean;
  engagementMode: CampaignEngagementMode;
  onEngagementModeChange: (mode: CampaignEngagementMode) => void;
  onClose: () => void;
  onCancelEdit: () => void;
  closeDisabled: boolean;
}

export function CampaignDetailPresentation({
  data,
  editor,
  checkpoint,
  lifecycle,
  schedule,
  busy,
  canMutate,
  canAdmin,
  engagementMode,
  onEngagementModeChange,
  onClose,
  onCancelEdit,
  closeDisabled,
}: CampaignDetailPresentationProps): ReactElement {
  const {
    id,
    detail,
    savedFromEmail,
    loading,
    report,
    reportErr,
    detailErr,
    archiveBase,
    archiveSettingsLoaded,
    status,
    isDraft,
    canPauseSend,
    canResumeSend,
    canCancelSend,
    hasReport,
    liveStatus,
  } = data;
  const {
    editing,
    draft,
    setDraft,
    saving,
    saveErr,
    bodyTab,
    setBodyTab,
    editorMode,
    setEditorMode,
    blockInstances,
    setBlockInstances,
    setLastComposedMjml,
    setConfirmModeSwitch,
    editorWrapRef,
    openEdit,
    saveEdit,
    pickSubjectFromLab,
    runSubjectBandit,
  } = editor;
  const editorMutationAllowed =
    canMutate && !saving && !editor.freezingAudience;
  const persistedMutationAllowed = editorMutationAllowed && !editing;
  const pollMaterializationStatusAllowed =
    campaignStatusAllowsPollMaterialization(status);

  return (
    <>
      <div className="slideover-overlay" onClick={onClose} aria-hidden="true" />
      <div
        className="slideover"
        role="dialog"
        aria-modal="true"
        aria-labelledby="campaign-slideover-title"
        style={{ width: 460 }}
      >
        <button
          type="button"
          className="slideover-close"
          onClick={onClose}
          disabled={closeDisabled}
          aria-label="Close"
        >
          ×
        </button>

        <CampaignDetailHeader
          detail={detail}
          isDraft={isDraft}
          canPauseSend={canPauseSend}
          canResumeSend={canResumeSend}
          canCancelSend={canCancelSend}
          busy={busy}
          canMutate={canMutate}
          canAdmin={canAdmin}
          authoringLocked={
            editor.editing || editor.saving || editor.freezingAudience
          }
          detailErr={detailErr}
          scheduleAt={schedule.scheduleAt}
          onScheduleAtChange={schedule.setScheduleAt}
          onEdit={openEdit}
          onOpenSchedule={() => schedule.setScheduleOpen(true)}
          onOpenSend={() => lifecycle.setConfirmSendOpen(true)}
          onRunControl={lifecycle.runControl}
          onDuplicate={lifecycle.duplicate}
          onSaveAsTemplate={lifecycle.openSaveAsTemplate}
          onTranslate={() => editor.setTranslateOpen(true)}
          onUtm={() => editor.setUtmOpen(true)}
          onOpenCancel={() => lifecycle.setConfirmCancelOpen(true)}
          onOpenDelete={() => lifecycle.setConfirmDeleteOpen(true)}
        />
        {id == null ? null : (
          <PendingSyncStatus
            path={`/api/v1/campaigns/${encodeURIComponent(String(id))}`}
            compact
          />
        )}
        {/* ECO-03. Rendered OUTSIDE the `editing` gate on purpose: the whole
            point is that you arrive on this device with the editor closed and
            are told a draft is waiting. Resuming opens the editor. */}
        <DraftCheckpointBanner
          state={checkpoint}
          canEdit={canMutate && isDraft}
          busy={saving || editor.freezingAudience}
        />
        {isDraft && editing ? (
          <p className="muted" data-testid="checkpoint-status" role="status">
            {checkpoint.saving
              ? "Checkpointing this draft…"
              : checkpoint.lastSavedAt
                ? `Draft checkpointed ${fmtRelative(checkpoint.lastSavedAt)} — it will be here on your other devices.`
                : "Unsaved changes are checkpointed to your account a couple of seconds after you stop typing."}
          </p>
        ) : null}
        {isDraft && editing ? (
          <CampaignDetailEditor
            id={id}
            draft={draft}
            setDraft={setDraft}
            savedFromEmail={savedFromEmail}
            editorMode={editorMode}
            setEditorMode={setEditorMode}
            blockInstances={blockInstances}
            setBlockInstances={setBlockInstances}
            setLastComposedMjml={setLastComposedMjml}
            setConfirmModeSwitch={setConfirmModeSwitch}
            bodyTab={bodyTab}
            setBodyTab={setBodyTab}
            editorWrapRef={editorWrapRef}
            saving={saving}
            freezingAudience={editor.freezingAudience}
            saveErr={saveErr}
            canMutate={canMutate}
            onCancel={onCancelEdit}
            onSave={saveEdit}
            onFreezeAudience={editor.freezeAudience}
          />
        ) : null}
        <CampaignPerformancePanel
          loading={loading}
          isDraft={isDraft}
          hasReport={hasReport}
          liveStatus={liveStatus}
          report={report}
          reportErr={reportErr}
          engagementMode={engagementMode}
          onEngagementModeChange={onEngagementModeChange}
        />

        {isDraft && id != null ? (
          <SendChecklist
            campaignID={id}
            body={asCampaignString(detail.body_html ?? detail.plain_text ?? "")}
            subject={detail.subject ?? ""}
            scheduledAt={detail.scheduled_at ?? null}
            canMutate={persistedMutationAllowed}
          />
        ) : null}
        {id != null ? (
          <CampaignAssurancePanel
            campaignId={id}
            canAdmin={canAdmin}
            canEdit={canMutate}
            canApply={persistedMutationAllowed}
            campaignETag={data.campaignETag}
            onCampaignChanged={data.refreshDetail}
          />
        ) : null}
        {id != null ? (
          <>
            {/* Both self-gate: neither renders when the campaign has no
                holdout and no published address, so a campaign that uses
                neither is not told about features it did not ask for. */}
            <HoldoutLiftPanel campaignId={String(id)} />
            <VanityPathsPanel campaignId={String(id)} />
            <CampaignPollReceiptsPanel
              campaignId={String(id)}
              hasSemanticPoll={campaignHasAuthoritativeSemanticPoll(
                detail.source_mode,
                detail.content_schema_version,
                detail.content_blocks,
              )}
              canConfigure={
                pollMaterializationStatusAllowed && persistedMutationAllowed
              }
              configurationBlockedReason={
                editing || saving || editor.freezingAudience
                  ? "Save and close the campaign editor first. Revision freeze reads persisted semantic content, so desktop will not materialize local draft poll keys."
                  : !pollMaterializationStatusAllowed
                    ? "Poll contracts can be materialized only while the campaign is draft, scheduled, paused, or failed. Existing immutable receipts remain available above."
                    : !canMutate
                      ? "An editor, admin, or owner must freeze and materialize semantic poll contracts."
                      : undefined
              }
            />
          </>
        ) : null}
        {isDraft && id != null ? (
          <CopilotRail
            campaignId={String(id)}
            subject={detail.subject ?? ""}
            fromEmail={savedFromEmail}
            bodyHtml={asCampaignString(
              detail.body_html ?? detail.plain_text ?? "",
            )}
            canMutate={editorMutationAllowed}
            busy={busy}
            onPickSubject={(text) => void pickSubjectFromLab(text)}
            onRunBandit={(top3) => void runSubjectBandit(top3)}
            onRequestSend={() => lifecycle.setConfirmSendOpen(true)}
          />
        ) : null}
        {id != null ? (
          <HoldoutCard
            campaignId={id}
            isDraft={isDraft}
            canMutate={persistedMutationAllowed}
            canAdmin={canAdmin}
          />
        ) : null}
        {id != null ? (
          <ContentOptimizerCard
            campaignId={id}
            canMutate={persistedMutationAllowed}
          />
        ) : null}
        {id != null ? (
          <ContentRemixCard
            campaignId={id}
            canMutate={persistedMutationAllowed}
          />
        ) : null}
        {id != null ? (
          <DynamicContentPanel
            campaignID={id}
            body={
              editing
                ? draft.body
                : asCampaignString(detail.body_html ?? detail.plain_text ?? "")
            }
            savedBody={asCampaignString(
              detail.body_html ?? detail.plain_text ?? "",
            )}
            onInsertSkeleton={
              editing && canMutate && !saving && !editor.freezingAudience
                ? (next) => setDraft((current) => ({ ...current, body: next }))
                : undefined
            }
          />
        ) : null}
        {detail.archive_public && detail.archive_slug ? (
          <CampaignWebVersionCard
            archiveBase={archiveBase}
            archiveSettingsLoaded={archiveSettingsLoaded}
            archiveSlug={detail.archive_slug}
          />
        ) : null}
        {id != null ? (
          <CampaignPostSendSummary
            campaignId={id}
            detail={detail}
            status={status}
            canMutate={canMutate}
          />
        ) : null}
        {id != null ? (
          <CampaignFeedback campaignID={id} canMutate={canMutate} />
        ) : null}
        {id != null ? (
          <CampaignRepliesSection
            campaignId={id}
            canAdmin={canAdmin}
            canMutate={canMutate}
          />
        ) : null}
        {id != null ? (
          <CampaignTranslationsPanel campaignId={id} canMutate={canMutate} />
        ) : null}
        {id != null ? <CampaignActivityFeed campaignId={id} /> : null}
      </div>

      <CampaignDetailOverlayStack
        data={data}
        editor={editor}
        lifecycle={lifecycle}
        schedule={schedule}
        busy={busy}
        canMutate={canMutate}
        canAdmin={canAdmin}
      />
    </>
  );
}

interface CampaignDetailOverlayStackProps {
  data: CampaignDetailData;
  editor: CampaignEditorController;
  lifecycle: CampaignLifecycleController;
  schedule: CampaignScheduleController;
  busy: boolean;
  canMutate: boolean;
  canAdmin: boolean;
}

function CampaignDetailOverlayStack({
  data,
  editor,
  lifecycle,
  schedule,
  busy,
  canMutate,
  canAdmin,
}: CampaignDetailOverlayStackProps): ReactElement {
  const { id, detail, detailErr } = data;
  const { editing, draft, setDraft, saving } = editor;

  return (
    <>
      <CampaignSendConfirmationModal
        confirmSendOpen={lifecycle.confirmSendOpen}
        setConfirmSendOpen={lifecycle.setConfirmSendOpen}
        detail={detail}
        id={id}
        checklistEvidence={lifecycle.checklistEvidence}
        retryChecklist={lifecycle.retryChecklist}
        audiencePreviewEvidence={lifecycle.audiencePreviewEvidence}
        setAudiencePreviewEvidence={lifecycle.setAudiencePreviewEvidence}
        checklistFailureOverride={lifecycle.checklistFailureOverride}
        setChecklistFailureOverride={lifecycle.setChecklistFailureOverride}
        busy={busy}
        canMutate={canMutate}
        authoringLocked={
          editor.editing || editor.saving || editor.freezingAudience
        }
        detailErr={detailErr}
        send={lifecycle.send}
      />
      <CampaignScheduleModal
        scheduleOpen={schedule.scheduleOpen}
        setScheduleOpen={schedule.setScheduleOpen}
        detail={detail}
        id={id}
        setScheduleAt={schedule.setScheduleAt}
        scheduleAt={schedule.scheduleAt}
        pstoOn={schedule.pstoOn}
        setPstoOn={schedule.setPstoOn}
        pstoWindowStart={schedule.pstoWindowStart}
        setPstoWindowStart={schedule.setPstoWindowStart}
        pstoWindowEnd={schedule.pstoWindowEnd}
        setPstoWindowEnd={schedule.setPstoWindowEnd}
        busy={busy}
        pstoSaving={schedule.pstoSaving}
        scheduleDiscardConfirmOpen={schedule.scheduleDiscardConfirmOpen}
        keepScheduleDraft={schedule.keepScheduleDraft}
        discardScheduleDraft={schedule.discardScheduleDraft}
        schedule={schedule.schedule}
      />
      <CampaignSaveTemplateModal
        tplModalOpen={lifecycle.tplModalOpen}
        setTplModalOpen={lifecycle.setTplModalOpen}
        tplSaving={lifecycle.tplSaving}
        tplName={lifecycle.tplName}
        setTplName={lifecycle.setTplName}
        tplSlug={lifecycle.tplSlug}
        setTplSlug={lifecycle.setTplSlug}
        tplErr={lifecycle.tplErr}
        setTplErr={lifecycle.setTplErr}
        commitSaveAsTemplate={lifecycle.commitSaveAsTemplate}
        canMutate={canMutate}
        canAdmin={canAdmin}
        authoringLocked={
          editor.editing || editor.saving || editor.freezingAudience
        }
      />
      <ConfirmModal
        open={editor.confirmModeSwitch}
        title="Switch to HTML editing?"
        description={
          editor.lastComposedMjml
            ? "The body keeps the last composed output from your blocks. Edits you make as HTML won't flow back into the block structure — re-applying blocks later overwrites them."
            : "Edits you make as HTML won't flow back into the block structure — re-applying blocks later overwrites them."
        }
        confirmLabel="Switch to HTML"
        confirmDisabled={!canMutate || saving || editor.freezingAudience}
        onConfirm={() => {
          if (!canMutate || saving || editor.freezingAudience) return;
          if (editor.lastComposedMjml) {
            setDraft((current) => ({
              ...current,
              body: editor.lastComposedMjml,
            }));
          }
          editor.setEditorMode("html");
          editor.setConfirmModeSwitch(false);
        }}
        onClose={() => editor.setConfirmModeSwitch(false)}
      >
        {!canMutate ? (
          <div className="notice" role="status">
            Your role changed. Keep or cancel the local block draft; switching
            editor modes is unavailable.
          </div>
        ) : null}
      </ConfirmModal>
      <TranslationsPanel
        open={editor.translateOpen}
        onClose={() => editor.setTranslateOpen(false)}
        body={
          editing
            ? draft.body
            : asCampaignString(detail.body_html ?? detail.plain_text ?? "")
        }
        canMutate={canMutate && !saving && !editor.freezingAudience}
        canAdmin={canAdmin}
        onApplyTranslation={
          editing && canMutate && !saving && !editor.freezingAudience
            ? (translated) =>
                setDraft((current) => ({ ...current, body: translated }))
            : undefined
        }
      />
      {id != null ? (
        <UTMTemplatesPanel
          open={editor.utmOpen}
          onClose={() => editor.setUtmOpen(false)}
          campaignId={id}
          canMutate={canMutate && !saving && !editor.freezingAudience}
          canAdmin={canAdmin}
        />
      ) : null}
      <Modal
        open={lifecycle.confirmCancelOpen}
        onClose={() => lifecycle.setConfirmCancelOpen(false)}
        title="Cancel this send?"
        description={`This stops all remaining messages for "${
          detail.name ?? "this campaign"
        }". Messages already delivered can't be recalled, and the send can't be resumed once cancelled.`}
      >
        <ModalFooter>
          <button
            type="button"
            className="btn"
            onClick={() => lifecycle.setConfirmCancelOpen(false)}
            disabled={busy}
          >
            Keep sending
          </button>
          <button
            type="button"
            className="btn btn-danger"
            onClick={() => void lifecycle.runControl("cancel")}
            disabled={busy || !canMutate}
            aria-describedby={
              !canMutate ? "campaign-cancel-role-reason" : undefined
            }
          >
            {busy ? "Cancelling…" : "Cancel send"}
          </button>
        </ModalFooter>
        {!canMutate ? (
          <p id="campaign-cancel-role-reason" className="muted" role="status">
            Your current role cannot control campaign sends.
          </p>
        ) : null}
      </Modal>
      <Modal
        open={lifecycle.confirmDeleteOpen}
        onClose={() => lifecycle.setConfirmDeleteOpen(false)}
        title="Delete campaign?"
        description={`This will permanently delete "${
          detail.name ?? "this campaign"
        }". This cannot be undone.`}
      >
        <ModalFooter>
          <button
            type="button"
            className="btn"
            onClick={() => lifecycle.setConfirmDeleteOpen(false)}
            disabled={busy}
          >
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-danger"
            onClick={() => void lifecycle.remove()}
            disabled={
              busy ||
              !canMutate ||
              editor.editing ||
              editor.saving ||
              editor.freezingAudience
            }
            aria-describedby={
              !canMutate ||
              editor.editing ||
              editor.saving ||
              editor.freezingAudience
                ? "campaign-delete-role-reason"
                : undefined
            }
          >
            {busy ? "Deleting…" : "Delete campaign"}
          </button>
        </ModalFooter>
        {!canMutate ||
        editor.editing ||
        editor.saving ||
        editor.freezingAudience ? (
          <p id="campaign-delete-role-reason" className="muted" role="status">
            {!canMutate
              ? "Your current role cannot delete campaigns."
              : "Save or cancel the open editor before deleting the persisted campaign."}
          </p>
        ) : null}
      </Modal>
    </>
  );
}
