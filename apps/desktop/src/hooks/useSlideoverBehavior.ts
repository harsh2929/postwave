/**
 * useSlideoverBehavior — standard Escape-key, focus-trap, and
 * body-scroll-lock for slideover panels, with automatic deferral when
 * a higher-priority dialog (typically a nested Modal) is on top of the
 * dialog stack.
 *
 * Each existing slideover (CampaignDetailSlideover, AuditEventSlideover,
 * etc.) opts in via this hook and gets uniform chrome behavior:
 *
 *   useSlideoverBehavior({ open, onClose });
 *
 * Pass `disableScrollLock` to opt out of body scroll lock (useful for
 * slideovers that render side-by-side with their parent surface).
 *
 * `disableEscape` is supported for legacy callers but is rarely needed
 * now — the dialog stack handles nested-modal deferral automatically.
 */

import {
  type RefObject,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
} from "react";

import { useDialogStack } from "./useDialogStack";
import {
  isolateDialogBackground,
  lockDocumentBodyScroll,
} from "../lib/dialog-accessibility";
import { pushDialog, popDialog } from "../lib/dialogStack";

interface Options {
  open: boolean;
  onClose: () => void;
  dialogRef?: RefObject<HTMLElement | null>;
  /** Top-level layer containing both scrim and panel for background isolation. */
  isolationRef?: RefObject<HTMLElement | null>;
  initialFocusRef?: RefObject<HTMLElement | null>;
  /** Explicit opener owned by a non-lazy boundary. */
  returnFocusRef?: RefObject<HTMLElement | null>;
  disableScrollLock?: boolean;
  /** Disable the Esc handler unconditionally. Almost never needed —
   *  the dialog stack handles nested-modal deferral on its own. */
  disableEscape?: boolean;
}

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

const UNCONTROLLED_SLIDEOVER_SELECTOR =
  '.slideover[role="dialog"][aria-modal="true"]';

export function useSlideoverBehavior({
  open,
  onClose,
  dialogRef,
  isolationRef,
  initialFocusRef,
  returnFocusRef,
  disableScrollLock,
  disableEscape,
}: Options): void {
  const id = useId();
  const { isTop } = useDialogStack(id);
  const uncontrolledDialogRef = useRef<HTMLElement | null>(null);
  const capturedReturnFocusRef = useRef<HTMLElement | null>(null);

  function getDialog(): HTMLElement | null {
    return dialogRef?.current ?? uncontrolledDialogRef.current;
  }

  function getFocusables(): HTMLElement[] {
    const dialog = getDialog();
    if (!dialog) return [];
    return Array.from(
      dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
    ).filter(
      (el) =>
        !el.hasAttribute("data-trap-skip") &&
        !el.hidden &&
        !el.closest('[aria-hidden="true"], [inert]'),
    );
  }

  /* Register on the global dialog stack while open. */
  useEffect(() => {
    if (!open) return;
    pushDialog(id);
    return () => popDialog(id);
  }, [open, id]);

  /* Associate the hook with its rendered panel. SlideoverShell passes a
   * ref; legacy callers fall back to the first unclaimed slideover. */
  useEffect(() => {
    if (!open) return;
    if (dialogRef) {
      const dialog = dialogRef.current;
      if (!dialog) return;
      dialog.dataset.slideoverBehaviorId = id;
      return () => {
        if (dialog.dataset.slideoverBehaviorId === id) {
          delete dialog.dataset.slideoverBehaviorId;
        }
      };
    }
    if (typeof document === "undefined") return;
    const existing = uncontrolledDialogRef.current;
    if (existing?.isConnected) return;
    const dialogs = Array.from(
      document.querySelectorAll<HTMLElement>(UNCONTROLLED_SLIDEOVER_SELECTOR),
    );
    const dialog =
      dialogs.find((el) => el.dataset.slideoverBehaviorId === id) ??
      dialogs.find((el) => !el.dataset.slideoverBehaviorId) ??
      dialogs[dialogs.length - 1] ??
      null;
    if (!dialog) return;
    uncontrolledDialogRef.current = dialog;
    dialog.dataset.slideoverBehaviorId = id;
    return () => {
      if (dialog.dataset.slideoverBehaviorId === id) {
        delete dialog.dataset.slideoverBehaviorId;
      }
      if (uncontrolledDialogRef.current === dialog) {
        uncontrolledDialogRef.current = null;
      }
    };
  }, [open, dialogRef, id]);

  /* Esc → close, but only if this slideover is currently top-of-stack
   * (i.e. no nested Modal is open above it). Tab/Shift+Tab stay inside
   * the current panel, matching the Modal keyboard model. */
  useEffect(() => {
    if (!open || !isTop) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === "Escape") {
        if (disableEscape) return;
        e.preventDefault();
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== "Tab") return;
      const dialog = getDialog();
      if (!dialog) return;
      const focusable = getFocusables();
      if (focusable.length === 0) {
        e.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      const active = document.activeElement as HTMLElement | null;
      if (!active || !dialog.contains(active)) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      } else if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose, disableEscape, isTop]);

  /* Body scroll lock — prevents the background page from scrolling
   * while the slideover is open. Restores previous value on unmount. */
  useEffect(() => {
    if (!open || disableScrollLock) return;
    return lockDocumentBodyScroll();
  }, [open, disableScrollLock]);

  /* Focus restoration — capture whatever owned focus when the
   * slideover opened, restore it when it closes. Keyboard operators
   * who tabbed to a row and pressed Enter expect focus to return to
   * that row, not be lost to the body. This must run before the passive
   * background-isolation effect: applying `inert` may synchronously blur the
   * opener in Chromium, which would otherwise make us capture `<body>`. */
  useLayoutEffect(() => {
    if (!open) return;
    capturedReturnFocusRef.current =
      returnFocusRef?.current ?? (document.activeElement as HTMLElement | null);
  }, [open, returnFocusRef]);

  /* Restore from a passive cleanup declared before background isolation.
   * React runs the isolation cleanup in the same passive flush; the queued
   * microtask therefore executes only after `inert` has been removed. */
  useEffect(() => {
    if (!open) return;
    const previouslyFocused = capturedReturnFocusRef.current;
    return () => {
      /* In a microtask so the DOM has settled after the slideover
       * unmounts before we try to focus. */
      queueMicrotask(() => {
        if (previouslyFocused?.isConnected) previouslyFocused.focus();
      });
    };
  }, [open]);

  /* Remove the application behind the active layer from pointer, keyboard,
   * and accessibility-tree navigation. The layer wrapper keeps the scrim
   * interactive while the rest of the root becomes inert. */
  useEffect(() => {
    if (!open) return;
    const surface = isolationRef?.current ?? getDialog();
    if (!surface) return;
    return isolateDialogBackground(surface);
  }, [open, isolationRef]);

  /* Move focus into the body on open, skipping the chrome close button
   * unless the body has no focusable controls. */
  useEffect(() => {
    if (!open) return;
    const dialog = getDialog();
    if (!dialog) return;
    const body = dialog.querySelector<HTMLElement>(".slideover-body");
    const selector =
      "input:not([disabled]), textarea:not([disabled]), select:not([disabled]), button:not([disabled]):not(.slideover-close), [tabindex]:not([tabindex='-1'])";
    const requestedTarget = initialFocusRef?.current;
    const target =
      (requestedTarget && dialog.contains(requestedTarget)
        ? requestedTarget
        : null) ??
      body?.querySelector<HTMLElement>(selector) ??
      dialog.querySelector<HTMLElement>(selector) ??
      dialog;
    target?.focus();
  }, [open, initialFocusRef]);
}
