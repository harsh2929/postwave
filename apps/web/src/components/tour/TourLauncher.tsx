// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import Link from "next/link";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { BookOpen, Sparkles } from "lucide-react";

import { asRoute } from "@/lib/typed-routes";
import { useTour } from "./TourProvider";

// Real app shortcuts (SHELL-029), not just tour navigation. The
// ["Quick search (in app)", "⌘ K"] tuple is asserted by the shell-integrity
// test — keep it verbatim.
const SHORTCUTS: ReadonlyArray<readonly [string, string]> = [
  ["Quick search (in app)", "⌘ K"],
  ["Open help & shortcuts menu", "⌘ /"],
  ["Show this shortcuts sheet", "?"],
  ["Move through the sidebar", "↑ ↓"],
  ["Jump to first / last nav item", "Home / End"],
  ["Close menus & dialogs", "Esc"],
  ["Advance / go back in the tour", "→ / ←"],
];

const LAUNCHER_CLASS_NAME =
  "fixed bottom-3 right-[18px] z-[60] inline-flex size-11 cursor-pointer items-center justify-center rounded-full border border-white/10 bg-[rgba(15,15,15,0.72)] font-mono text-base font-semibold text-[#fdfcf8] shadow-[0_4px_16px_rgba(15,23,42,0.25)] backdrop-blur-[6px] transition-[transform,background-color] duration-150 ease-out hover:-translate-y-px hover:bg-pw-ember-500 focus-visible:[outline:2px_solid_#c8102e] focus-visible:outline-offset-2 motion-reduce:transition-none max-[480px]:right-3";

const MENU_CLASS_NAME =
  "mw-tour-enter fixed bottom-16 right-[18px] z-[61] w-60 overflow-hidden rounded-xl border border-black/[0.08] bg-[#fdfcf8] text-[#1a1a1a] shadow-[0_18px_40px_rgba(15,23,42,0.3)] motion-reduce:animate-none dark:border-white/10 dark:bg-[#1a1a1a] dark:text-[#f2f0ea] max-[480px]:right-3 max-[480px]:w-[min(240px,calc(100vw-24px))]";

const MENU_ITEM_CLASS_NAME =
  "flex min-h-11 w-full cursor-pointer items-center gap-2.5 border-0 bg-transparent px-3.5 py-2.5 text-left text-[13.5px] text-inherit transition-colors duration-150 ease-out hover:bg-[rgba(200,16,46,0.08)] focus-visible:bg-[rgba(200,16,46,0.1)] focus-visible:outline-none motion-reduce:transition-none";

