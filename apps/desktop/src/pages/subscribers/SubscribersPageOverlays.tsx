import { Suspense, lazy, type ReactElement } from "react";

import { ConfirmModal } from "../../components/ConfirmModal";
import { FormField } from "../../components/FormField";
import { LazySlideoverFallback } from "../../components/LazySlideoverFallback";
import { Modal, ModalFooter } from "../../components/Modal";
import { DuplicatesModal } from "../../components/subscribers/DuplicatesModal";
import { MergeFieldsSchemaModal } from "../../components/subscribers/MergeFieldsSchemaModal";
import { SubscriberAddModal } from "../../components/subscribers/SubscriberAddModal";
import { consumeDesktopTaskIntent } from "../../lib/desktop-task-intents";
import type { Subscriber } from "../../lib/api-client";
import type { LifecycleTransitionResult } from "../../lib/lifecycle-coordinator";
import { subscriberKey } from "./subscribers-page-utils";
import type { SubscribersPageController } from "./useSubscribersPageController";

const SubscriberDetailSlideover = lazy(() =>
  import("../../components/SubscriberDetailSlideover").then((module) => ({
    default: module.SubscriberDetailSlideover,
  })),
);
const ImportSubscribersWizard = lazy(() =>
  import("../../components/subscribers/ImportSubscribersWizard").then(
    (module) => ({ default: module.ImportSubscribersWizard }),
  ),
);

export async function navigateSubscriberDetailRow(options: {
  rows: Subscriber[];
  currentIndex: number;
  delta: -1 | 1;
  navigate: (subscriber: Subscriber) => Promise<LifecycleTransitionResult>;
  setFocusedRowIndex: (index: number) => void;
}): Promise<void> {
  const target = options.currentIndex + options.delta;
  if (target < 0 || target >= options.rows.length) return;
  const result = await options.navigate(options.rows[target]);
  if (result === "proceeded") options.setFocusedRowIndex(target);
}

function SubscriberDetailOverlay({
  controller,
}: {
  controller: SubscribersPageController;
}): ReactElement | null {
  const selected = controller.state.selected;
  if (!selected) return null;
  const selectedKey = subscriberKey(selected);
  const navIndex = controller.data.pageRows.findIndex(
    (row) => subscriberKey(row) === selectedKey,
  );
  return (
    <Suspense
      fallback={
        <LazySlideoverFallback
          label="Subscriber details"
          onClose={controller.deepLinks.closeSubscriber}
        />
      }
    >
      <SubscriberDetailSlideover
        key={selectedKey}
        subscriber={selected}
        onClose={controller.deepLinks.closeSubscriber}
        onChange={(updated, hint) => {
          if (
            hint &&
            controller.mutations.applyMutationHint(selectedKey, updated, hint)
          ) {
            return;
          }
          controller.reloadAfterSubscriberMutation();
          controller.state.setSelected(updated);
        }}
        navIndex={navIndex >= 0 ? navIndex : undefined}
        navTotal={navIndex >= 0 ? controller.data.pageRows.length : undefined}
        onNavigate={(delta) => {
          if (navIndex < 0) return;
          void navigateSubscriberDetailRow({
            rows: controller.data.pageRows,
            currentIndex: navIndex,
            delta,
            navigate: controller.deepLinks.navigateSubscriber,
            setFocusedRowIndex: controller.state.setFocusedRowIndex,
          });
        }}
      />
    </Suspense>
  );
}

