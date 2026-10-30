import { useEffect, useRef, useState } from "react";

import {
  type MergeFieldSchemaPatch,
  type MergeFieldType,
  createMergeFieldSchema,
  deleteMergeFieldSchema,
  patchMergeFieldSchema,
} from "../../lib/api-client";
import { isMergeFieldSchema } from "../../lib/api/audience-segmentation";
import { toast } from "../Toast";
import type { MergeFieldsSchemaResource } from "./useMergeFieldsSchemaResource";

interface DraftPayload {
  key: string;
  label: string;
  type: MergeFieldType;
  defaultValue: string;
  required: boolean;
  position: number;
  valid: boolean;
}

interface MutationOptions {
  open: boolean;
  resource: MergeFieldsSchemaResource;
  schemaAvailable: boolean;
  draft: DraftPayload;
  onResetDraft: () => void;
  onChanged?: () => void;
  onDeleted: (removedKey: string, nextFocusKey: string) => void;
}

interface MutationController {
  adding: boolean;
  savingKeys: Set<string>;
  deleteKey: string | null;
  deleteBusy: boolean;
  deleteError: string | null;
  submitAdd: () => Promise<void>;
  updateRow: (key: string, patch: MergeFieldSchemaPatch) => Promise<boolean>;
  requestDelete: (key: string) => void;
  cancelDelete: () => void;
  removeRow: () => Promise<void>;
}

export function useMergeFieldsSchemaMutations({
  open,
  resource,
  schemaAvailable,
  draft,
  onResetDraft,
  onChanged,
  onDeleted,
}: MutationOptions): MutationController {
  const [adding, setAdding] = useState(false);
  const [savingKeys, setSavingKeys] = useState<Set<string>>(new Set());
  const [deleteKey, setDeleteKey] = useState<string | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const addingRef = useRef(false);
  const savingKeysRef = useRef<Set<string>>(new Set());
  const deletingRef = useRef(false);

  useEffect(() => {
    return () => {
      addingRef.current = false;
      savingKeysRef.current.clear();
      deletingRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (open) return;
    setDeleteKey(null);
    setDeleteBusy(false);
    setDeleteError(null);
  }, [open]);

  const reconcileStaleMutation = (): void => {
    onChanged?.();
    resource.markExternalChange();
  };

  const submitAdd = async (): Promise<void> => {
    if (addingRef.current || !schemaAvailable || !draft.valid) return;
    const operationGeneration = resource.generation();
    addingRef.current = true;
    setAdding(true);
    try {
      const response = await createMergeFieldSchema({
        key: draft.key,
        label: draft.label,
        type: draft.type,
        default_value: draft.defaultValue,
        required: draft.required,
        position: draft.position,
      });
      if (
        response.error ||
        !isMergeFieldSchema(response.data) ||
        response.data.key !== draft.key ||
        (resource.rows?.[0] &&
          response.data.tenant_id !== resource.rows[0].tenant_id)
      ) {
        if (!resource.isCurrentGeneration(operationGeneration)) return;
        toast.error(
          `Couldn't add ${draft.key}: ${response.error?.message ?? "No field was returned."}`,
        );
        return;
      }
      if (!resource.isCurrentGeneration(operationGeneration)) {
        reconcileStaleMutation();
        return;
      }
      resource.setRows((current) =>
        [...(current ?? []), response.data].sort(
          (left, right) =>
            left.position - right.position ||
            left.created_at.localeCompare(right.created_at),
        ),
      );
      onResetDraft();
      toast.success(`Added ${response.data.key}`);
      onChanged?.();
    } catch {
      if (resource.isCurrentGeneration(operationGeneration)) {
        toast.error(`Couldn't add ${draft.key}. Try again.`);
      }
    } finally {
      addingRef.current = false;
      if (resource.isMounted()) setAdding(false);
    }
  };

  const updateRow = async (
    key: string,
    patch: MergeFieldSchemaPatch,
  ): Promise<boolean> => {
    if (!schemaAvailable || savingKeysRef.current.has(key)) return false;
    const operationGeneration = resource.generation();
    savingKeysRef.current.add(key);
    setSavingKeys((current) => new Set(current).add(key));
    try {
      const response = await patchMergeFieldSchema(key, patch);
      const currentRow = resource.rows?.find((row) => row.key === key);
      if (
        response.error ||
        !isMergeFieldSchema(response.data) ||
        response.data.key !== key ||
        (currentRow && response.data.tenant_id !== currentRow.tenant_id)
      ) {
        if (!resource.isCurrentGeneration(operationGeneration)) return false;
        toast.error(
          `Couldn't save ${key}: ${response.error?.message ?? "No field was returned."}`,
        );
        return false;
      }
      if (!resource.isCurrentGeneration(operationGeneration)) {
        reconcileStaleMutation();
        return false;
      }
      resource.setRows(
        (current) =>
          current?.map((row) => (row.key === key ? response.data : row)) ??
          current,
      );
      toast.success(`Saved ${key}`);
      onChanged?.();
      return true;
    } catch {
      if (resource.isCurrentGeneration(operationGeneration)) {
        toast.error(`Couldn't save ${key}. Try again.`);
      }
      return false;
    } finally {
      if (resource.isMounted()) {
        setSavingKeys((current) => {
          const next = new Set(current);
          next.delete(key);
          return next;
        });
      }
      savingKeysRef.current.delete(key);
    }
  };

  const removeRow = async (): Promise<void> => {
    if (!deleteKey || deletingRef.current) return;
    const operationGeneration = resource.generation();
    deletingRef.current = true;
    setDeleteBusy(true);
    setDeleteError(null);
    try {
      const response = await deleteMergeFieldSchema(deleteKey);
      if (response.error || response.data?.ok !== true) {
        if (!resource.isCurrentGeneration(operationGeneration)) return;
        setDeleteError(
          response.error?.message ??
            "The service did not confirm removal. Nothing changed locally.",
        );
        toast.error(`Couldn't remove ${deleteKey}.`);
        return;
      }
      if (!resource.isCurrentGeneration(operationGeneration)) {
        reconcileStaleMutation();
        return;
      }
      const removed = deleteKey;
      const currentIndex =
        resource.rows?.findIndex((row) => row.key === removed) ?? -1;
      const nextFocusKey =
        currentIndex >= 0
          ? (resource.rows?.[currentIndex + 1]?.key ??
            resource.rows?.[currentIndex - 1]?.key ??
            "")
          : "";
      resource.setRows(
        (current) => current?.filter((row) => row.key !== removed) ?? current,
      );
      setDeleteKey(null);
      onDeleted(removed, nextFocusKey);
      toast.success(`Removed ${removed}`);
      onChanged?.();
    } catch {
      if (resource.isCurrentGeneration(operationGeneration)) {
        setDeleteError("The field couldn't be removed. Try again.");
      }
    } finally {
      deletingRef.current = false;
      if (resource.isMounted()) setDeleteBusy(false);
    }
  };

  return {
    adding,
    savingKeys,
    deleteKey,
    deleteBusy,
    deleteError,
    submitAdd,
    updateRow,
    requestDelete: (key: string) => {
      setDeleteError(null);
      setDeleteKey(key);
    },
    cancelDelete: () => {
      if (deleteBusy) return;
      setDeleteError(null);
      setDeleteKey(null);
    },
    removeRow,
  };
}
