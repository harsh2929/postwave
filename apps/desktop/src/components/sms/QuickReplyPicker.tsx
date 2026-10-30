/** Saved-reply browser and create task for the SMS composer. */

import {
  type FocusEvent,
  type ReactElement,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";

import { useDialogStack } from "../../hooks/useDialogStack";
import {
  lifecycleOperationError,
  useDiscardOnlyDraftLifecycle,
  useSingleFlightOperation,
} from "../../hooks/useSettingsDraftLifecycle";
import { type SMSQuickReply, api } from "../../lib/api-client";
import { popDialog, pushDialog } from "../../lib/dialogStack";
import { ConfirmModal } from "../ConfirmModal";
import { FormField } from "../FormField";
import { toast } from "../Toast";
import { useSMSDocumentVisible } from "./sms-page-activity";
import { smsReplyBodyConstraint } from "./sms-reply-intent";

interface Props {
  onPick: (reply: SMSQuickReply) => void;
}

interface DraftFormProps {
  body: string;
  bodyError: string | null;
  busy: boolean;
  label: string;
  labelError: string | null;
  onBody: (value: string) => void;
  onLabel: (value: string) => void;
  onSave: () => void;
}

function QuickReplyDraftForm({
  body,
  bodyError,
  busy,
  label,
  labelError,
  onBody,
  onLabel,
  onSave,
}: DraftFormProps): ReactElement {
  const initialFocusRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    initialFocusRef.current?.focus();
  }, []);

  return (
    <div className="sms-quick-reply-form">
      <FormField label="Reply label" required error={labelError ?? undefined}>
        <input
          ref={initialFocusRef}
          className="input"
          value={label}
          onChange={(event) => onLabel(event.target.value)}
          autoComplete="off"
          disabled={busy}
          maxLength={320}
        />
      </FormField>
      <FormField label="Reply body" required error={bodyError ?? undefined}>
        <textarea
          className="input"
          rows={3}
          value={body}
          onChange={(event) => onBody(event.target.value)}
          disabled={busy}
          maxLength={16_384}
        />
      </FormField>
      <div className="sms-quick-reply-form-actions">
        <button
          type="button"
          className="btn btn-sm btn-primary"
          onClick={onSave}
          disabled={busy || labelError !== null || bodyError !== null}
        >
          {busy ? "Saving…" : "Save reply"}
        </button>
      </div>
    </div>
  );
}

interface ReplyListProps {
  blocked: boolean;
  items: SMSQuickReply[];
  onDelete: (reply: SMSQuickReply) => void;
  onPick: (reply: SMSQuickReply) => void;
}

