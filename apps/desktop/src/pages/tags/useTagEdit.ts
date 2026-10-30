import { useState } from "react";

import { toast } from "../../components/Toast";
import { useDraftLifecycleController } from "../../hooks/useDraftLifecycleController";
import { lifecycleOperationError } from "../../hooks/useSettingsDraftLifecycle";
import { type Tag, api } from "../../lib/api-client";
import { isSupportedTagColor } from "../../components/tags/tagColorPresentation";
import {
  EMPTY_TAG_DRAFT,
  runeLength,
  type TagDraft,
  tagToDraft,
} from "./tagPageModel";

interface TagEditDependencies {
  load: (options?: { forceFresh?: boolean }) => Promise<void>;
  reloadTaxonomy: () => Promise<void>;
}

export function useTagEdit({ load, reloadTaxonomy }: TagEditDependencies) {
  const [target, setTarget] = useState<Tag | null>(null);
  const [draft, setDraft] = useState<TagDraft>(EMPTY_TAG_DRAFT);
  const [error, setError] = useState<string | null>(null);

  const openEdit = (tag: Tag): void => {
    setTarget(tag);
    setDraft(tagToDraft(tag));
    setError(null);
  };

  const submit = async (): Promise<boolean> => {
    if (!target) return false;
    const currentTarget = target;
    const originalName = currentTarget.name ?? "";
    const nameChanged = draft.name !== originalName;
    const name = draft.name.trim();
    const colourChanged = (currentTarget.color ?? "") !== draft.color;
    const descriptionChanged =
      (currentTarget.description ?? "") !== draft.description;
    const groupChanged = (currentTarget.group_id ?? "") !== draft.groupId;
    if (nameChanged && !name) {
      setError("Name is required.");
      return false;
    }
    if (nameChanged && runeLength(name) > 64) {
      setError("Tag name must be 64 characters or fewer.");
      return false;
    }
    if (descriptionChanged && runeLength(draft.description) > 1_024) {
      setError("Description must be 1,024 characters or fewer.");
      return false;
    }
    if (colourChanged && !isSupportedTagColor(draft.color)) {
      setError("Choose a supported colour before saving the colour field.");
      return false;
    }
    setError(null);

    let queuedReceipt: { action: string; record: string } | null = null;
    if (nameChanged || colourChanged || descriptionChanged || groupChanged) {
      if (!currentTarget.etag) {
        setError(
          "This tag is missing its exact server version. Refresh the catalogue before saving.",
        );
        return false;
      }
      try {
        const updateResult = await api.updateTag(
          currentTarget.id,
          {
            ...(nameChanged ? { name } : {}),
            ...(colourChanged ? { color: draft.color } : {}),
            ...(descriptionChanged ? { description: draft.description } : {}),
            ...(groupChanged ? { group_id: draft.groupId } : {}),
          },
          currentTarget.etag,
        );
        if (updateResult.error) {
          setError(
            updateResult.error.status === 412
              ? "This tag changed elsewhere. Your draft was preserved; close and reopen it after the catalogue refresh to review the latest version."
              : updateResult.error.message,
          );
          if (updateResult.error.status === 412) {
            void load({ forceFresh: true });
          }
          return false;
        }
        if (updateResult.queued) queuedReceipt = updateResult.receipt;
      } catch (caught) {
        setError(lifecycleOperationError(caught, "The tag update failed."));
        return false;
      }
    }

    setTarget(null);
    if (queuedReceipt) {
      toast.info({
        message: `${queuedReceipt.record} saved on this device · pending sync`,
        detail: "The tag details remain in the encrypted sync journal.",
      });
    } else {
      toast.success(`Tag "${name}" updated`);
    }
    void load({ forceFresh: true });
    void reloadTaxonomy();
    return true;
  };

  const lifecycle = useDraftLifecycleController({
    ownerId: `tag-edit-${target?.id ?? "none"}`,
    label: "Tag changes",
    mode: "edit",
    enabled: target !== null,
    dirty:
      target !== null &&
      JSON.stringify(draft) !== JSON.stringify(tagToDraft(target)),
    save: submit,
    discard: () => {
      if (target) setDraft(tagToDraft(target));
      setError(null);
    },
    close: () => setTarget(null),
    detail: "These tag changes have not been saved.",
    operationDetail:
      "Wait for the tag update request to finish before leaving.",
    onError: (caught) =>
      setError(lifecycleOperationError(caught, "The tag couldn't be updated.")),
  });

  return {
    target,
    setTarget,
    draft,
    setDraft,
    error,
    lifecycle,
    openEdit,
  };
}

export type TagEditController = ReturnType<typeof useTagEdit>;
