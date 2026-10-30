/**
 * QueuedMutationEditor — modal editor for a queued offline mutation's
 * JSON body. Opened from the QueueTray ("Edit" on failed / conflict /
 * dead-letter rows) and from the ConflictModal ("Edit & retry").
 *
 * Read-only context header shows method + path + status + attempts so
 * the operator knows exactly what they're editing. The body editor is
 * structured where it can be: a flat JSON object (string / number /
 * boolean values only) renders as per-field inputs with type
 * preservation; nested bodies fall back to a validated raw-JSON
 * textarea (see queued-mutation-editor-helpers.ts for the derivation).
 *
 * Save:
 *   1. validates the body — JSON validity, per-field number parsing,
 *      and the offline-replay policy (isQueueableMutation) so an edit
 *      can't smuggle a send-like body past the sanitizer only to be
 *      quarantined on write;
 *   2. persists via updateOfflineMutation with status "pending",
 *      attempts reset to 0, and lastError cleared so the next drain
 *      retries it;
 *   3. fires onSaved — conflict flows hook this to route the item
 *      through reissueAsOverwrite (which reads the now-edited stored
 *      body) so the edit replays with If-Match: * semantics;
 *   4. kicks flushQueuedMutations (a no-op while offline — the drain
 *      runs on reconnect).
 *
 * Cancel / Esc / backdrop click leave the queued item untouched. Esc
 * registers on the global dialogStack via the underlying Modal, so a
 * nested editor closes before the surface that opened it.
 */

import { type ReactElement, useEffect, useState } from "react";

import { flushQueuedMutations } from "../lib/api-client";
import {
  OUTBOX_MAX_ATTEMPTS,
  isQueueableMutation,
  updateOfflineMutationDurably,
  type OfflineMutation,
} from "../lib/offline-store";
import { registerLifecycleGuard } from "../lib/lifecycle-coordinator";
import { FieldError, FormField } from "./FormField";
import { Modal, ModalFooter } from "./Modal";
import {
  buildBodyFromFields,
  deriveFlatFields,
  parseRawBody,
  stringifyBody,
  type FlatField,
} from "./queued-mutation-editor-helpers";

interface QueuedMutationEditorProps {
  open: boolean;
  item: OfflineMutation | null;
  onClose: () => void;
  /**
   * Fired after the edited body has been persisted (status "pending",
   * attempts 0, lastError cleared) and BEFORE the flush is kicked.
   * Conflict flows use this to call reissueAsOverwrite so the edited
   * body replays as a forced overwrite.
   */
  onSaved?: (id: string) => void;
}

export function QueuedMutationEditor({
  open,
  item,
  onClose,
  onSaved,
}: QueuedMutationEditorProps): ReactElement | null {
  /** null → the body isn't flat; use the raw-JSON textarea instead. */
  const [fields, setFields] = useState<FlatField[] | null>(null);
  const [rawText, setRawText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  /* Seed editor state from the queued item every time the editor opens
   * (or is retargeted at a different item) so a cancelled edit never
   * leaks into the next session. */
  useEffect(() => {
    if (!open || !item) return;
    const derived = deriveFlatFields(item.body);
    setFields(derived);
    setRawText(derived ? "" : stringifyBody(item.body));
    setError(null);
    setSaving(false);
    setDirty(false);
  }, [open, item]);

  useEffect(() => {
    if (!item || (!dirty && !saving)) return;
    return registerLifecycleGuard({
      id: `queued-mutation-editor-${item.id}`,
      label: "Queued change edits",
      inspect: (intent) =>
        intent.disposition === "hide"
          ? null
          : saving
            ? {
                level: "blocking",
                detail:
                  "The edited queued payload is still being encrypted and saved.",
                canDiscard: false,
              }
            : {
                level: "blocking",
                detail:
                  "The queued payload has local edits not yet written to the encrypted journal.",
              },
      discard: onClose,
    });
  }, [dirty, item, onClose, saving]);

  if (!open || !item) return null;

  const setFieldRaw = (index: number, raw: string | boolean): void => {
    setFields((prev) =>
      prev ? prev.map((f, i) => (i === index ? { ...f, raw } : f)) : prev,
    );
    setDirty(true);
    setError(null);
  };

  const handleSave = async (): Promise<void> => {
    const result = fields ? buildBodyFromFields(fields) : parseRawBody(rawText);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    if (!isQueueableMutation(item.method, item.path, result.body)) {
      setError(
        "This body can't replay offline — it matches an online-only action " +
          "(e.g. scheduling or sending a campaign). Revert those fields and try again.",
      );
      return;
    }
    setSaving(true);
    const persisted = await updateOfflineMutationDurably(item.id, {
      body: result.body,
      status: "pending",
      attempts: 0,
      lastError: undefined,
    });
    setSaving(false);
    if (!persisted) {
      setError(
        "The edited payload could not be stored securely. The original queued version is still safe; keep this editor open and try again.",
      );
      return;
    }
    onSaved?.(item.id);
    setDirty(false);
    void flushQueuedMutations();
    onClose();
  };

  return (
    <Modal
      open={open}
      onClose={() => {
        if (!saving) onClose();
      }}
      title="Edit queued change"
      description={`${item.method} ${item.path}`}
      size="lg"
    >
      <div className="muted" style={{ fontSize: 12, marginBottom: 12 }}>
        Status: {item.status} · Attempts: {item.attempts}/{OUTBOX_MAX_ATTEMPTS}
      </div>
      {item.lastError ? (
        <div className="queue-tray-item-error" style={{ marginBottom: 12 }}>
          {item.lastError}
        </div>
      ) : null}
      {fields ? (
        fields.map((field, index) => (
          <FormField
            key={field.key}
            label={field.key}
            help={
              field.type === "string" ? undefined : `Saved as ${field.type}`
            }
          >
            {field.type === "boolean" ? (
              <label
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  fontSize: 13,
                }}
              >
                <input
                  type="checkbox"
                  checked={field.raw === true}
                  onChange={(e) => setFieldRaw(index, e.target.checked)}
                />
                {field.raw === true ? "true" : "false"}
              </label>
            ) : (
              <input
                type="text"
                value={typeof field.raw === "string" ? field.raw : ""}
                inputMode={field.type === "number" ? "decimal" : undefined}
                onChange={(e) => setFieldRaw(index, e.target.value)}
                autoComplete="off"
                spellCheck={false}
              />
            )}
          </FormField>
        ))
      ) : (
        <FormField
          label="Body (JSON)"
          help="This body has nested values, so it's edited as raw JSON."
        >
          <textarea
            className="mono"
            rows={12}
            value={rawText}
            onChange={(e) => {
              setRawText(e.target.value);
              setDirty(true);
              setError(null);
            }}
            spellCheck={false}
          />
        </FormField>
      )}
      {error ? <FieldError>{error}</FieldError> : null}
      <ModalFooter>
        <button
          type="button"
          className="btn"
          onClick={onClose}
          disabled={saving}
        >
          Cancel
        </button>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => void handleSave()}
          disabled={saving}
          aria-busy={saving ? "true" : undefined}
        >
          {saving ? "Saving securely…" : "Save & retry"}
        </button>
      </ModalFooter>
    </Modal>
  );
}
