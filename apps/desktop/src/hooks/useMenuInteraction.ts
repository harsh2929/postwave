import { type RefObject, useEffect, useRef } from "react";

const DEFAULT_ITEM_SELECTOR = [
  '[role="menuitem"]:not([disabled]):not([aria-disabled="true"])',
  '[role="menuitemcheckbox"]:not([disabled]):not([aria-disabled="true"])',
  '[role="menuitemradio"]:not([disabled]):not([aria-disabled="true"])',
].join(", ");

interface Options {
  isTop?: boolean;
  itemSelector?: string;
  menuRef: RefObject<HTMLElement | null>;
  onClose: () => void;
  open: boolean;
  selectedItemSelector?: string;
  suspended?: boolean;
  trigger: HTMLElement | null;
}

function menuItems(menu: HTMLElement, selector: string): HTMLElement[] {
  return Array.from(menu.querySelectorAll<HTMLElement>(selector));
}

function startsWithLabel(item: HTMLElement, query: string): boolean {
  return Boolean(
    item.textContent?.trim().toLocaleLowerCase().startsWith(query),
  );
}

/**
 * Shared APG-style keyboard, dismissal, and focus-return contract for a menu
 * popup. The caller retains semantic ownership of menuitem actions and any
 * nested modal; `suspended` prevents the underlying menu from reacting while
 * that modal owns the dialog stack.
 */
export function useMenuInteraction({
  isTop = true,
  itemSelector = DEFAULT_ITEM_SELECTOR,
  menuRef,
  onClose,
  open,
  selectedItemSelector,
  suspended = false,
  trigger,
}: Options): void {
  const initiallyFocusedRef = useRef(false);
  const typeaheadRef = useRef({ query: "", resetTimer: 0 });

  useEffect(() => {
    if (!open) {
      initiallyFocusedRef.current = false;
      return;
    }
    if (suspended || initiallyFocusedRef.current) return;
    initiallyFocusedRef.current = true;
    const menu = menuRef.current;
    if (!menu) return;
    const frame = window.requestAnimationFrame(() => {
      const preferred = selectedItemSelector
        ? menu.querySelector<HTMLElement>(selectedItemSelector)
        : null;
      (preferred ?? menuItems(menu, itemSelector)[0])?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [itemSelector, menuRef, open, selectedItemSelector, suspended]);

  useEffect(() => {
    if (!open || suspended) return;
    const menu = menuRef.current;
    if (!menu) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.isComposing || event.keyCode === 229) return;
      const items = menuItems(menu, itemSelector);
      if (items.length === 0) return;
      const current = items.indexOf(document.activeElement as HTMLElement);
      let next: HTMLElement | undefined;
      if (event.key === "ArrowDown") {
        next = items[current < 0 ? 0 : (current + 1) % items.length];
      } else if (event.key === "ArrowUp") {
        next =
          items[current < 0 ? items.length - 1 : (current - 1 + items.length) % items.length];
      } else if (event.key === "Home") next = items[0];
      else if (event.key === "End") next = items.at(-1);
      else if (
        event.key.length === 1 &&
        !event.altKey &&
        !event.ctrlKey &&
        !event.metaKey
      ) {
        window.clearTimeout(typeaheadRef.current.resetTimer);
        typeaheadRef.current.query += event.key.toLocaleLowerCase();
        const typed = typeaheadRef.current.query;
        const firstCharacter = typed.charAt(0);
        const query =
          typed.replaceAll(firstCharacter, "").length === 0
            ? firstCharacter
            : typed;
        typeaheadRef.current.resetTimer = window.setTimeout(() => {
          typeaheadRef.current.query = "";
        }, 500);
        const start = current < 0 ? 0 : current + 1;
        next = [...items.slice(start), ...items.slice(0, start)].find((item) =>
          startsWithLabel(item, query),
        );
      } else return;
      if (!next) return;
      event.preventDefault();
      next.focus();
    };
    menu.addEventListener("keydown", onKeyDown);
    return () => {
      window.clearTimeout(typeaheadRef.current.resetTimer);
      typeaheadRef.current = { query: "", resetTimer: 0 };
      menu.removeEventListener("keydown", onKeyDown);
    };
  }, [itemSelector, menuRef, open, suspended]);

  useEffect(() => {
    if (!open || suspended) return;
    const onWindowKey = (event: KeyboardEvent): void => {
      if (event.isComposing || event.keyCode === 229) return;
      if (event.key === "Escape") {
        if (!isTop) return;
        event.preventDefault();
        onClose();
        queueMicrotask(() => trigger?.focus());
      } else if (event.key === "Tab") {
        onClose();
      }
    };
    window.addEventListener("keydown", onWindowKey);
    return () => window.removeEventListener("keydown", onWindowKey);
  }, [isTop, onClose, open, suspended, trigger]);

  useEffect(() => {
    if (!open || suspended) return;
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target as Node;
      if (menuRef.current?.contains(target) || trigger?.contains(target)) return;
      onClose();
    };
    const onFocusIn = (event: FocusEvent): void => {
      const target = event.target as Node;
      if (menuRef.current?.contains(target) || trigger?.contains(target)) return;
      onClose();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("focusin", onFocusIn);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("focusin", onFocusIn);
    };
  }, [menuRef, onClose, open, suspended, trigger]);
}
