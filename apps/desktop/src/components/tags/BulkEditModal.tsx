/**
 * BulkEditModal — apply a colour and/or description to N selected
 * tags in one go. Refined Tags PR 3.
 *
 * Both fields are optional: tick the checkbox to opt that field into
 * the patch. An empty patch is a no-op (Apply disabled). We fire one
 * PATCH per tag in sequence (the catalogue is tiny — typically a few
 * dozen tags — so parallelism would buy us nothing meaningful and
 * makes failure reporting fiddly).
 *
 * Parent owns the selected Tag[]; this component is pure presentation
 * plus the loop itself.
 */

import { type ReactElement, useEffect, useMemo, useRef, useState } from "react";

import { type Tag, api } from "../../lib/api-client";
import { Modal, ModalFooter } from "../Modal";
import { toast } from "../Toast";
import { TAG_PALETTE } from "./tagColorPresentation";
import {
  TAG_DESCRIPTION_MAX_RUNES,
  limitRunes,
  runeLength,
} from "./tagWriteConstraints";

interface Props {
  open: boolean;
  tags: Tag[];
  /** Initial mode opens the corresponding checkbox pre-ticked so the
   *  toolbar's "Recolour…" vs "Describe…" buttons go straight to
   *  the right field. */
  mode?: "color" | "description";
  onClose: () => void;
  onApplied: () => void;
  onRetainSelection?: (failedIds: string[]) => void;
  onConflict?: () => Promise<void> | void;
}