export function TourLauncher(): JSX.Element {
  const { state, start, replay, hasCompleted } = useTour();
  const [menuOpen, setMenuOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const menuId = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const restoreLauncherFocus = useCallback(() => {
    requestAnimationFrame(() => buttonRef.current?.focus());
  }, []);
  const closeMenu = useCallback(() => {
    setMenuOpen(false);
    restoreLauncherFocus();
  }, [restoreLauncherFocus]);
  const closeShortcuts = useCallback(() => {
    setShortcutsOpen(false);
    restoreLauncherFocus();
  }, [restoreLauncherFocus]);

  // Keyboard: ⌘/Ctrl-+-/ toggles the help menu; a bare "?" (outside inputs)
  // opens the shortcuts sheet (SHELL-029). Other UI (avatar/help menus) can
  // open the sheet by dispatching pw:open-shortcuts (SHELL-024).
  useEffect(() => {
    function isTypingTarget(target: EventTarget | null): boolean {
      const el = target as HTMLElement | null;
      return Boolean(
        el &&
        (el.isContentEditable ||
          el instanceof HTMLInputElement ||
          el instanceof HTMLTextAreaElement ||
          el instanceof HTMLSelectElement),
      );
    }
    function onKey(e: KeyboardEvent): void {
      const isModifier = e.metaKey || e.ctrlKey;
      if (isModifier && (e.key === "/" || e.code === "Slash")) {
        if (state.isOpen) return;
        e.preventDefault();
        setMenuOpen((v) => !v);
        return;
      }
      if (
        !isModifier &&
        !e.altKey &&
        e.key === "?" &&
        !state.isOpen &&
        !isTypingTarget(e.target)
      ) {
        e.preventDefault();
        setShortcutsOpen(true);
      }
    }
    function onOpenShortcuts(): void {
      setShortcutsOpen(true);
    }
    window.addEventListener("keydown", onKey);
    window.addEventListener("pw:open-shortcuts", onOpenShortcuts);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pw:open-shortcuts", onOpenShortcuts);
    };
  }, [state.isOpen]);

  // Close the menu on outside click / Escape.
  useEffect(() => {
    if (!menuOpen) return;
    function onClick(e: MouseEvent): void {
      const target = e.target as Node | null;
      if (
        menuRef.current?.contains(target ?? null) ||
        buttonRef.current?.contains(target ?? null)
      ) {
        return;
      }
      closeMenu();
    }
    function onKey(e: KeyboardEvent): void {
      if (e.key === "Escape") closeMenu();
    }
    window.addEventListener("mousedown", onClick);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onClick);
      window.removeEventListener("keydown", onKey);
    };
  }, [closeMenu, menuOpen]);

  // Hide the launcher while the tour is actively running so it doesn't
  // overlap the spotlight.
  if (state.isOpen) return <></>;

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className={LAUNCHER_CLASS_NAME}
        data-tour-return-focus
        onClick={() => setMenuOpen((v) => !v)}
        aria-label="Open product tour menu"
        aria-controls={menuId}
        aria-expanded={menuOpen}
        title="Help, tours and shortcuts"
      >
        ?
      </button>
      {menuOpen ? (
        <div
          id={menuId}
          ref={menuRef}
          className={MENU_CLASS_NAME}
          role="group"
          aria-label="Help actions"
          data-testid="command-launcher"
        >
          <div className="border-b border-black/[0.06] px-3.5 pb-2 pt-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-[#6b6b6b] dark:text-[#8a8a8a]">
            Help
          </div>
          <button
            type="button"
            className={MENU_ITEM_CLASS_NAME}
            onClick={() => {
              setMenuOpen(false);
              if (hasCompleted) {
                replay();
              } else {
                start();
              }
            }}
          >
            <span>{hasCompleted ? "Restart tour" : "Take the tour"}</span>
            <span className="ml-auto font-mono text-[11px] text-[#6b6b6b] dark:text-[#8a8a8a]">
              ↵
            </span>
          </button>
          {hasCompleted ? (
            <button
              type="button"
              className={MENU_ITEM_CLASS_NAME}
              onClick={() => {
                setMenuOpen(false);
                start();
              }}
            >
              <span>Resume tour</span>
            </button>
          ) : null}
          <button
            type="button"
            className={MENU_ITEM_CLASS_NAME}
            onClick={() => {
              setMenuOpen(false);
              setShortcutsOpen(true);
            }}
          >
            <span>Keyboard shortcuts</span>
            <span className="ml-auto font-mono text-[11px] text-[#6b6b6b] dark:text-[#8a8a8a]">
              ⌘/
            </span>
          </button>
          {/* In-app help beyond the tour (SHELL-025) — the docs + changelog
              live in the marketing route group. */}
          <Link
            href={asRoute("/docs")}
            className={MENU_ITEM_CLASS_NAME}
            onClick={() => setMenuOpen(false)}
          >
            <span>Help &amp; documentation</span>
            <BookOpen size={15} aria-hidden />
          </Link>
          <Link
            href={asRoute("/changelog")}
            className={MENU_ITEM_CLASS_NAME}
            onClick={() => setMenuOpen(false)}
          >
            <span>What&rsquo;s new</span>
            <Sparkles size={15} aria-hidden />
          </Link>
        </div>
      ) : null}
      {shortcutsOpen ? <ShortcutsModal onClose={closeShortcuts} /> : null}
    </>
  );
}

function ShortcutsModal({ onClose }: { onClose: () => void }): JSX.Element {
  const panelRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key !== "Tab") return;
      const focusable = panelRef.current
        ? Array.from(
            panelRef.current.querySelectorAll<HTMLElement>(
              'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
            ),
          ).filter(
            (element) =>
              !element.hasAttribute("disabled") &&
              element.getAttribute("aria-hidden") !== "true",
          )
        : [];
      if (focusable.length === 0) {
        e.preventDefault();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    requestAnimationFrame(() => closeButtonRef.current?.focus());
  }, []);

  // Semantic tokens instead of the previous hardcoded #FDFCF8/#1A1A1A inline
  // styles, so the sheet follows the active theme (SHELL-004). Kept as a
  // hand-rolled dialog (not the Radix Dialog) to preserve the "Got it"
  // affordance + initial focus contract.
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="tour-shortcuts-title"
      className="fixed inset-0 z-[65] flex items-center justify-center bg-black/50 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        ref={panelRef}
        onClick={(e) => e.stopPropagation()}
        className="w-[min(420px,calc(100vw-32px))] rounded-2xl border bg-popover p-5 text-popover-foreground shadow-pw-lg"
      >
        <h2
          id="tour-shortcuts-title"
          className="text-base font-semibold tracking-tight"
        >
          Keyboard shortcuts
        </h2>
        <p className="mb-4 mt-1.5 text-sm text-muted-foreground">
          A few of the ways power users get around Moosewave.
        </p>
        <ul className="grid gap-2 text-sm">
          {SHORTCUTS.map(([label, keys]) => (
            <li key={label} className="flex items-center justify-between gap-4">
              <span className="text-foreground">{label}</span>
              <span className="font-mono text-xs text-muted-foreground">
                {keys}
              </span>
            </li>
          ))}
        </ul>
        <div className="mt-4 flex justify-end">
          <button
            ref={closeButtonRef}
            type="button"
            onClick={onClose}
            className="rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Got it
          </button>
        </div>
      </div>
    </div>
  );
}
