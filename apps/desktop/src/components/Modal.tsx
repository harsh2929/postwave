/**
 * Reusable modal/dialog. Native-feeling: Esc closes, click outside closes,
 * focus traps inside while open, slides down with a 120ms ease.
 *
 * Registers itself with the global dialog stack so a slideover hosting
 * this Modal automatically defers its own Esc handler — no manual
 * `disableEscape` flag needed at the call site.
 *
 * Usage:
 *   <Modal open={...} onClose={...} title="New campaign">
 *     <body content />
 *     <ModalFooter>
 *       <button>Cancel</button>
 *       <button>Save</button>
 *     </ModalFooter>
 *   </Modal>
 */
import {
  type ReactElement,
  type ReactNode,
  type RefObject,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
} from "react";

import { useDialogStack } from "../hooks/useDialogStack";
import {
  isolateDialogBackground,
  lockDocumentBodyScroll,
} from "../lib/dialog-accessibility";
import { pushDialog, popDialog } from "../lib/dialogStack";

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: ReactNode;
  /**
   * Width preset. Defaults to "md" (the historical 560px max-width).
   * Maps to a `pw-modal-${size}` className — width tokens live in
   * styles.css next to `.modal-card`.
   */
  size?: "sm" | "md" | "lg" | "xl";
  /** Element that receives focus after the dialog opens. */
  initialFocusRef?: RefObject<HTMLElement | null>;
  /** Re-apply `initialFocusRef` when an in-place dialog step changes. */
  focusKey?: string | number;
  /** Explicit return target when opening the dialog itself may blur the trigger. */
  returnFocusRef?: RefObject<HTMLElement | null>;
  /** Disable for high-consequence dialogs where an outside click is unsafe. */
  closeOnBackdrop?: boolean;
  /** Disable while an operation is in flight or dismissal would lose work. */
  closeOnEscape?: boolean;
  /** Disable the visible title-bar close control while dismissal is unsafe. */
  closeDisabled?: boolean;
  /** Alert dialogs are reserved for decisions that require immediate attention. */
  role?: "dialog" | "alertdialog";
}

/* Tab-trap selector — extracted so the focus-trap handler below reads
 * cleanly. */
const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  size = "md",
  initialFocusRef,
  focusKey,
  closeOnBackdrop = true,
  closeOnEscape = true,
  closeDisabled = false,
  role = "dialog",
  returnFocusRef,
}: ModalProps): ReactElement | null {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const returnTargetRef = useRef<HTMLElement | null>(null);
  const openCycleActiveRef = useRef(false);
  const id = useId();
  const titleId = useId();
  const descriptionId = useId();
  const { isTop } = useDialogStack(id);

  /* Capture the opener once per real open cycle, before passive focus effects
   * move focus into the dialog. Keeping this outside the isolation effect is
   * important in React StrictMode: its setup/cleanup rehearsal must not replace
   * the opener with an element inside the still-open dialog. */
  useLayoutEffect(() => {
    if (open && !openCycleActiveRef.current) {
      returnTargetRef.current = document.activeElement as HTMLElement | null;
      openCycleActiveRef.current = true;
    } else if (!open) {
      openCycleActiveRef.current = false;
    }
  }, [open]);

  /* Stack registration. The id lives for the component's lifetime; we
   * only push/pop based on `open`. */
  useEffect(() => {
    if (!open) return;
    pushDialog(id);
    return () => popDialog(id);
  }, [open, id]);

  /* Focusables are queried fresh on every Tab press — multi-step
   * modals swap their entire body between steps, so any cached list
   * would trap focus against detached nodes. The query is a cheap
   * subtree scan (<1ms for even the API Playground's endpoint list);
   * it only runs while a modal is open AND the user presses Tab. */
  function getFocusables(): HTMLElement[] {
    if (!dialogRef.current) return [];
    return Array.from(
      dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
    ).filter(
      (el) =>
        !el.hasAttribute("data-trap-skip") &&
        !el.hidden &&
        !el.closest('[aria-hidden="true"], [inert]'),
    );
  }

  /* Esc → close (only when top-of-stack) · Tab/Shift+Tab → focus trap */
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === "Escape") {
        if (!isTop || !closeOnEscape) return;
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key !== "Tab" || !dialogRef.current) return;
      const focusable = getFocusables();
      if (focusable.length === 0) {
        e.preventDefault();
        dialogRef.current.focus();
        return;
      }
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      const active = document.activeElement as HTMLElement | null;
      if (
        e.shiftKey &&
        (active === first || !dialogRef.current.contains(active))
      ) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose, isTop, closeOnEscape]);

  /* Preserve the trigger, lock background scroll, and isolate every sibling
   * outside the active dialog. Cleanup restores the exact prior values. */
  useEffect(() => {
    if (!open || !dialogRef.current) return;
    const restoreBackground = isolateDialogBackground(dialogRef.current);
    const restoreScroll = lockDocumentBodyScroll();
    const capturedReturnTarget = returnTargetRef.current;
    return () => {
      restoreScroll();
      restoreBackground();
      queueMicrotask(() => {
        const returnTarget = returnFocusRef?.current ?? capturedReturnTarget;
        if (
          returnTarget?.isConnected &&
          !returnTarget.closest('[aria-hidden="true"], [inert]')
        ) {
          returnTarget.focus();
        }
      });
    };
  }, [open, returnFocusRef]);

  /* On open: focus the first focusable INSIDE the body. We skip the
   * modal-close button (which would be the first descendant) so Enter
   * doesn't dismiss the modal immediately for keyboard users. Fall
   * back to the close button only if the body has nothing focusable. */
  useEffect(() => {
    if (!open || !dialogRef.current) return;
    const body = dialogRef.current.querySelector<HTMLElement>(".modal-body");
    const selector =
      "input:not([disabled]), textarea:not([disabled]), select:not([disabled]), button:not([disabled]):not(.modal-close), [tabindex]:not([tabindex='-1'])";
    const requestedTarget = initialFocusRef?.current;
    const target =
      (requestedTarget && dialogRef.current.contains(requestedTarget)
        ? requestedTarget
        : null) ??
      body?.querySelector<HTMLElement>(selector) ??
      dialogRef.current.querySelector<HTMLElement>(selector) ??
      dialogRef.current;
    target.focus();
  }, [open, initialFocusRef, focusKey]);

  if (!open) return null;
  return (
    <div
      className="modal-backdrop"
      onPointerDown={(e) => {
        if (closeOnBackdrop && isTop && e.target === e.currentTarget) onClose();
      }}
      role="presentation"
    >
      <div
        ref={dialogRef}
        className={`modal-card pw-modal-${size}`}
        role={role}
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        tabIndex={-1}
      >
        <header className="modal-header">
          <h2 id={titleId} className="modal-title">
            {title}
          </h2>
          {description ? (
            <p id={descriptionId} className="modal-description">
              {description}
            </p>
          ) : null}
          <button
            type="button"
            className="modal-close"
            onClick={onClose}
            disabled={closeDisabled}
            aria-label="Close"
          >
            ✕
          </button>
        </header>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}

export function ModalFooter({
  children,
}: {
  children: ReactNode;
}): ReactElement {
  return <footer className="modal-footer">{children}</footer>;
}
