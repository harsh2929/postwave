import { useState } from "react";

import { toast } from "../../components/Toast";
import {
  lifecycleOperationError,
  useSingleFlightOperation,
} from "../../hooks/useSettingsDraftLifecycle";
import { type Tag, api } from "../../lib/api-client";
import { deleteTagsForBulk } from "./tagPageModel";

interface TagDeleteDependencies {
  rows: Tag[] | null;
  load: (options?: { forceFresh?: boolean }) => Promise<void>;
  reloadTaxonomy: () => Promise<void>;
}

export function useTagDelete({
  rows,
  load,
  reloadTaxonomy,
}: TagDeleteDependencies) {
  const [target, setTarget] = useState<Tag | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  const mutation = useSingleFlightOperation({
    ownerId: "tag-page-mutation",
    label: "Tag mutation",
    detail: "Wait for the tag request to finish before leaving.",
  });

  const submitDelete = async (): Promise<void> => {
    if (!target) return;
    const currentTarget = target;
    const request = mutation.run(async () => {
      setDeleting(true);
      try {
        const result = await api.deleteTag(currentTarget.id);
        if (result.error) {
          toast.error({
            message: "Couldn't delete tag",
            detail: result.error.message,
          });
          return;
        }
        setTarget(null);
        toast.success(`Tag "${currentTarget.name}" deleted`);
        void load({ forceFresh: true });
        void reloadTaxonomy();
      } catch (error) {
        toast.error({
          message: "Couldn't delete tag",
          detail: lifecycleOperationError(error, "The delete request failed."),
        });
      } finally {
        setDeleting(false);
      }
    });
    if (!request) await mutation.wait();
  };

  const submitBulkDelete = async (): Promise<void> => {
    const ids = Array.from(selected);
    if (ids.length === 0) return;
    const request = mutation.run(async () => {
      const { ok, failures } = await deleteTagsForBulk(ids, rows ?? []);
      if (failures.length > 0) {
        setSelected(new Set(failures.map((failure) => failure.id)));
        toast.error({
          message: `Deleted ${ok.toLocaleString()}, ${failures.length.toLocaleString()} failed`,
          detail: `First failure: ${failures[0]?.detail ?? "request failed"}`,
        });
      } else {
        setSelected(new Set());
        toast.success(
          `Deleted ${ok.toLocaleString()} tag${ok === 1 ? "" : "s"}`,
        );
      }
      setBulkDeleteOpen(false);
      void load({ forceFresh: true });
      void reloadTaxonomy();
    });
    if (!request) await mutation.wait();
  };

  return {
    target,
    setTarget,
    deleting,
    selected,
    setSelected,
    bulkDeleteOpen,
    setBulkDeleteOpen,
    mutation,
    submitDelete,
    submitBulkDelete,
  };
}

export type TagDeleteController = ReturnType<typeof useTagDelete>;
