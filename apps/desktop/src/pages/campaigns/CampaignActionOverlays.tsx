import {
  lazy,
  Suspense,
  type ReactElement,
  useLayoutEffect,
  useRef,
} from "react";

import { CampaignABResultsModal } from "../../components/campaigns/CampaignABResultsModal";
import { ConfirmModal } from "../../components/ConfirmModal";
import { FormField } from "../../components/FormField";
import { LazySlideoverFallback } from "../../components/LazySlideoverFallback";
import { Modal, ModalFooter } from "../../components/Modal";
import { MIN_RESEND_HOURS } from "../campaigns-row-actions";
import { abResultsModalKey } from "./campaigns-page-utils";
import type { CampaignsControllerProps } from "./campaigns-page-types";

const CampaignDetailSlideover = lazy(() =>
  import("../../components/CampaignDetailSlideover").then((module) => ({
    default: module.CampaignDetailSlideover,
  })),
);

function CampaignResendModal({
  controller,
}: CampaignsControllerProps): ReactElement {
  const { state } = controller;
  return (
    <ConfirmModal
      key={
        state.resendTarget
          ? `resend-${String(state.resendTarget.id)}`
          : "resend"
      }
      open={
        controller.canAdminMutateCampaignSnapshot && state.resendTarget != null
      }
      title={`Resend "${
        state.resendTarget?.name ?? state.resendTarget?.subject ?? "campaign"
      }" to non-openers?`}
      description="Creates a new campaign that targets only the recipients who haven't opened the original."
      confirmLabel="Create resend"
      busy={state.resendBusy}
      confirmDisabled={!controller.canAdminMutateCampaignSnapshot}
      onConfirm={() => void controller.rowActions.submitResend()}
      onClose={() => state.setResendTarget(null)}
    >
      <p style={{ fontSize: 13, marginTop: 0 }}>
        The resend is created as its own campaign so you can review it before it
        goes out. It sends no earlier than {MIN_RESEND_HOURS}h after the
        original, and needs a fresh subject line (the server rejects an
        identical one).
      </p>
      <FormField
        label="New subject line"
        required
        htmlFor="resend-subject"
        error={state.resendErr ?? undefined}
      >
        <input
          id="resend-subject"
          type="text"
          className="input"
          value={state.resendSubject}
          onChange={(event) => {
            state.setResendSubject(event.target.value);
            if (state.resendErr) state.setResendErr(null);
          }}
        />
      </FormField>
    </ConfirmModal>
  );
}

function CampaignBulkDeleteModal({
  controller,
}: CampaignsControllerProps): ReactElement {
  const { state } = controller;
  return (
    <ConfirmModal
      open={
        controller.canMutateCampaignSnapshot &&
        state.pendingBulkDeleteCount !== null
      }
      title={`Delete ${state.pendingBulkDeleteCount ?? 0} campaign${
        state.pendingBulkDeleteCount === 1 ? "" : "s"
      }? This can't be undone.`}
      confirmLabel="Delete"
      danger
      busy={state.bulkBusy}
      confirmDisabled={!controller.canMutateCampaignSnapshot}
      onConfirm={() => void controller.bulkActions.bulkDelete()}
      onClose={() => {
        if (!state.bulkBusy) state.setPendingBulkDeleteCount(null);
      }}
    />
  );
}

function CampaignDetailOverlay({
  controller,
}: CampaignsControllerProps): ReactElement | null {
  const { state } = controller;
  const openerRef = useRef<HTMLElement | null>(null);
  const previousSelectionRef = useRef<string | null>(null);
  const selectionId =
    state.selected?.id == null ? null : String(state.selected.id);
  useLayoutEffect(() => {
    if (selectionId != null && previousSelectionRef.current == null) {
      const active = document.activeElement;
      openerRef.current =
        active instanceof HTMLElement && active !== document.body
          ? active
          : null;
    }
    previousSelectionRef.current = selectionId;
  }, [selectionId]);
  if (!state.selected) return null;
  return (
    <Suspense
      fallback={
        <LazySlideoverFallback
          label="Campaign details"
          onClose={() => state.setSelected(null)}
          returnFocusRef={openerRef}
        />
      }
    >
      <CampaignDetailSlideover
        key={selectionId}
        campaign={state.selected}
        onClose={() => state.setSelected(null)}
        returnFocusRef={openerRef}
        onChange={(updated) => {
          void controller.data.load();
          if (updated == null) state.setSelected(null);
          else state.setSelected(updated);
        }}
      />
    </Suspense>
  );
}

function CampaignResultsOverlay({
  controller,
}: CampaignsControllerProps): ReactElement {
  const { state } = controller;
  return (
    <CampaignABResultsModal
      key={abResultsModalKey(state.abModalCampaign)}
      campaign={state.abModalCampaign}
      metric={state.abMetric}
      onMetricChange={state.setAbMetric}
      data={state.abData}
      weightHistory={state.abWeightHistory}
      loading={state.abLoading}
      error={state.abErr}
      onClose={() => state.setAbModalCampaign(null)}
    />
  );
}