export function SubscribersPageOverlays({
  controller,
}: {
  controller: SubscribersPageController;
}): ReactElement {
  const { saved, state } = controller;
  const closeImport = (): void => {
    controller.closeImport();
    consumeDesktopTaskIntent("import-subscribers");
  };
  return (
    <>
      <SubscriberDetailOverlay controller={controller} />
      <SubscriberAddModal
        open={state.createOpen}
        onClose={() => state.setCreateOpen(false)}
        canMutate={controller.canMutate}
        onReload={controller.reloadAfterSubscriberMutation}
      />
      {state.importOpen ? (
        <Suspense
          fallback={
            <Modal
              open
              title="Preparing subscriber import"
              description="Loading the reviewed import workspace and its recovery state."
              onClose={closeImport}
            >
              <div role="status" aria-live="polite" aria-busy="true">
                Loading import controls…
              </div>
              <ModalFooter>
                <button type="button" className="btn" onClick={closeImport}>
                  Cancel
                </button>
              </ModalFooter>
            </Modal>
          }
        >
          <ImportSubscribersWizard
            open
            onClose={closeImport}
            onCompleted={controller.reloadAfterSubscriberMutation}
            identityScope={controller.recentSearchScope}
            canImport={controller.canAdmin}
          />
        </Suspense>
      ) : null}
      <DuplicatesModal
        open={state.dedupeOpen}
        onClose={() => state.setDedupeOpen(false)}
        onMerged={controller.reloadAfterSubscriberMutation}
      />
      <MergeFieldsSchemaModal
        open={state.mergeFieldsOpen}
        onClose={() => state.setMergeFieldsOpen(false)}
      />
      <Modal
        open={saved.saveCurrentOpen}
        onClose={() => saved.setSaveCurrentOpen(false)}
        closeOnBackdrop={!saved.saveCurrentBusy}
        closeOnEscape={!saved.saveCurrentBusy}
        closeDisabled={saved.saveCurrentBusy}
        title="Save current segment"
        description="Captures the applied query, status, archive scope, sort order, and visible columns as one authoritative Directory view."
      >
        <FormField
          label="Name"
          required
          htmlFor="save-seg-name"
          error={saved.saveCurrentNameError}
          help={`${saved.saveCurrentNameLength.toLocaleString()} of 120 characters`}
        >
          <input
            id="save-seg-name"
            className="input"
            value={saved.saveCurrentName}
            onChange={(event) => saved.setSaveCurrentName(event.target.value)}
            placeholder="High-engagement March"
            autoComplete="off"
          />
        </FormField>
        <FormField
          label="Sharing"
          htmlFor="save-seg-scope"
          help="Personal views are visible only to you. Workspace views are available to every member with subscriber access."
        >
          <select
            id="save-seg-scope"
            className="input"
            value={saved.saveCurrentScope}
            onChange={(event) =>
              saved.setSaveCurrentScope(
                event.target.value === "workspace" ? "workspace" : "personal",
              )
            }
            disabled={saved.saveCurrentBusy}
          >
            <option value="personal">Personal — only me</option>
            <option value="workspace">Workspace — all members</option>
          </select>
        </FormField>
        <div className="pw-action-status" role="status" aria-live="polite">
          Saving the applied view only. Page position and selected subscribers
          intentionally reset when this segment is reopened.
        </div>
        {saved.saveCurrentServerError ? (
          <div className="field-v2-error" role="alert">
            {saved.saveCurrentServerError}
          </div>
        ) : null}
        <ModalFooter>
          <button
            type="button"
            className="btn"
            onClick={() => saved.setSaveCurrentOpen(false)}
            disabled={saved.saveCurrentBusy}
          >
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void saved.submitSaveCurrent()}
            disabled={
              saved.saveCurrentBusy ||
              saved.saveCurrentScopePending ||
              Boolean(saved.saveCurrentNameError) ||
              !saved.saveCurrentName.trim()
            }
          >
            {saved.saveCurrentBusy ? "Saving…" : "Save segment"}
          </button>
        </ModalFooter>
        {saved.saveCurrentScopePending ? (
          <div className="muted" role="status" style={{ fontSize: 11 }}>
            Wait for the search query to finish applying before saving this
            exact view.
          </div>
        ) : null}
      </Modal>
      <ConfirmModal
        open={saved.saveCurrentDiscardConfirmOpen}
        title="Discard saved-segment draft?"
        description="The segment name and sharing choice entered for the current subscriber view will be lost."
        confirmLabel="Discard draft"
        danger
        busy={saved.saveCurrentBusy}
        onConfirm={saved.discardAndCloseSaveCurrent}
        onClose={() => saved.setSaveCurrentDiscardConfirmOpen(false)}
      />
      <ConfirmModal
        open={saved.pendingSegmentDelete !== null}
        title="Delete saved segment?"
        description={
          saved.pendingSegmentDelete
            ? `Delete saved segment "${saved.pendingSegmentDelete.name}"? The underlying subscribers stay; only the saved view is removed.`
            : ""
        }
        confirmLabel="Delete segment"
        danger
        busy={saved.segmentDeleteBusy}
        onConfirm={saved.confirmRemoveSaved}
        onClose={() => saved.setPendingSegmentDelete(null)}
      />
    </>
  );
}
