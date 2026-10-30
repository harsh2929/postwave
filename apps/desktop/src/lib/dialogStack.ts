/**
 * dialogStack — global LIFO of currently-open dialogs.
 *
 * Every Modal, SlideoverShell, and any other top-layer surface that
 * cares about Escape-key behavior pushes itself onto this stack while
 * mounted. The top-of-stack handler runs first; everyone else defers.
 *
 * Why: a slideover that hosts a Modal used to need `disableEscape:
 * true` to avoid double-firing (the slideover's Esc handler would fire
 * alongside the Modal's, closing both). With this stack, the inner
 * Modal becomes top-of-stack and the slideover's handler self-suppresses
 * until the Modal pops back off.
 *
 * The stack is intentionally global module state — there is exactly
 * one keyboard focus per browser window, so a singleton matches the
 * model. React state would force every consumer to live under a shared
 * context provider, which is overkill for a UX safeguard.
 */

const stack: string[] = [];
const subscribers = new Set<() => void>();

function emit(): void {
  for (const fn of subscribers) fn();
}

/** Push an id onto the stack. The pushed id becomes top-of-stack. */
export function pushDialog(id: string): void {
  /* Defensive: if this id is already on the stack (StrictMode double
   * effects, hot-reload edge cases), don't add a duplicate. */
  if (stack.includes(id)) return;
  stack.push(id);
  emit();
}

/** Remove an id from the stack regardless of its current position. */
export function popDialog(id: string): void {
  const i = stack.indexOf(id);
  if (i < 0) return;
  stack.splice(i, 1);
  emit();
}

/** True if the given id is currently at the top of the stack. */
export function isTopDialog(id: string): boolean {
  return stack.length > 0 && stack[stack.length - 1] === id;
}

/** Current top id, or null if the stack is empty. */
export function topDialog(): string | null {
  return stack.length > 0 ? (stack[stack.length - 1] ?? null) : null;
}

/** Snapshot the stack (mostly for tests / debug). */
export function dialogStackSnapshot(): readonly string[] {
  return [...stack];
}

/**
 * Subscribe to stack changes. Returns an unsubscribe function. Use
 * `useDialogStack(id)` (in `hooks/useDialogStack.ts`) for the React
 * binding — direct subscription is here for non-React callers.
 */
export function subscribeDialogStack(fn: () => void): () => void {
  subscribers.add(fn);
  return () => {
    subscribers.delete(fn);
  };
}
