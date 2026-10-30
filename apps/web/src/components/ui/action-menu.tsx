// SPDX-License-Identifier: AGPL-3.0-only
"use client";

//
// Lightweight, dependency-free overflow ("kebab") menu. The app ships no Radix
// DropdownMenu, so this provides ONE accessible pattern for per-row action
// menus (FORM-013): a trigger button that toggles a popover of `menuitem`
// buttons, closes on outside-click / Escape / selection, and moves focus with
// the arrow keys. Positioned relative to a wrapping element the caller marks.

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type Ref,
  type ReactNode,
} from "react";
import { MoreHorizontal } from "lucide-react";

import { IconButton } from "@/components/ui/icon-button";
import { cn } from "@/lib/utils";

export interface ActionMenuItem {
  label: string;
  onSelect: () => void;
  icon?: ReactNode;
  /** Renders in the destructive tint and is separated from the group above. */
  destructive?: boolean;
  disabled?: boolean;
}

interface ActionMenuProps {
  items: ActionMenuItem[];
  /** Accessible name for the trigger, e.g. `Actions for Newsletter`. */
  label: string;
  align?: "start" | "end";
  triggerClassName?: string;
  /**
   * Exposes the stable trigger to a follow-on dialog so that closing the
   * dialog can return keyboard focus to the control that launched the action.
   */
  triggerRef?: Ref<HTMLButtonElement>;
}

function assignRef<T>(ref: Ref<T> | undefined, node: T | null) {
  if (typeof ref === "function") {
    ref(node);
  } else if (ref) {
    (ref as { current: T | null }).current = node;
  }
}

export function ActionMenu({
  items,
  label,
  align = "end",
  triggerClassName,
  triggerRef: forwardedTriggerRef,
}: ActionMenuProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const internalTriggerRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();

  const setTriggerRef = useCallback(
    (node: HTMLButtonElement | null) => {
      internalTriggerRef.current = node;
      assignRef(forwardedTriggerRef, node);
    },
    [forwardedTriggerRef],
  );

  const close = useCallback(() => setOpen(false), []);

  /**
   * Close and hand focus back to the trigger. Opening moves focus INTO the
   * popover, so closing without this drops `document.activeElement` to <body>
   * and a keyboard user loses their place in the row list entirely.
   *
   * Focus is restored SYNCHRONOUSLY, before any follow-on action runs, so an
   * item that opens a dialog can still claim focus afterwards — a deferred
   * (rAF/timeout) restore would land after the dialog and steal it back.
   */
  const closeAndRestore = useCallback(() => {
    setOpen(false);
    internalTriggerRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    // Outside-click deliberately does NOT restore: attention has already moved
    // elsewhere, and pulling focus back would fight the user.
    const onDocClick = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        closeAndRestore();
        return;
      }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const nodes = Array.from(
          menuRef.current?.querySelectorAll<HTMLButtonElement>(
            '[role="menuitem"]:not([disabled])',
          ) ?? [],
        );
        if (nodes.length === 0) return;
        const idx = nodes.indexOf(document.activeElement as HTMLButtonElement);
        const nextIdx =
          e.key === "ArrowDown"
            ? (idx + 1) % nodes.length
            : (idx - 1 + nodes.length) % nodes.length;
        nodes[nextIdx]?.focus();
      }
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    // Focus the first item when the menu opens.
    const first = menuRef.current?.querySelector<HTMLButtonElement>(
      '[role="menuitem"]:not([disabled])',
    );
    first?.focus();
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, close, closeAndRestore]);

  return (
    <div ref={rootRef} className="relative inline-block text-left">
      <IconButton
        ref={setTriggerRef}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        size="sm"
        className={triggerClassName}
        onClick={() => setOpen((v) => !v)}
      >
        <MoreHorizontal className="h-4 w-4" />
      </IconButton>
      {open ? (
        <div
          ref={menuRef}
          id={menuId}
          role="menu"
          aria-label={label}
          data-slot="action-menu"
          className={cn(
            "absolute z-20 mt-1 min-w-44 rounded-[10px_14px_10px_14px] border border-mw-ink/25 bg-mw-paper p-1.5 shadow-[4px_5px_0_rgb(32_32_30_/_0.16)]",
            align === "end" ? "right-0" : "left-0",
          )}
        >
          {items.map((item, i) => {
            const prevDestructive = i > 0 && items[i - 1].destructive;
            return (
              <div key={`${item.label}-${i}`}>
                {item.destructive && !prevDestructive ? (
                  <div className="my-1 h-px bg-border" role="separator" />
                ) : null}
                <button
                  type="button"
                  role="menuitem"
                  disabled={item.disabled}
                  onClick={() => {
                    closeAndRestore();
                    item.onSelect();
                  }}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-sm px-2.5 py-1.5 text-left text-sm",
                    "focus-visible:outline-none focus:bg-mw-pink-soft hover:bg-mw-pink-soft",
                    "disabled:cursor-not-allowed disabled:opacity-50",
                    item.destructive
                      ? "text-destructive hover:text-destructive focus:text-destructive"
                      : "text-foreground",
                  )}
                >
                  {item.icon ? (
                    <span className="text-muted-foreground [button:hover>&]:text-inherit">
                      {item.icon}
                    </span>
                  ) : null}
                  {item.label}
                </button>
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
