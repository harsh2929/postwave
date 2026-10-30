import {
  type RefObject,
  useEffect,
  useRef,
} from "react";

import {
  isolateDialogBackground,
  lockDocumentBodyScroll,
} from "../lib/dialog-accessibility";
import { popDialog, pushDialog } from "../lib/dialogStack";
import { useDialogStack } from "./useDialogStack";

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export interface OnboardingDialogBehaviorOptions {
  open: boolean;
  suspended: boolean;
  ownerId: string;
  dialogRef: RefObject<HTMLElement | null>;
  initialFocusRef?: RefObject<HTMLElement | null>;
  focusSignal?: string | number;
  onEscape: () => void;
}

export function useOnboardingDialogBehavior(
  options: OnboardingDialogBehaviorOptions,
): { isTop: boolean } {
  const { isTop } = useDialogStack(options.ownerId);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!options.open) return;
    pushDialog(options.ownerId);
    previousFocusRef.current = document.activeElement as HTMLElement | null;
    return () => {
      popDialog(options.ownerId);
      const previous = previousFocusRef.current;
      previousFocusRef.current = null;
      queueMicrotask(() => {
        if (previous?.isConnected) previous.focus();
      });
    };
  }, [options.open, options.ownerId]);

  useEffect(() => {
    if (options.suspended || !options.open || !options.dialogRef.current) return;
    const restoreBackground = isolateDialogBackground(options.dialogRef.current);
    const restoreScroll = lockDocumentBodyScroll();
    return () => {
      restoreScroll();
      restoreBackground();
    };
  }, [options.dialogRef, options.open, options.suspended]);

  useEffect(() => {
    if (options.suspended || !options.open || !options.dialogRef.current) return;
    const requested = options.initialFocusRef?.current;
    const target =
      (requested && options.dialogRef.current.contains(requested)
        ? requested
        : null) ??
      options.dialogRef.current.querySelector<HTMLElement>(FOCUSABLE_SELECTOR) ??
      options.dialogRef.current;
    target.focus();
  }, [
    options.dialogRef,
    options.focusSignal,
    options.initialFocusRef,
    options.open,
    options.suspended,
  ]);

  useEffect(() => {
    if (!options.suspended || !options.dialogRef.current) return;
    const active = document.activeElement as HTMLElement | null;
    if (!active || !options.dialogRef.current.contains(active)) return;
    document
      .querySelector<HTMLElement>(
        '[data-critical-notice="true"] button:not([disabled])',
      )
      ?.focus();
  }, [options.dialogRef, options.suspended]);

  useEffect(() => {
    if (options.suspended || !options.open || !isTop) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.isComposing || event.keyCode === 229) return;
      if (event.key === "Escape") {
        event.preventDefault();
        options.onEscape();
        return;
      }
      if (event.key !== "Tab" || !options.dialogRef.current) return;
      const focusable = Array.from(
        options.dialogRef.current.querySelectorAll<HTMLElement>(
          FOCUSABLE_SELECTOR,
        ),
      ).filter(
        (element) =>
          !element.hasAttribute("data-trap-skip") &&
          !element.hidden &&
          !element.closest('[aria-hidden="true"], [inert]'),
      );
      if (focusable.length === 0) {
        event.preventDefault();
        options.dialogRef.current.focus();
        return;
      }
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      const active = document.activeElement as HTMLElement | null;
      if (
        event.shiftKey &&
        (active === first || !options.dialogRef.current.contains(active))
      ) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    isTop,
    options.dialogRef,
    options.onEscape,
    options.open,
    options.suspended,
  ]);

  return { isTop };
}
