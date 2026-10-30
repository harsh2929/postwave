import type { ReactElement } from "react";

import { ConfirmModal } from "../../components/ConfirmModal";
import { Modal, ModalFooter } from "../../components/Modal";
import { BulkEditModal } from "../../components/tags/BulkEditModal";
import { MergeTagsDialog } from "../../components/tags/MergeTagsDialog";
import { RegisterOrphanModal } from "../../components/tags/RegisterOrphanModal";
import { TagBulkBar } from "../../components/tags/TagBulkBar";
import { TagDetailSlideover } from "../../components/tags/TagDetailSlideover";
import { TagGroupManageModal } from "../../components/tags/TagGroupManageModal";
import { TagCreateModal, TagEditModal } from "./TagFormModals";
import type { TagsPageController } from "./useTagsPageController";
import { tagUsageForName } from "./tagCatalogContracts";

export function TagOverlays({
  controller,
}: {
  controller: TagsPageController;
}): ReactElement {
  return (
    <>
      <TagFormOverlays controller={controller} />
      <TagMutationOverlays controller={controller} />
      <TagDetailOverlay controller={controller} />
      <TagConfirmationAndGroupOverlays controller={controller} />
    </>
  );
}

function TagFormOverlays({
  controller,
}: {
  controller: TagsPageController;
}): ReactElement {
  return (
    <>
      <TagCreateModal
        open={controller.create.open}
        draft={controller.create.draft}
        groups={
          controller.groupFeatureAvailable ? controller.catalog.groups : []
        }
        suggestions={controller.create.suggestions}
        suggestionError={controller.create.suggestionError}
        dedupHint={controller.create.dedupHint}
        formErrors={controller.create.formErrors}
        submitError={controller.create.submitError}
        lifecycle={controller.create.lifecycle}
        onChange={controller.create.setDraft}
      />
      <TagEditModal
        open={controller.edit.target !== null}
        draft={controller.edit.draft}
        groups={
          controller.groupFeatureAvailable ? controller.catalog.groups : []
        }
        error={controller.edit.error}
        lifecycle={controller.edit.lifecycle}
        onChange={controller.edit.setDraft}
      />
      <Modal
        open={controller.deletion.target !== null}
        onClose={() => {
          if (!controller.deletion.mutation.active) {
            controller.deletion.setTarget(null);
          }
        }}
        title="Delete tag"
        description="The tag will be removed from the catalogue."
      >
        <p style={{ margin: "0 0 12px", lineHeight: 1.5 }}>
          Delete{" "}
          <strong>{controller.deletion.target?.name ?? "this tag"}</strong>?
          Subscribers currently labelled with it will keep the literal text on
          their record.
        </p>
        <ModalFooter>
          <button
            type="button"
            className="btn"
            onClick={() => controller.deletion.setTarget(null)}
            disabled={
              controller.deletion.deleting ||
              controller.deletion.mutation.active
            }
          >
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-danger"
            onClick={() => void controller.deletion.submitDelete()}
            disabled={
              controller.deletion.deleting ||
              controller.deletion.mutation.active
            }
          >
            {controller.deletion.deleting ? "Deleting…" : "Delete tag"}
          </button>
        </ModalFooter>
      </Modal>
    </>
  );
}

