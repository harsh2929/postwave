/**
 * CampaignDetailSlideover — right-side slide-over with the full
 * campaign detail: header + actions, draft editor (when status=draft),
 * and a performance panel sourced from `/api/v1/campaigns/{id}/report`.
 */
import {
  type ReactElement,
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { type Campaign, type CampaignDetail } from "../lib/api-client";
import {
  campaignHasAuthoritativeSemanticPoll,
  ensureCurrentCampaignPollsReady,
} from "../lib/campaign-polls";
import { useSlideoverBehavior } from "../hooks/useSlideoverBehavior";
import { useCanAdmin, useCanWrite } from "../lib/store";
import { useEditorCheckpoint } from "../lib/use-editor-checkpoint";
import { type CampaignEngagementMode } from "./CampaignDetailPanels";
import { CampaignDetailPresentation } from "./CampaignDetailPresentation";
import { ConfirmModal } from "./ConfirmModal";
import {
  type CampaignCheckpointContent,
  campaignCheckpointContent,
  campaignDraftFromCheckpoint,
} from "./campaigns/campaign-checkpoint-content";
import { useCampaignDetailData } from "./campaigns/useCampaignDetailData";
import {
  draftFromDetail,
  useCampaignEditorController,
} from "./campaigns/useCampaignEditorController";
import { useCampaignLifecycleController } from "./campaigns/useCampaignLifecycleController";
import { useCampaignScheduleController } from "./campaigns/useCampaignScheduleController";

interface Props {
  campaign: Campaign;
  onClose: () => void;
  onChange?: (updated: CampaignDetail | null) => void;
  returnFocusRef?: RefObject<HTMLElement | null>;
}

/* ------- component ------------------------------------------------ */

export function CampaignDetailSlideover({
  campaign,
  onClose,
  onChange,
  returnFocusRef,
}: Props): ReactElement {
  const layerRef = useRef<HTMLDivElement | null>(null);
  const lastDetailFocusRef = useRef<HTMLElement | null>(null);
  const canMutate = useCanWrite();
  const canAdmin = useCanAdmin();
  const data = useCampaignDetailData(campaign);
  const editor = useCampaignEditorController({
    id: data.id,
    detail: data.detail,
    setDetail: data.setDetail,
    savedFromEmail: data.savedFromEmail,
    canMutate,
    onChange,
  });
  // --- ECO-03: durable draft checkpoint -----------------------------------
  // `registerLifecycleGuard` inside the editor controller asks before you
  // leave and remembers nothing once you have. This is the half that survives
  // the window closing, and it is deliberately in the SAME vocabulary web
  // writes (the campaign PATCH body) — one row per person per campaign is
  // shared by every client that person signs into, so a private desktop shape
  // would make the two surfaces overwrite each other with drafts neither can
  // read. See campaigns/campaign-checkpoint-content.
  const checkpointContent = useMemo<CampaignCheckpointContent | null>(
    () =>
      editor.draftDirty
        ? campaignCheckpointContent(
            editor.draft,
            data.detail,
            editor.editorMode,
          )
        : null,
    [data.detail, editor.draft, editor.draftDirty, editor.editorMode],
  );
  // What the SAVED record would checkpoint. A stored draft equal to this holds
  // nothing unsaved, so it is neither written nor offered.
  const recordCheckpointContent = useMemo<CampaignCheckpointContent>(
    () =>
      campaignCheckpointContent(
        draftFromDetail(data.detail, data.savedFromEmail),
        data.detail,
        "html",
      ),
    [data.detail, data.savedFromEmail],
  );
  const inspectCheckpointContent = useCallback(
    (content: CampaignCheckpointContent) => {
      const restored = campaignDraftFromCheckpoint(content, data.detail);
      return restored.status === "ready"
        ? ({ resumable: true } as const)
        : ({ resumable: false, reason: restored.reason } as const);
    },
    [data.detail],
  );
  const restoreCheckpoint = useCallback(
    (content: CampaignCheckpointContent) => {
      const restored = campaignDraftFromCheckpoint(content, data.detail);
      if (restored.status !== "ready") return;
      // Restoring is not saving. The draft lands in the editor, opened for
      // editing, and the person still decides whether it becomes the record.
      if (!editor.editing) editor.openEdit();
      editor.setDraft(restored.draft);
    },
    [data.detail, editor],
  );
  const checkpoint = useEditorCheckpoint<CampaignCheckpointContent>({
    entityKey: "campaign",
    entityId: data.id == null ? undefined : String(data.id),
    content: checkpointContent,
    recordContent: recordCheckpointContent,
    // The SAVED record's timestamp, not the local draft's — a checkpoint is
    // only worth offering when it holds work the record does not.
    recordUpdatedAt: data.detail.updated_at,
    canEdit: canMutate && data.isDraft,
    onRestore: restoreCheckpoint,
    inspectContent: inspectCheckpointContent,
  });

  const [pendingExit, setPendingExit] = useState<"close" | "cancel" | null>(
    null,
  );
  const editorOperationActive = Boolean(
    editor.saving || editor.freezingAudience,
  );
  const requestClose = (): void => {
    if (editorOperationActive) return;
    if (editor.draftDirty) {
      setPendingExit("close");
      return;
    }
    onClose();
  };
  const requestCancelEdit = (): void => {
    if (editorOperationActive) return;
    if (editor.draftDirty) {
      setPendingExit("cancel");
      return;
    }
    editor.discardEdit();
  };
  const discardAndContinue = (): void => {
    const exit = pendingExit;
    setPendingExit(null);
    editor.discardEdit();
    if (exit === "close") onClose();
  };
  useSlideoverBehavior({
    open: true,
    onClose: requestClose,
    isolationRef: layerRef,
    returnFocusRef,
    disableEscape: editorOperationActive,
  });
  useEffect(() => {
    setPendingExit(null);
    lastDetailFocusRef.current = null;
  }, [data.id]);

  const [engagementMode, setEngagementMode] = useState<CampaignEngagementMode>(
    () => {
      try {
        const value = window.localStorage.getItem(
          "postwave.campaignReport.engagementMode",
        );
        return value === "raw" ? "raw" : "human";
      } catch {
        return "human";
      }
    },
  );
  useEffect(() => {
    try {
      window.localStorage.setItem(
        "postwave.campaignReport.engagementMode",
        engagementMode,
      );
    } catch {
      // Storage is best-effort; reporting remains usable without it.
    }
  }, [engagementMode]);

  const [busy, setBusy] = useState(false);
  const verifySemanticPollContracts = useCallback(async (): Promise<void> => {
    if (
      data.id == null ||
      !campaignHasAuthoritativeSemanticPoll(
        data.detail.source_mode,
        data.detail.content_schema_version,
        data.detail.content_blocks,
      )
    ) {
      return;
    }
    const result = await ensureCurrentCampaignPollsReady(String(data.id));
    if (result.error) {
      throw new Error(
        `Exact semantic poll contracts could not be verified, so this campaign was not queued or scheduled. ${result.error.message}`,
      );
    }
  }, [
    data.detail.content_blocks,
    data.detail.content_schema_version,
    data.detail.source_mode,
    data.id,
  ]);
  const lifecycle = useCampaignLifecycleController({
    id: data.id,
    detail: data.detail,
    setDetail: data.setDetail,
    savedFromEmail: data.savedFromEmail,
    isDraft: data.isDraft,
    canMutate,
    canAdmin,
    authoringLocked: editor.editing || editor.saving || editor.freezingAudience,
    setBusy,
    onChange,
    onClose: requestClose,
    beforeSend: verifySemanticPollContracts,
  });
  const schedule = useCampaignScheduleController({
    id: data.id,
    detail: data.detail,
    setDetail: data.setDetail,
    setBusy,
    onChange,
    beforeSchedule: verifySemanticPollContracts,
  });
  return (
    <div
      ref={layerRef}
      className="campaign-detail-layer"
      onFocusCapture={(event) => {
        const target = event.target;
        if (
          target instanceof HTMLElement &&
          target.closest(".slideover") != null
        ) {
          lastDetailFocusRef.current = target;
        }
      }}
    >
      <CampaignDetailPresentation
        data={data}
        editor={editor}
        checkpoint={checkpoint}
        lifecycle={lifecycle}
        schedule={schedule}
        busy={busy}
        canMutate={canMutate}
        canAdmin={canAdmin}
        engagementMode={engagementMode}
        onEngagementModeChange={setEngagementMode}
        onClose={requestClose}
        onCancelEdit={requestCancelEdit}
        closeDisabled={editorOperationActive}
      />
      <ConfirmModal
        open={pendingExit !== null}
        title={
          pendingExit === "close"
            ? "Discard changes and close?"
            : "Discard campaign changes?"
        }
        description="The unsaved subject, sender, body, goal, or audience changes will be lost."
        confirmLabel="Discard changes"
        cancelLabel="Keep editing"
        danger
        returnFocusRef={lastDetailFocusRef}
        onConfirm={discardAndContinue}
        onClose={() => setPendingExit(null)}
      />
    </div>
  );
}
