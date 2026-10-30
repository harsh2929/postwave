// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import Link from "next/link";
import type { Route } from "next";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";

import { cn } from "@/lib/utils";
import { trapFocus } from "@/lib/focus-trap";

/**
 * Shared accessible header disclosure backing the hand-rolled header popovers
 * (workspace switcher, account menu, global create) — SHELL-006. One
 * implementation gives all of them the same disclosure-navigation semantics: a
 * `<nav>` landmark of links/buttons (NOT the ARIA menu role, matching the
 * app's established header pattern), roving ArrowUp/Down/Home/End over the
 * items, Tab focus-trap, Escape-to-close with focus restore to the trigger,
 * outside-click dismissal, and close-on-item-activation. No external dependency.
 */

/** Roving-focus index for a vertical item list. Pure + exported for unit tests. */
export function nextMenuIndex(
  key: string,
  index: number,
  total: number,
): number | null {
  if (total <= 0) return null;
  if (key === "ArrowDown") return (index + 1) % total;
  if (key === "ArrowUp") return (index - 1 + total) % total;
  if (key === "Home") return 0;
  if (key === "End") return total - 1;
  return null;
}

const ITEM_SELECTOR = "[data-header-menu-item]";

/**
 * The panel's close callback, for items that are not HeaderMenuLink/Button.
 *
 * Exported so a bespoke item can dismiss the panel the same way the built-in
 * ones do — and so the identity of the published value is directly assertable:
 * it is memoised (see `close` below), and consumers depend on that.
 */
export const HeaderMenuCloseContext = createContext<() => void>(() => {});

export interface HeaderMenuRenderProps {
  open: boolean;
  toggle: () => void;
  triggerRef: (node: HTMLButtonElement | null) => void;
  panelId: string;
  ariaExpanded: boolean;
}