function TagMutationOverlays({
  controller,
}: {
  controller: TagsPageController;
}): ReactElement {
  const selectedTags = (controller.catalog.rows ?? []).filter((tag) =>
    controller.deletion.selected.has(tag.id),
  );
  const openBulkEdit = (mode: "color" | "description"): void => {
    controller.setBulkEditMode(mode);
    controller.setBulkEditOpen(true);
  };
  const finishBulkEdit = (): void => {
    controller.setBulkEditOpen(false);
    controller.deletion.setSelected(new Set());
    void controller.catalog.load({ forceFresh: true });
  };
  const finishMerge = (): void => {
    controller.setMergeOpen(false);
    controller.deletion.setSelected(new Set());
    void controller.catalog.load({ forceFresh: true });
    void controller.catalog.reloadTaxonomy();
  };
  const finishRegistration = (): void => {
    controller.setRegisterTarget(null);
    void controller.catalog.load({ forceFresh: true });
    void controller.catalog.reloadTaxonomy();
  };

  return (
    <>
      <TagBulkBar
        count={controller.deletion.selected.size}
        canDelete={false}
        deleteUnavailableReason={controller.deleteUnavailableReason}
        onClear={() => controller.deletion.setSelected(new Set())}
        onDelete={() => controller.deletion.setBulkDeleteOpen(true)}
        onMerge={undefined}
        onRecolour={
          controller.canMutate ? () => openBulkEdit("color") : undefined
        }
        onDescribe={
          controller.canMutate ? () => openBulkEdit("description") : undefined
        }
      />
      <BulkEditModal
        open={controller.bulkEditOpen}
        tags={selectedTags}
        mode={controller.bulkEditMode}
        onClose={() => controller.setBulkEditOpen(false)}
        onApplied={finishBulkEdit}
        onRetainSelection={(ids) =>
          controller.deletion.setSelected(new Set(ids))
        }
        onConflict={() => controller.catalog.load({ forceFresh: true })}
      />
      <MergeTagsDialog
        open={controller.mergeOpen}
        tags={controller.catalog.rows ?? []}
        usage={controller.catalog.usageByName}
        initialFrom={controller.mergeFromNames}
        onClose={() => controller.setMergeOpen(false)}
        onMerged={finishMerge}
      />
      <RegisterOrphanModal
        name={controller.registerTarget}
        subscriberCount={
          controller.registerTarget && controller.usageAvailable
            ? (tagUsageForName(
                controller.catalog.usageByName,
                controller.registerTarget,
              )?.subscribers ?? 0)
            : null
        }
        onClose={() => controller.setRegisterTarget(null)}
        onRegistered={finishRegistration}
      />
    </>
  );
}

function TagDetailOverlay({
  controller,
}: {
  controller: TagsPageController;
}): ReactElement | null {
  const detailTag = controller.catalog.detailTag;
  const updateDetail = (next: NonNullable<typeof detailTag>): void => {
    controller.catalog.setRows((previous) =>
      previous
        ? previous.map((tag) => (tag.id === next.id ? next : tag))
        : previous,
    );
    controller.catalog.setDetailTag(next);
  };
  if (!detailTag) return null;
  return (
    <TagDetailSlideover
      tag={detailTag}
      usage={tagUsageForName(controller.catalog.usageByName, detailTag.name)}
      usageAvailable={controller.usageAvailable}
      canMutate={controller.canMutate}
      onClose={controller.detailRoute.closeDetail}
      onUpdated={updateDetail}
      onConflict={() => void controller.catalog.load({ forceFresh: true })}
    />
  );
}

function TagConfirmationAndGroupOverlays({
  controller,
}: {
  controller: TagsPageController;
}): ReactElement {
  const refreshAfterGroupChange = (): void => {
    void controller.catalog.loadGroups();
    void controller.catalog.load({ forceFresh: true });
  };
  return (
    <>
      <ConfirmModal
        open={controller.deletion.bulkDeleteOpen}
        title={`Delete ${controller.deletion.selected.size} tag${controller.deletion.selected.size === 1 ? "" : "s"}?`}
        description="Removes these tags from the taxonomy. Subscribers keep the literal tag text on their record — they're un-registered, not stripped. Re-creating a tag with the same name restores its registration."
        confirmLabel="Delete tags"
        danger
        typeToConfirm={
          controller.deletion.selected.size >= 5 ? "delete" : undefined
        }
        busy={controller.deletion.mutation.active}
        onClose={() => {
          if (!controller.deletion.mutation.active) {
            controller.deletion.setBulkDeleteOpen(false);
          }
        }}
        onConfirm={() => void controller.deletion.submitBulkDelete()}
      />
      <ConfirmModal
        open={controller.create.lifecycle.discardConfirmOpen}
        title="Discard tag draft?"
        description="The tag has not been created."
        confirmLabel="Discard draft"
        danger
        busy={controller.create.lifecycle.active}
        onConfirm={controller.create.lifecycle.discardAndClose}
        onClose={controller.create.lifecycle.keepEditing}
      />
      <ConfirmModal
        open={controller.edit.lifecycle.discardConfirmOpen}
        title="Discard tag changes?"
        description="Your changes will be restored to the last loaded tag."
        confirmLabel="Discard changes"
        danger
        busy={controller.edit.lifecycle.active}
        onConfirm={controller.edit.lifecycle.discardAndClose}
        onClose={controller.edit.lifecycle.keepEditing}
      />
      <TagGroupManageModal
        open={
          controller.groupManageOpen &&
          controller.groupFeatureAvailable &&
          controller.canAdmin
        }
        groups={controller.catalog.groups}
        onClose={() => controller.setGroupManageOpen(false)}
        onChanged={refreshAfterGroupChange}
      />
    </>
  );
}
