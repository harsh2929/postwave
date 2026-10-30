/**
 * ConfirmModal — drop-in replacement for `window.confirm()`.
 *
 * Three reasons we replaced native confirms across the admin surface:
 *
 *   1. UI consistency — native dialogs look 1998 next to the rest of
 *      the desktop shell.
 *   2. Focus + keyboard — the underlying `Modal` component traps focus,
 *      handles Esc, and closes on backdrop click.
 *   3. Audit-grade ceremony — destructive confirms can carry rich
 *      descriptions, ranked danger styling, and (where set) a
 *      type-to-confirm input that protects against the "two clicks
 *      from one accident" failure mode.
 *
 * Two modes:
 *
 *   - Plain confirm: pass `title`, `description`, `onConfirm`. Confirm
 *     button is enabled immediately.
 *
 *   - Type-to-confirm: also pass `typeToConfirm` (the exact string
 *     the operator must paste). Confirm button stays disabled until
 *     the input matches.
 *
 * The component is intentionally lightweight — pages own the open
 * state and the action that runs on confirm. We don't try to be a
 * router or a dialog stack.
 */
import {
  type ReactElement,
  type ReactNode,
  type RefObject,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";

import { Modal, ModalFooter } from "./Modal";

export interface ConfirmModalProps {
  open: boolean;
  /** Headline rendered in the Modal title bar. */
  title: string;
  /** Short subtitle under the title — context for the action. */
  description?: string;
  /** Body content — accepts JSX so callers can render rich previews. */
  children?: ReactNode;
  /** Label for the confirm button. Defaults to "Confirm". */
  confirmLabel?: string;
  /** Label for the cancel button. Defaults to "Cancel". */
  cancelLabel?: string;
  /** Renders the confirm button in danger styling. Default false. */
  danger?: boolean;
  /**
   * When set, the confirm button stays disabled until the operator
   * types this exact string. Use for irreversible destructive ops
   * (delete sink, revoke token, delete account).
   */
  typeToConfirm?: string;
  /** Fired when the user clicks Confirm (after type-match if any). */
  onConfirm: () => void | Promise<void>;
  /** Fired on Cancel / Esc / backdrop click. */
  onClose: () => void;
  /** When true, both buttons are disabled (in-flight network call). */
  busy?: boolean;
  /** Domain validation may disable confirmation while leaving review usable. */
  confirmDisabled?: boolean;
  /** Override the safe cancel-button focus for long, review-first dialogs. */
  initialFocusRef?: RefObject<HTMLElement | null>;
  /** Explicit focus target restored after the confirmation closes. */
  returnFocusRef?: RefObject<HTMLElement | null>;
}

export function ConfirmModal({
  open,
  title,
  description,
  children,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  danger,
  typeToConfirm,
  onConfirm,
  onClose,
  busy,
  confirmDisabled: domainConfirmDisabled = false,
  initialFocusRef,
  returnFocusRef,
}: ConfirmModalProps): ReactElement | null {
  const [typed, setTyped] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const confirmingRef = useRef(false);
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const typeLabelId = useId();
  const typeInputId = useId();

  useEffect(() => {
    setTyped("");
    confirmingRef.current = false;
    setConfirming(false);
    setConfirmError(null);
  }, [open, title, typeToConfirm]);

  if (!open) return null;
  const needsType =
    typeof typeToConfirm === "string" && typeToConfirm.length > 0;
  const typeMatches = needsType ? typed === typeToConfirm : true;
  const isBusy = !!busy || confirming;
  const confirmDisabled = isBusy || !typeMatches || domainConfirmDisabled;

  const close = (): void => {
    if (!isBusy) onClose();
  };

  const confirm = async (): Promise<void> => {
    if (confirmDisabled || confirmingRef.current) return;
    confirmingRef.current = true;
    setConfirming(true);
    setConfirmError(null);
    try {
      await onConfirm();
    } catch {
      setConfirmError("The action couldn't be completed. Try again.");
    } finally {
      confirmingRef.current = false;
      setConfirming(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={close}
      title={title}
      description={description}
      role={danger || needsType ? "alertdialog" : "dialog"}
      initialFocusRef={initialFocusRef ?? cancelRef}
      returnFocusRef={returnFocusRef}
      closeOnBackdrop={!danger && !needsType && !isBusy}
      closeOnEscape={!isBusy}
      closeDisabled={isBusy}
    >
      {children}
      {needsType ? (
        <div style={{ marginTop: children ? 12 : 0 }}>
          <p id={typeLabelId} style={{ fontSize: 13, margin: "0 0 6px" }}>
            Type <strong>{typeToConfirm}</strong> to confirm.
          </p>
          <input
            id={typeInputId}
            type="text"
            value={typed}
            onChange={(e) => {
              setTyped(e.target.value);
              setConfirmError(null);
            }}
            placeholder={typeToConfirm}
            autoComplete="off"
            aria-labelledby={typeLabelId}
            aria-invalid={confirmError ? "true" : undefined}
            spellCheck={false}
          />
        </div>
      ) : null}
      {confirmError ? (
        <p className="field-error" role="alert">
          {confirmError}
        </p>
      ) : null}
      <ModalFooter>
        <button
          ref={cancelRef}
          type="button"
          className="btn"
          onClick={close}
          disabled={isBusy}
        >
          {cancelLabel}
        </button>
        <button
          type="button"
          className={danger ? "btn btn-danger" : "btn btn-primary"}
          onClick={() => void confirm()}
          disabled={confirmDisabled}
          aria-busy={isBusy ? "true" : undefined}
        >
          {isBusy ? "Working…" : confirmLabel}
        </button>
      </ModalFooter>
    </Modal>
  );
}
