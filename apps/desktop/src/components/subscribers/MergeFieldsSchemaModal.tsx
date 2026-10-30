/**
 * Merge-field schema editor.
 *
 * The schema is production data: changing a field type can invalidate stored
 * values and deleting a field can destroy them. This surface therefore keeps
 * edits local until explicitly saved, reports real usage, and mirrors the
 * server's fail-closed data-loss rules.
 */
import {
  type ReactElement,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { type MergeFieldType } from "../../lib/api-client";
import { ConfirmModal } from "../ConfirmModal";
import { Modal, ModalFooter } from "../Modal";
import {
  KEY_PATTERN,
  MAX_LABEL_LENGTH,
  unicodeLength,
  validateMergeFieldDefault,
  validateMergeFieldPosition,
} from "./MergeFieldSchemaRow";
import {
  MergeFieldsSchemaCreateSection,
  MergeFieldsSchemaStatusAndList,
} from "./MergeFieldsSchemaSections";
import { useMergeFieldsSchemaMutations } from "./useMergeFieldsSchemaMutations";
import { useMergeFieldsSchemaResource } from "./useMergeFieldsSchemaResource";

interface Props {
  open: boolean;
  onClose: () => void;
  onChanged?: () => void;
}

export function MergeFieldsSchemaModal({
  open,
  onClose,
  onChanged,
}: Props): ReactElement {
  const [draftKey, setDraftKey] = useState("");
  const [draftLabel, setDraftLabel] = useState("");
  const [draftType, setDraftType] = useState<MergeFieldType>("text");
  const [draftDefault, setDraftDefault] = useState("");
  const [draftRequired, setDraftRequired] = useState(false);
  const [draftPosition, setDraftPosition] = useState(0);
  const [dirtyKeys, setDirtyKeys] = useState<Set<string>>(new Set());
  const [discardOpen, setDiscardOpen] = useState(false);
  const [focusAfterDeleteKey, setFocusAfterDeleteKey] = useState<string | null>(
    null,
  );
  const handleLoadCommit = useCallback((): void => {
    setDirtyKeys(new Set());
  }, []);
  const resource = useMergeFieldsSchemaResource(open, handleLoadCommit);
  const { rows, loading, loadError, externalChangePending, load } = resource;
  const draftKeyRef = useRef<HTMLInputElement>(null);
  const createHeadingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (!open) setDiscardOpen(false);
  }, [open]);

  useEffect(() => {
    if (focusAfterDeleteKey === null) return;
    const key = focusAfterDeleteKey;
    // The confirmation modal restores background interactivity in its cleanup
    // microtask. Focus after that cleanup so an inert parent cannot swallow it.
    queueMicrotask(() => {
      const target = document.getElementById(
        `mf-${key}-label`,
      ) as HTMLElement | null;
      const fallback = createHeadingRef.current;
      if (target?.isConnected) target.focus();
      else if (fallback?.isConnected) fallback.focus();
    });
    setFocusAfterDeleteKey(null);
  }, [focusAfterDeleteKey, rows]);

  const normalizedDraftKey = draftKey.trim().toUpperCase();
  const draftKeyError = !draftKey.trim()
    ? "A key is required."
    : !KEY_PATTERN.test(draftKey.trim())
      ? "Start with a letter; use up to 32 letters, numbers, or underscores."
      : rows?.some((row) => row.key === normalizedDraftKey)
        ? "That key already exists."
        : null;
  const draftLabelError = !draftLabel.trim()
    ? "A label is required."
    : unicodeLength(draftLabel.trim()) > MAX_LABEL_LENGTH
      ? `Use ${MAX_LABEL_LENGTH} characters or fewer.`
      : null;
  const draftDefaultError = validateMergeFieldDefault(draftType, draftDefault);
  const draftPositionError = validateMergeFieldPosition(draftPosition);
  const draftDirty =
    draftKey !== "" ||
    draftLabel !== "" ||
    draftType !== "text" ||
    draftDefault !== "" ||
    draftRequired ||
    draftPosition !== 0;
  const schemaAvailable = rows !== null && loadError === null && !loading;
  const usedFieldCount = useMemo(
    () => rows?.filter((row) => row.value_count > 0).length ?? 0,
    [rows],
  );

  const resetDraft = (): void => {
    setDraftKey("");
    setDraftLabel("");
    setDraftType("text");
    setDraftDefault("");
    setDraftRequired(false);
    setDraftPosition(0);
  };

  const handleDeleted = useCallback(
    (removedKey: string, nextFocusKey: string): void => {
      setDirtyKeys((current) => {
        const next = new Set(current);
        next.delete(removedKey);
        return next;
      });
      setFocusAfterDeleteKey(nextFocusKey);
    },
    [],
  );

  const {
    adding,
    savingKeys,
    deleteKey,
    deleteBusy,
    deleteError,
    submitAdd,
    updateRow,
    requestDelete,
    cancelDelete,
    removeRow,
  } = useMergeFieldsSchemaMutations({
    open,
    resource,
    schemaAvailable,
    draft: {
      key: normalizedDraftKey,
      label: draftLabel.trim(),
      type: draftType,
      defaultValue: draftDefault.trim(),
      required: draftRequired,
      position: draftPosition,
      valid: !Boolean(
        draftKeyError ||
        draftLabelError ||
        draftDefaultError ||
        draftPositionError,
      ),
    },
    onResetDraft: resetDraft,
    onChanged,
    onDeleted: handleDeleted,
  });
  const mutationBusy = adding || deleteBusy || savingKeys.size > 0;
  const hasUnsavedChanges = draftDirty || dirtyKeys.size > 0;

  const requestClose = (): void => {
    if (mutationBusy) return;
    if (hasUnsavedChanges) {
      setDiscardOpen(true);
      return;
    }
    onClose();
  };

  const handleDirtyChange = useCallback((key: string, dirty: boolean): void => {
    setDirtyKeys((current) => {
      const alreadyDirty = current.has(key);
      if (alreadyDirty === dirty) return current;
      const next = new Set(current);
      if (dirty) next.add(key);
      else next.delete(key);
      return next;
    });
  }, []);

  if (!open) return <></>;

  return (
    <>
      <Modal
        open={open}
        onClose={requestClose}
        title="Audience fields"
        description="Define reusable personalization fields without risking stored subscriber data."
        size="xl"
        closeOnBackdrop={!mutationBusy}
        closeOnEscape={!mutationBusy}
        closeDisabled={mutationBusy}
      >
        <MergeFieldsSchemaStatusAndList
          rows={rows}
          loading={loading}
          loadError={loadError}
          externalChangePending={externalChangePending}
          schemaAvailable={schemaAvailable}
          hasUnsavedChanges={hasUnsavedChanges}
          mutationBusy={mutationBusy}
          usedFieldCount={usedFieldCount}
          savingKeys={savingKeys}
          onLoad={() => void load()}
          onUpdateRow={updateRow}
          onRequestDelete={requestDelete}
          onDirtyChange={handleDirtyChange}
        />

        <MergeFieldsSchemaCreateSection
          schemaAvailable={schemaAvailable}
          adding={adding}
          draftKey={draftKey}
          draftLabel={draftLabel}
          draftType={draftType}
          draftDefault={draftDefault}
          draftRequired={draftRequired}
          draftPosition={draftPosition}
          draftDirty={draftDirty}
          draftKeyError={draftKeyError}
          draftLabelError={draftLabelError}
          draftDefaultError={draftDefaultError}
          draftPositionError={draftPositionError}
          draftKeyRef={draftKeyRef}
          createHeadingRef={createHeadingRef}
          setDraftKey={setDraftKey}
          setDraftLabel={setDraftLabel}
          setDraftType={setDraftType}
          setDraftDefault={setDraftDefault}
          setDraftRequired={setDraftRequired}
          setDraftPosition={setDraftPosition}
          onResetDraft={resetDraft}
          onSubmit={() => void submitAdd()}
        />

        <ModalFooter>
          <span className="merge-schema-footer-status" aria-live="polite">
            {mutationBusy
              ? "Finishing schema changes…"
              : dirtyKeys.size > 0
                ? `${dirtyKeys.size} unsaved ${dirtyKeys.size === 1 ? "field" : "fields"}`
                : draftDirty
                  ? "1 unsaved draft"
                  : "All changes saved"}
          </span>
          <button
            type="button"
            className="btn"
            disabled={mutationBusy}
            onClick={requestClose}
          >
            Done
          </button>
        </ModalFooter>
      </Modal>

      <ConfirmModal
        open={deleteKey !== null}
        title={`Remove ${deleteKey ?? "field"}?`}
        description="This removes the field from the audience schema. Moosewave will recheck for stored subscriber values when you confirm."
        confirmLabel="Remove field"
        danger
        busy={deleteBusy}
        onConfirm={removeRow}
        onClose={cancelDelete}
      >
        {deleteError ? (
          <p className="field-error" role="alert">
            {deleteError}
          </p>
        ) : (
          <p className="merge-schema-confirm-copy">
            Templates that reference <code>{deleteKey}</code> will render an
            empty value until they are updated.
          </p>
        )}
      </ConfirmModal>

      <ConfirmModal
        open={discardOpen}
        title="Discard unsaved schema changes?"
        description="Saved fields stay intact. Local row edits and the new-field draft will be discarded."
        confirmLabel="Discard changes"
        danger
        onConfirm={() => {
          setDiscardOpen(false);
          setDirtyKeys(new Set());
          resetDraft();
          onClose();
        }}
        onClose={() => setDiscardOpen(false)}
      />
    </>
  );
}