export function BulkEditModal({
  open,
  tags,
  mode = "color",
  onClose,
  onApplied,
  onRetainSelection,
  onConflict,
}: Props): ReactElement {
  const [applyColor, setApplyColor] = useState(mode === "color");
  const [applyDesc, setApplyDesc] = useState(mode === "description");
  const [color, setColor] = useState<string>("slate");
  const [description, setDescription] = useState<string>("");
  const [submitting, setSubmitting] = useState(false);
  const [progress, setProgress] = useState<{
    ok: number;
    queued: number;
    failed: number;
  }>({
    ok: 0,
    queued: 0,
    failed: 0,
  });
  const [failedIds, setFailedIds] = useState<string[]>([]);
  const mountedRef = useRef(true);
  const operationRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Reset whenever the modal re-opens (or the mode changes mid-session)
  // so old state doesn't bleed into a fresh action.
  useEffect(() => {
    if (!open) return;
    setApplyColor(mode === "color");
    setApplyDesc(mode === "description");
    setColor("slate");
    setDescription("");
    setSubmitting(false);
    setProgress({ ok: 0, queued: 0, failed: 0 });
    setFailedIds([]);
    operationRef.current = false;
  }, [open, mode]);

  const targets = useMemo(
    () =>
      failedIds.length > 0
        ? tags.filter((tag) => failedIds.includes(tag.id))
        : tags,
    [failedIds, tags],
  );
  const canApply = (applyColor || applyDesc) && targets.length > 0;

  const submit = async (): Promise<void> => {
    if (!canApply || operationRef.current) return;
    operationRef.current = true;
    setSubmitting(true);
    setProgress({ ok: 0, queued: 0, failed: 0 });
    let ok = 0;
    let queued = 0;
    let failed = 0;
    let conflict = false;
    const nextFailedIds: string[] = [];
    try {
      for (const tag of targets) {
        const patch: { color?: string; description?: string } = {};
        if (applyColor) patch.color = color;
        if (applyDesc) patch.description = description;
        try {
          const result = await api.updateTag(tag.id, patch, tag.etag ?? "");
          if (result.error) {
            failed += 1;
            nextFailedIds.push(tag.id);
            if (result.error.status === 412) conflict = true;
          } else if (result.queued) queued += 1;
          else ok += 1;
        } catch {
          failed += 1;
          nextFailedIds.push(tag.id);
        }
        if (mountedRef.current) setProgress({ ok, queued, failed });
      }
    } finally {
      operationRef.current = false;
    }
    if (!mountedRef.current) return;
    if (conflict) {
      try {
        await onConflict?.();
      } catch {
        // The failed ids remain selected; the operator can retry refresh.
      }
    }
    if (!mountedRef.current) return;
    setSubmitting(false);
    if (failed > 0) {
      setFailedIds(nextFailedIds);
      onRetainSelection?.(nextFailedIds);
      toast.error(
        `Server-confirmed ${ok}, pending sync ${queued}, failed ${failed}. Only failed tags remain selected for retry.`,
      );
      return;
    }
    setFailedIds([]);
    if (queued > 0) {
      toast.info({
        message: `${queued} tag ${queued === 1 ? "change" : "changes"} saved on this device · pending sync`,
        detail: `${ok} ${ok === 1 ? "change was" : "changes were"} confirmed by the server.`,
      });
    } else {
      toast.success(`Updated ${ok} tag${ok === 1 ? "" : "s"}`);
    }
    onApplied();
  };

  return (
    <Modal
      open={open}
      onClose={() => (submitting ? null : onClose())}
      title={`Edit ${tags.length} tag${tags.length === 1 ? "" : "s"}`}
      description="Tick a field to include it in the patch. Untouched fields stay as-is on each tag."
    >
      <div className="field">
        <label
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            marginBottom: 8,
          }}
        >
          <input
            type="checkbox"
            checked={applyColor}
            onChange={(e) => setApplyColor(e.target.checked)}
            disabled={submitting}
          />
          <span style={{ fontWeight: 600 }}>Set colour</span>
        </label>
        <div
          role="radiogroup"
          aria-label="Tag colour"
          className="tag-palette"
          style={{
            opacity: applyColor ? 1 : 0.4,
            pointerEvents: applyColor ? "auto" : "none",
          }}
        >
          {TAG_PALETTE.map((p) => {
            const active = color === p.id;
            return (
              <button
                key={p.id}
                type="button"
                role="radio"
                aria-checked={active}
                className={`tag-swatch-btn${active ? " is-active" : ""}`}
                style={{ background: p.bg }}
                onClick={() => setColor(p.id)}
                aria-label={p.label}
                disabled={!applyColor || submitting}
              />
            );
          })}
        </div>
      </div>

      <div className="field">
        <label
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            marginBottom: 8,
          }}
        >
          <input
            type="checkbox"
            checked={applyDesc}
            onChange={(e) => setApplyDesc(e.target.checked)}
            disabled={submitting}
          />
          <span style={{ fontWeight: 600 }}>Set description</span>
        </label>
        <textarea
          className="input"
          rows={3}
          value={description}
          onChange={(e) =>
            setDescription(
              limitRunes(e.target.value, TAG_DESCRIPTION_MAX_RUNES),
            )
          }
          placeholder="What does this tag mean? Who should get it?"
          disabled={!applyDesc || submitting}
        />
        <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
          {runeLength(description).toLocaleString()} / 1,024. An empty
          description clears it on every selected tag.
        </div>
      </div>

      {submitting ? (
        <div className="notice" style={{ marginTop: 8, fontSize: 12 }}>
          Updating… {progress.ok + progress.queued + progress.failed} of{" "}
          {targets.length} ({progress.ok} confirmed, {progress.queued} pending
          sync, {progress.failed} failed)
        </div>
      ) : null}

      {!submitting && failedIds.length > 0 ? (
        <div className="notice notice-danger" role="alert">
          {failedIds.length} tag{failedIds.length === 1 ? "" : "s"} failed.
          Review the connection, then retry only those tags.
        </div>
      ) : null}

      <ModalFooter>
        <button
          type="button"
          className="btn"
          onClick={onClose}
          disabled={submitting}
        >
          Cancel
        </button>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => void submit()}
          disabled={submitting || !canApply}
        >
          {submitting
            ? "Applying…"
            : failedIds.length > 0
              ? `Retry ${targets.length} failed tag${targets.length === 1 ? "" : "s"}`
              : `Apply to ${targets.length} tag${targets.length === 1 ? "" : "s"}`}
        </button>
      </ModalFooter>
    </Modal>
  );
}
