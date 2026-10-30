/**
 * RegisterOrphanModal — promote an orphan tag (one that's applied to
 * subscribers but never entered the canonical registry) into a first-
 * class registered Tag with a colour + description. Refined Tags PR 2.
 *
 * The tag NAME is read-only (it's already in use on subscribers; we're
 * just backfilling the registry row). Color and description are
 * editable. On submit we POST /api/v1/tags with the original name —
 * the Go handler conflict-checks by name, so re-registering the same
 * orphan twice is harmless.
 */

import {
  type ReactElement,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import { api } from "../../lib/api-client";
import { queueReceiptMessage } from "../../lib/api/result";
import { Modal, ModalFooter } from "../Modal";
import { ConfirmModal } from "../ConfirmModal";
import { toast } from "../Toast";
import { registerLifecycleGuard } from "../../lib/lifecycle-coordinator";
import { isTag } from "./tagRemoteValidation";
import { TAG_PALETTE } from "./tagColorPresentation";
import {
  TAG_DESCRIPTION_MAX_RUNES,
  limitRunes,
  normalizedNewTagName,
  runeLength,
} from "./tagWriteConstraints";

interface Props {
  /** Orphan tag name to register. Null = modal closed. */
  name: string | null;
  /** Subscriber count for the orphan — shown so the operator knows
   *  what they're about to formalise. */
  subscriberCount: number | null;
  onClose: () => void;
  /** Fired after a successful register; parent refreshes its lists. */
  onRegistered: (name: string) => void;
}

export function RegisterOrphanModal({
  name,
  subscriberCount,
  onClose,
  onRegistered,
}: Props): ReactElement {
  const [color, setColor] = useState<string>("slate");
  const [description, setDescription] = useState<string>("");
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [discardConfirmOpen, setDiscardConfirmOpen] = useState(false);
  const mountedRef = useRef(true);
  const operationRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Reset whenever a new orphan is being registered so previous
  // edits don't leak between sessions.
  useEffect(() => {
    if (!name) return;
    setColor("slate");
    setDescription("");
    setErr(null);
    setSubmitting(false);
    setDiscardConfirmOpen(false);
    operationRef.current = false;
  }, [name]);

  const dirty = color !== "slate" || description !== "";
  const normalizedName = name ? normalizedNewTagName(name) : null;
  const submit = useCallback(async (): Promise<void> => {
    if (!name || !normalizedName || operationRef.current) return;
    operationRef.current = true;
    setSubmitting(true);
    setErr(null);
    try {
      const result = await api.createTag({
        name: normalizedName,
        color,
        description,
      });
      if (!mountedRef.current) return;
      if (result.error) {
        setErr(result.error.message);
        return;
      }
      if (result.queued) {
        toast.info({
          message: queueReceiptMessage(result.receipt),
          detail: `“${name}” will appear in the registry after server confirmation.`,
        });
        onClose();
        return;
      }
      if (!isTag(result.data) || result.data.name !== normalizedName) {
        setErr(
          "The server response could not be verified. Refresh the catalogue before retrying.",
        );
        return;
      }
      toast.success(`Registered "${normalizedName}"`);
      onRegistered(normalizedName);
    } catch {
      if (mountedRef.current) {
        setErr(
          "The registration request failed. Check the connection and retry.",
        );
      }
    } finally {
      operationRef.current = false;
      if (mountedRef.current) setSubmitting(false);
    }
  }, [color, description, name, normalizedName, onClose, onRegistered]);

  const requestClose = useCallback((): void => {
    if (operationRef.current) return;
    if (dirty) setDiscardConfirmOpen(true);
    else onClose();
  }, [dirty, onClose]);

  useEffect(() => {
    if (!name || (!dirty && !submitting)) return;
    return registerLifecycleGuard({
      id: `register-orphan-${name}`,
      label: "Orphan tag registration",
      inspect: (intent) =>
        intent.disposition === "hide"
          ? null
          : submitting
            ? {
                level: "blocking",
                detail: "The registration request is still in progress.",
                canDiscard: false,
              }
            : {
                level: "blocking",
                detail: "The registration draft has unsaved changes.",
              },
      prepare: submitting ? undefined : submit,
      discard: () => {
        setColor("slate");
        setDescription("");
        onClose();
      },
    });
  }, [dirty, name, onClose, submit, submitting]);

  return (
    <>
      <Modal
        open={name != null}
        onClose={requestClose}
        closeOnBackdrop={!submitting}
        closeOnEscape={!submitting}
        closeDisabled={submitting}
        title="Register tag"
        description="This tag is already applied to subscribers but doesn't have a catalogue entry yet. Give it a colour and a short description so the rest of the team knows what it means."
      >
        <div className="field">
          <label className="field-label" htmlFor="orphan-tag-name">
            Tag
          </label>
          <input
            id="orphan-tag-name"
            className="input"
            value={name ?? ""}
            disabled
            aria-label="Tag name (read-only)"
          />
          <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
            {subscriberCount === null ? (
              "Subscriber count is unavailable until usage data is verified."
            ) : (
              <>
                Currently applied to{" "}
                <strong className="tabular">
                  {subscriberCount.toLocaleString()}
                </strong>{" "}
                subscriber{subscriberCount === 1 ? "" : "s"}.
              </>
            )}
          </div>
        </div>

        <div className="field">
          <label className="field-label" htmlFor="reg-color">
            Colour
          </label>
          <div
            id="reg-color"
            role="radiogroup"
            aria-label="Tag colour"
            className="tag-palette"
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
                  disabled={submitting}
                />
              );
            })}
          </div>
        </div>

        <div className="field">
          <label className="field-label" htmlFor="reg-desc">
            Description
          </label>
          <textarea
            id="reg-desc"
            className="input"
            rows={3}
            value={description}
            onChange={(e) =>
              setDescription(
                limitRunes(e.target.value, TAG_DESCRIPTION_MAX_RUNES),
              )
            }
            placeholder="What does this tag mean? Who should get it?"
            disabled={submitting}
          />
          <div className="field-help">
            {runeLength(description).toLocaleString()} / 1,024 characters.
          </div>
        </div>

        {name && !normalizedName ? (
          <div className="field-error" role="alert">
            This legacy tag name cannot be registered as a new tag. It must be
            non-blank and no longer than 64 characters.
          </div>
        ) : null}

        {err ? <div className="field-error">{err}</div> : null}

        <ModalFooter>
          <button
            type="button"
            className="btn"
            onClick={requestClose}
            disabled={submitting || !normalizedName}
          >
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void submit()}
            disabled={submitting}
          >
            {submitting ? "Registering…" : "Register tag"}
          </button>
        </ModalFooter>
      </Modal>
      <ConfirmModal
        open={discardConfirmOpen}
        title="Discard registration draft?"
        description="The orphan tag will remain applied to subscribers but will not be registered."
        confirmLabel="Discard draft"
        danger
        onClose={() => setDiscardConfirmOpen(false)}
        onConfirm={() => {
          setDiscardConfirmOpen(false);
          setColor("slate");
          setDescription("");
          onClose();
        }}
      />
    </>
  );
}