function CampaignMoveModal({
  controller,
}: CampaignsControllerProps): ReactElement {
  const { state } = controller;
  return (
    <Modal
      open={controller.canMutateCampaignSnapshot && state.moveTarget != null}
      onClose={() => state.setMoveTarget(null)}
      title={`Move "${state.moveTarget?.name ?? "campaign"}"`}
      description="Pick a folder, or move back to uncategorised."
    >
      <FormField label="Folder" htmlFor="campaign-move-folder">
        <select
          id="campaign-move-folder"
          className="input"
          value={state.movePick}
          onChange={(event) => state.setMovePick(event.target.value)}
          disabled={!controller.canMutateCampaignSnapshot}
        >
          <option value="">Uncategorised</option>
          {state.folders.map((folder) => (
            <option key={folder.id} value={folder.id}>
              {folder.name}
            </option>
          ))}
        </select>
      </FormField>
      <ModalFooter>
        <button
          type="button"
          className="btn"
          onClick={() => state.setMoveTarget(null)}
        >
          Cancel
        </button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={!controller.canMutateCampaignSnapshot}
          onClick={() => void controller.rowActions.moveCampaign()}
        >
          Move
        </button>
      </ModalFooter>
    </Modal>
  );
}

function CampaignBulkMoveModal({
  controller,
}: CampaignsControllerProps): ReactElement {
  const { state } = controller;
  return (
    <Modal
      open={controller.canMutateCampaignSnapshot && state.bulkMoveOpen}
      onClose={() => state.setBulkMoveOpen(false)}
      title={`Move ${state.selectedIds.size} campaign${
        state.selectedIds.size === 1 ? "" : "s"
      }`}
      description="Pick a folder, or move back to uncategorised."
    >
      <FormField label="Folder" htmlFor="campaign-bulk-move-folder">
        <select
          id="campaign-bulk-move-folder"
          className="input"
          value={state.bulkMovePick}
          onChange={(event) => state.setBulkMovePick(event.target.value)}
          disabled={!controller.canMutateCampaignSnapshot || state.bulkBusy}
        >
          <option value="">Uncategorised</option>
          {state.folders.map((folder) => (
            <option key={folder.id} value={folder.id}>
              {folder.name}
            </option>
          ))}
        </select>
      </FormField>
      <ModalFooter>
        <button
          type="button"
          className="btn"
          onClick={() => state.setBulkMoveOpen(false)}
        >
          Cancel
        </button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={state.bulkBusy || !controller.canMutateCampaignSnapshot}
          onClick={() => void controller.bulkActions.bulkMove()}
        >
          {state.bulkBusy ? "Moving…" : "Move"}
        </button>
      </ModalFooter>
    </Modal>
  );
}

function CampaignBulkTagModal({
  controller,
}: CampaignsControllerProps): ReactElement {
  const { state } = controller;
  return (
    <Modal
      open={controller.canMutateCampaignSnapshot && state.bulkTagOpen}
      onClose={() => {
        if (!state.bulkBusy) state.setBulkTagOpen(false);
      }}
      title={`Tag ${state.selectedIds.size} campaign${
        state.selectedIds.size === 1 ? "" : "s"
      }`}
      description="Apply one organization tag to every selected campaign."
    >
      <FormField label="Tag" htmlFor="campaign-bulk-tag">
        <input
          id="campaign-bulk-tag"
          type="text"
          className="input"
          value={state.bulkTagValue}
          maxLength={80}
          placeholder="launch"
          onChange={(event) => state.setBulkTagValue(event.target.value)}
          disabled={!controller.canMutateCampaignSnapshot || state.bulkBusy}
        />
      </FormField>
      <ModalFooter>
        <button
          type="button"
          className="btn"
          disabled={state.bulkBusy}
          onClick={() => state.setBulkTagOpen(false)}
        >
          Cancel
        </button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={
            state.bulkBusy ||
            !controller.canMutateCampaignSnapshot ||
            state.bulkTagValue.trim().length === 0
          }
          onClick={() => void controller.bulkActions.bulkTag()}
        >
          {state.bulkBusy ? "Tagging…" : "Apply tag"}
        </button>
      </ModalFooter>
    </Modal>
  );
}

export function CampaignConfirmationOverlays({
  controller,
}: CampaignsControllerProps): ReactElement {
  return (
    <>
      <CampaignResendModal controller={controller} />
      <CampaignBulkDeleteModal controller={controller} />
    </>
  );
}

export function CampaignDetailAndFolderOverlays({
  controller,
}: CampaignsControllerProps): ReactElement {
  return (
    <>
      <CampaignDetailOverlay controller={controller} />
      <CampaignResultsOverlay controller={controller} />
      <CampaignMoveModal controller={controller} />
      <CampaignBulkMoveModal controller={controller} />
      <CampaignBulkTagModal controller={controller} />
    </>
  );
}