export function HeaderMenu({
  label,
  align = "start",
  panelClassName,
  header,
  children,
  trigger,
}: {
  /** aria-label for the nav landmark. */
  label: string;
  align?: "start" | "end";
  panelClassName?: string;
  /** Non-interactive header block rendered above the items. */
  header?: ReactNode;
  /** The items — use HeaderMenuLink / HeaderMenuButton. */
  children: ReactNode;
  /** Render-prop trigger so each menu keeps its bespoke button. */
  trigger: (props: HeaderMenuRenderProps) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  const closeAndRestore = useCallback(() => {
    setOpen(false);
    requestAnimationFrame(() => triggerRef.current?.focus());
  }, []);

  // Focus the first item on open.
  useEffect(() => {
    if (!open) return;
    requestAnimationFrame(() => {
      panelRef.current
        ?.querySelector<HTMLElement>(ITEM_SELECTOR)
        ?.focus({ preventScroll: true });
    });
  }, [open]);

  // Async branches inside a disclosure can replace their focused control
  // (Retry -> workspace rows, for example) without closing the panel. Browsers
  // otherwise drop focus to <body>. Repair only that orphaned case; deliberate
  // focus outside the panel is left alone and outside-pointer dismissal still
  // owns its normal close path.
  useEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    if (!panel) return;
    const observer = new MutationObserver(() => {
      requestAnimationFrame(() => {
        if (!panel.isConnected || panel.contains(document.activeElement)) {
          return;
        }
        if (document.activeElement !== document.body) return;
        panel
          .querySelector<HTMLElement>(ITEM_SELECTOR)
          ?.focus({ preventScroll: true });
      });
    });
    observer.observe(panel, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [open]);

  // Escape / outside-click.
  useEffect(() => {
    if (!open) return;
    function onKeyDown(event: globalThis.KeyboardEvent): void {
      if (event.key === "Escape") {
        event.preventDefault();
        closeAndRestore();
      }
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
  }, [open, closeAndRestore]);

  const onPanelKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (event.key === "Tab") {
        trapFocus(event.nativeEvent, panelRef.current);
        return;
      }
      if (
        event.key !== "ArrowDown" &&
        event.key !== "ArrowUp" &&
        event.key !== "Home" &&
        event.key !== "End"
      ) {
        return;
      }
      const items = Array.from(
        panelRef.current?.querySelectorAll<HTMLElement>(ITEM_SELECTOR) ?? [],
      );
      if (items.length === 0) return;
      event.preventDefault();
      const current = items.findIndex((el) => el === document.activeElement);
      const next = nextMenuIndex(
        event.key,
        current < 0 ? 0 : current,
        items.length,
      );
      if (next === null) return;
      items[next]?.focus({ preventScroll: true });
    },
    [],
  );

  return (
    <div className="relative">
      {trigger({
        open,
        toggle: () => setOpen((v) => !v),
        triggerRef: (node) => {
          triggerRef.current = node;
        },
        panelId,
        ariaExpanded: open,
      })}
      {open ? (
        <div
          id={panelId}
          ref={panelRef}
          data-header-menu-panel
          data-slot="header-menu"
          onKeyDown={onPanelKeyDown}
          className={cn(
            "fixed inset-x-2 top-16 z-50 mt-0 max-h-[calc(100dvh-4.5rem)] w-auto overflow-y-auto overscroll-contain rounded-[14px_18px_14px_18px] border border-mw-ink/25 bg-mw-paper p-2 text-popover-foreground shadow-[4px_5px_0_rgb(32_32_30_/_0.16)] sm:absolute sm:inset-x-auto sm:top-full sm:mt-2 sm:w-72 max-[359px]:top-[6.5rem] max-[359px]:max-h-[calc(100dvh-7rem)]",
            align === "end" ? "sm:right-0" : "sm:left-0",
            panelClassName,
          )}
        >
          {header ? (
            <>
              <div className="px-2 py-2">{header}</div>
              <div className="my-1 h-px bg-border" />
            </>
          ) : null}
          {/* Item activation removes the focused item from the DOM. Publish the
              same focus-restoring close used by Escape so button actions (theme,
              shortcuts, sign-out) never strand keyboard focus on <body>. The
              callback remains memoised, preserving the context stability
              contract. */}
          <HeaderMenuCloseContext.Provider value={closeAndRestore}>
            <nav aria-label={label}>{children}</nav>
          </HeaderMenuCloseContext.Provider>
        </div>
      ) : null}
    </div>
  );
}

const ITEM_CLASS =
  "flex min-h-11 w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm hover:bg-mw-pink-soft hover:text-mw-blue focus-visible:bg-mw-pink-soft focus-visible:text-mw-blue focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring aria-disabled:pointer-events-none aria-disabled:opacity-50 sm:min-h-9";

export function HeaderMenuLink({
  href,
  onClick,
  children,
}: {
  href: Route;
  onClick?: () => void;
  children: ReactNode;
}) {
  const close = useContext(HeaderMenuCloseContext);
  return (
    <Link
      href={href}
      data-header-menu-item
      onClick={() => {
        onClick?.();
        close();
      }}
      className={ITEM_CLASS}
    >
      {children}
    </Link>
  );
}

export function HeaderMenuButton({
  onClick,
  destructive = false,
  closeOnClick = true,
  busy = false,
  disabled = false,
  children,
}: {
  onClick: () => void;
  destructive?: boolean;
  /** Keep the menu open while an in-panel asynchronous action settles. */
  closeOnClick?: boolean;
  busy?: boolean;
  disabled?: boolean;
  children: ReactNode;
}) {
  const close = useContext(HeaderMenuCloseContext);
  const blocked = busy || disabled;
  return (
    <button
      type="button"
      data-header-menu-item
      aria-busy={busy || undefined}
      aria-disabled={blocked || undefined}
      onClick={() => {
        if (blocked) return;
        if (closeOnClick) close();
        onClick();
      }}
      className={cn(
        ITEM_CLASS,
        destructive &&
          "text-destructive-emphasis hover:bg-destructive/10 focus-visible:bg-destructive/10",
      )}
    >
      {children}
    </button>
  );
}