function QuickReplyList({
  blocked,
  items,
  onDelete,
  onPick,
}: ReplyListProps): ReactElement {
  return (
    <div
      className="sms-quick-reply-list"
      role="list"
      aria-label="Saved replies"
    >
      {items.map((reply, index) => (
        <div key={reply.id} className="sms-quick-reply-row" role="listitem">
          <button
            type="button"
            className="sms-quick-reply-pick"
            onClick={() => onPick(reply)}
            disabled={blocked}
            aria-label={`Insert saved reply ${index + 1}`}
          >
            <bdi dir="auto" className="sms-quick-reply-label">
              {reply.label}
            </bdi>
            <span dir="auto" className="muted sms-quick-reply-body">
              {reply.body}
            </span>
          </button>
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            onClick={() => onDelete(reply)}
            disabled={blocked}
            aria-label={`Delete saved reply ${index + 1}`}
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}

interface ConfirmationProps {
  confirmDiscardOpen: boolean;
  deleteBusy: boolean;
  pendingDelete: SMSQuickReply | null;
  onCancelDelete: () => void;
  onCancelDiscard: () => void;
  onConfirmDelete: () => Promise<void>;
  onConfirmDiscard: () => void;
}

function QuickReplyConfirmations({
  confirmDiscardOpen,
  deleteBusy,
  pendingDelete,
  onCancelDelete,
  onCancelDiscard,
  onConfirmDelete,
  onConfirmDiscard,
}: ConfirmationProps): ReactElement {
  return (
    <>
      <ConfirmModal
        open={pendingDelete !== null}
        title="Delete this quick reply?"
        description="This saved reply is removed from the catalogue. Operators will no longer see it in the inbox composer."
        confirmLabel="Delete reply"
        danger
        busy={deleteBusy}
        onConfirm={onConfirmDelete}
        onClose={onCancelDelete}
      >
        {pendingDelete ? (
          <p className="sms-quick-reply-confirm-label">
            Selected saved reply: <bdi dir="auto">{pendingDelete.label}</bdi>
          </p>
        ) : null}
      </ConfirmModal>
      <ConfirmModal
        open={confirmDiscardOpen}
        title="Discard the new quick reply?"
        description="The unsaved label and reply body will be lost."
        confirmLabel="Discard draft"
        danger
        onConfirm={onConfirmDiscard}
        onClose={onCancelDiscard}
      />
    </>
  );
}

export function QuickReplyPicker({ onPick }: Props): ReactElement {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<SMSQuickReply[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [snapshotAt, setSnapshotAt] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [creating, setCreating] = useState(false);
  const [draftLabel, setDraftLabel] = useState("");
  const [draftBody, setDraftBody] = useState("");
  const [pendingDelete, setPendingDelete] = useState<SMSQuickReply | null>(
    null,
  );
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [confirmDiscardOpen, setConfirmDiscardOpen] = useState(false);
  const [discardClosesPicker, setDiscardClosesPicker] = useState(false);
  const restoreAfterDiscardRef = useRef(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const loadGenerationRef = useRef(0);
  const loadAbortRef = useRef<AbortController | null>(null);
  const hostedDialogRef = useRef(false);
  const pickerId = useId();
  const titleId = useId();
  const dialogId = useId();
  const lifecycleId = useId();
  const { isTop } = useDialogStack(dialogId);
  const documentVisible = useSMSDocumentVisible();
  const operation = useSingleFlightOperation({
    ownerId: `sms-quick-reply-${lifecycleId}`,
    label: "Quick reply change",
    detail: "Wait for the quick reply request to finish.",
  });
  const draftDirty = draftLabel.trim() !== "" || draftBody.trim() !== "";
  const normalizedDraftLabel = draftLabel.trim();
  const labelCodePoints = Array.from(normalizedDraftLabel).length;
  const labelBytes = new TextEncoder().encode(normalizedDraftLabel).byteLength;
  const labelError =
    normalizedDraftLabel.length === 0
      ? "Enter a reply label."
      : /[\p{Cc}\p{Cf}]/u.test(normalizedDraftLabel)
        ? "Reply labels cannot contain control or direction-formatting characters."
        : labelCodePoints > 80
          ? "Reply label exceeds the 80-character server limit."
          : labelBytes > 320
            ? "Reply label exceeds the 320-byte UTF-8 server limit."
            : null;
  const bodyConstraint = smsReplyBodyConstraint(draftBody);
  hostedDialogRef.current = pendingDelete !== null || confirmDiscardOpen;

  const clearDraft = useCallback((): void => {
    setDraftLabel("");
    setDraftBody("");
    setCreating(false);
  }, []);

  const discardForLifecycle = useCallback((): void => {
    clearDraft();
    setConfirmDiscardOpen(false);
    setOpen(false);
  }, [clearDraft]);

  useDiscardOnlyDraftLifecycle({
    ownerId: `sms-quick-reply-${lifecycleId}`,
    label: "New SMS quick reply",
    dirty: draftDirty,
    operationRef: operation.promiseRef,
    discard: discardForLifecycle,
    detail: "The new quick reply has not been saved.",
  });

  const load = useCallback(async (): Promise<void> => {
    loadAbortRef.current?.abort();
    const controller = new AbortController();
    loadAbortRef.current = controller;
    const generation = ++loadGenerationRef.current;
    setLoading(true);
    setLoadError(null);
    try {
      const response = await api.listSMSQuickReplies({
        signal: controller.signal,
      });
      if (
        generation !== loadGenerationRef.current ||
        controller.signal.aborted
      ) {
        return;
      }
      if (response.error || !response.data) {
        setLoadError(response.error?.message ?? "Couldn't load saved replies.");
        return;
      }
      setItems(response.data.replies);
      setSnapshotAt(response.data.snapshotAt);
      setTruncated(response.data.truncated);
    } catch (error) {
      if (
        generation === loadGenerationRef.current &&
        !controller.signal.aborted
      ) {
        setLoadError(
          lifecycleOperationError(error, "Couldn't load saved replies."),
        );
      }
    } finally {
      if (
        generation === loadGenerationRef.current &&
        loadAbortRef.current === controller
      ) {
        loadAbortRef.current = null;
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    if (open && documentVisible) {
      void load();
      return () => loadAbortRef.current?.abort();
    }
    loadAbortRef.current?.abort();
    loadAbortRef.current = null;
    setLoading(false);
    return undefined;
  }, [documentVisible, load, open]);

  useEffect(
    () => () => {
      loadAbortRef.current?.abort();
      loadGenerationRef.current += 1;
    },
    [],
  );

  useEffect(() => {
    if (!open) return;
    pushDialog(dialogId);
    return () => popDialog(dialogId);
  }, [dialogId, open]);

  useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() => closeRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [open]);

  const restoreTrigger = useCallback(
    (): void => queueMicrotask(() => triggerRef.current?.focus()),
    [],
  );

  const requestClose = useCallback(
    (restoreFocus: boolean): void => {
      if (operation.active) return;
      if (draftDirty) {
        restoreAfterDiscardRef.current = restoreFocus;
        setDiscardClosesPicker(true);
        setConfirmDiscardOpen(true);
        return;
      }
      setOpen(false);
      if (restoreFocus) restoreTrigger();
    },
    [draftDirty, operation.active, restoreTrigger],
  );

  useEffect(() => {
    if (!open || hostedDialogRef.current) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.isComposing || event.keyCode === 229) return;
      if (event.key === "Escape" && isTop) {
        event.preventDefault();
        requestClose(true);
      }
    };
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target as Node;
      if (
        panelRef.current?.contains(target) ||
        triggerRef.current?.contains(target)
      ) {
        return;
      }
      requestClose(false);
    };
    window.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [confirmDiscardOpen, isTop, open, pendingDelete, requestClose]);

  const onPanelBlur = (event: FocusEvent<HTMLDivElement>): void => {
    const next = event.relatedTarget as Node | null;
    if (next && panelRef.current?.contains(next)) return;
    window.requestAnimationFrame(() => {
      if (hostedDialogRef.current) return;
      if (panelRef.current?.contains(document.activeElement)) return;
      requestClose(false);
    });
  };

  const saveDraft = async (): Promise<void> => {
    const label = normalizedDraftLabel;
    const body = bodyConstraint.trimmed;
    if (labelError || bodyConstraint.error || operation.active) return;
    const request = operation.run(() =>
      api.createSMSQuickReply({ label, body }),
    );
    if (!request) return;
    try {
      const response = await request;
      if (response.error || !response.data) {
        toast.error(
          `Couldn't save: ${response.error?.message ?? "Invalid server response."}`,
        );
        return;
      }
      const savedReply = response.data.reply;
      setItems((previous) =>
        previous
          ? [
              savedReply,
              ...previous.filter((reply) => reply.id !== savedReply.id),
            ]
          : [savedReply],
      );
      setSnapshotAt(null);
      clearDraft();
      toast.success("Quick reply saved");
      await load();
    } catch (error) {
      toast.error(
        lifecycleOperationError(error, "Couldn't save the quick reply."),
      );
    }
  };

  const confirmDelete = async (): Promise<void> => {
    if (!pendingDelete || operation.active) return;
    const target = pendingDelete;
    const request = operation.run(() => api.deleteSMSQuickReply(target.id));
    if (!request) return;
    setDeleteBusy(true);
    try {
      const response = await request;
      if (response.error || !response.data) {
        toast.error(
          `Couldn't delete: ${response.error?.message ?? "Invalid server response."}`,
        );
        return;
      }
      setItems((previous) =>
        previous
          ? previous.filter((reply) => reply.id !== target.id)
          : previous,
      );
      setSnapshotAt(null);
      setPendingDelete(null);
      await load();
    } catch (error) {
      toast.error(
        lifecycleOperationError(error, "Couldn't delete the quick reply."),
      );
    } finally {
      setDeleteBusy(false);
    }
  };

  const confirmDiscard = (): void => {
    clearDraft();
    setConfirmDiscardOpen(false);
    if (discardClosesPicker) {
      setOpen(false);
      if (restoreAfterDiscardRef.current) restoreTrigger();
    }
    setDiscardClosesPicker(false);
    restoreAfterDiscardRef.current = false;
  };

  return (
    <div className="sms-quick-reply-picker">
      <button
        ref={triggerRef}
        type="button"
        className="btn btn-sm btn-ghost"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? pickerId : undefined}
        onClick={() => (open ? requestClose(false) : setOpen(true))}
      >
        Quick replies {open ? "▾" : "▸"}
      </button>
      {open ? (
        <div
          ref={panelRef}
          id={pickerId}
          className="sms-quick-reply-popover"
          role="dialog"
          aria-modal="false"
          aria-labelledby={titleId}
          onBlurCapture={onPanelBlur}
        >
          <div className="sms-quick-reply-popover-head">
            <strong id={titleId}>Saved replies</strong>
            <div className="sms-quick-reply-head-actions">
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                onClick={() => {
                  if (creating && draftDirty) {
                    setDiscardClosesPicker(false);
                    setConfirmDiscardOpen(true);
                  } else {
                    setCreating((value) => !value);
                  }
                }}
                disabled={operation.active}
              >
                {creating ? "Cancel new reply" : "+ New reply"}
              </button>
              <button
                ref={closeRef}
                type="button"
                className="btn btn-sm btn-ghost"
                onClick={() => requestClose(true)}
                disabled={operation.active}
              >
                Close
              </button>
            </div>
          </div>
          {creating ? (
            <QuickReplyDraftForm
              body={draftBody}
              bodyError={bodyConstraint.error}
              busy={operation.active}
              label={draftLabel}
              labelError={labelError}
              onBody={setDraftBody}
              onLabel={setDraftLabel}
              onSave={() => void saveDraft()}
            />
          ) : null}
          {items !== null && !loading && !loadError ? (
            <p className="sms-quick-reply-snapshot muted small" role="status">
              {truncated
                ? `Showing a server-capped ${items.length.toLocaleString()}-reply window${snapshotAt ? ` as of ${new Date(snapshotAt).toLocaleString()}` : ""}; additional saved replies are not shown.`
                : snapshotAt
                  ? `${items.length.toLocaleString()} saved ${items.length === 1 ? "reply" : "replies"} loaded as of ${new Date(snapshotAt).toLocaleString()}.`
                  : "The catalogue changed after its loaded page boundary; refreshing authoritative order."}
            </p>
          ) : null}
          {creating && draftDirty ? (
            <p className="muted small sms-quick-reply-draft-note">
              Save or discard the new reply before inserting or deleting
              another.
            </p>
          ) : null}
          {loading ? (
            <div className="sms-quick-reply-state" role="status">
              Loading saved replies…
            </div>
          ) : loadError ? (
            <div className="sms-quick-reply-state" role="alert">
              <span>{loadError}</span>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => void load()}
              >
                Retry
              </button>
            </div>
          ) : !items || items.length === 0 ? (
            <div className="sms-quick-reply-state">
              No saved replies in the loaded response. Choose New reply to
              create one.
            </div>
          ) : (
            <QuickReplyList
              blocked={operation.active || (creating && draftDirty)}
              items={items}
              onDelete={setPendingDelete}
              onPick={(reply) => {
                onPick(reply);
                setOpen(false);
                restoreTrigger();
              }}
            />
          )}
        </div>
      ) : null}
      <QuickReplyConfirmations
        confirmDiscardOpen={confirmDiscardOpen}
        deleteBusy={deleteBusy}
        pendingDelete={pendingDelete}
        onCancelDelete={() => setPendingDelete(null)}
        onCancelDiscard={() => {
          setConfirmDiscardOpen(false);
          setDiscardClosesPicker(false);
          restoreAfterDiscardRef.current = false;
        }}
        onConfirmDelete={confirmDelete}
        onConfirmDiscard={confirmDiscard}
      />
    </div>
  );
}
