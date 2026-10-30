/**
 * keyboard-shortcuts — small helpers for page-scope keybindings.
 *
 * Each list/inspector pair (Subscribers, soon Campaigns/Lists/etc.) wires
 * a top-level keydown listener. These helpers keep the predicates honest
 * so e.g. a /-press inside a search input doesn't re-trigger the focus
 * shortcut, and so that ⌘A inside a textarea still picks the text.
 */

/** Returns true if the event target is a text-entry surface where global
 *  letter shortcuts must NOT fire (input, textarea, contenteditable, or
 *  any element flagged role="textbox"). Select elements are intentionally
 *  excluded — j/k inside a <select> already cycles options natively. */
export function isTextInputTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === "INPUT") {
    const type = (target as HTMLInputElement).type.toLowerCase();
    // Checkbox / radio / button-type inputs shouldn't block letter keys.
    const textLike = new Set([
      "text",
      "search",
      "email",
      "url",
      "tel",
      "number",
      "password",
      "date",
      "datetime-local",
      "time",
      "",
    ]);
    return textLike.has(type);
  }
  if (tag === "TEXTAREA") return true;
  if (target.isContentEditable) return true;
  if (target.getAttribute("role") === "textbox") return true;
  return false;
}

/** Mac-friendly modifier check — meta (⌘) on macOS, ctrl elsewhere. We
 *  accept either so power users on external keyboards aren't surprised. */
export function isModKey(e: KeyboardEvent): boolean {
  return e.metaKey || e.ctrlKey;
}
