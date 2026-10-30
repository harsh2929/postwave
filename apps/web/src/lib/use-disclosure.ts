// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useEffect, type MutableRefObject } from "react";

import { firstFocusable } from "@/lib/focus-trap";

/**
 * Shared open/close plumbing for header disclosures (notification popover,
 * workspace/account/create menus). Wires Escape-to-close with focus restore,
 * outside-pointer-close, and — when `focusPanelOnOpen` is set — moves focus
 * into the panel on open. Extracted so the notification bell and the header
 * menus share ONE accessible disclosure substrate instead of hand-rolling
 * three divergent copies (SHELL-005/006).
 */
export function useDisclosure({
  open,
  setOpen,
  triggerRef,
  panelRef,
  focusPanelOnOpen = false,
}: {
  open: boolean;
  setOpen: (open: boolean) => void;
  triggerRef: MutableRefObject<HTMLElement | null>;
  panelRef: MutableRefObject<HTMLElement | null>;
  /** Move focus into the panel's first focusable node on open. */
  focusPanelOnOpen?: boolean;
}): void {
  useEffect(() => {
    if (!open) return;

    function closeAndRestore(): void {
      setOpen(false);
      requestAnimationFrame(() => triggerRef.current?.focus());
    }

    if (focusPanelOnOpen) {
      requestAnimationFrame(() => {
        const target = firstFocusable(panelRef.current);
        target?.focus({ preventScroll: true });
      });
    }

    function onKeyDown(event: KeyboardEvent): void {
      if (event.key !== "Escape") return;
      event.preventDefault();
      closeAndRestore();
    }

    function onPointerDown(event: PointerEvent): void {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (triggerRef.current?.contains(target)) return;
      if (panelRef.current?.contains(target)) return;
      setOpen(false);
    }

    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [open, panelRef, triggerRef, setOpen, focusPanelOnOpen]);
}
