interface IsolatedElementState {
  leases: number;
  inert: boolean;
  ariaHidden: string | null;
}

interface BodyScrollState {
  leases: number;
  overflow: string;
}

const isolatedElements = new WeakMap<HTMLElement, IsolatedElementState>();
const lockedBodies = new WeakMap<HTMLElement, BodyScrollState>();

function acquireIsolation(element: HTMLElement): void {
  const existing = isolatedElements.get(element);
  if (existing) {
    existing.leases += 1;
  } else {
    isolatedElements.set(element, {
      leases: 1,
      inert: element.inert,
      ariaHidden: element.getAttribute("aria-hidden"),
    });
  }
  element.inert = true;
  element.setAttribute("aria-hidden", "true");
}

function releaseIsolation(element: HTMLElement): void {
  const state = isolatedElements.get(element);
  if (!state) return;
  state.leases -= 1;
  if (state.leases > 0) {
    element.inert = true;
    element.setAttribute("aria-hidden", "true");
    return;
  }
  isolatedElements.delete(element);
  element.inert = state.inert;
  if (state.ariaHidden === null) element.removeAttribute("aria-hidden");
  else element.setAttribute("aria-hidden", state.ariaHidden);
}

/**
 * Remove every sibling outside a top-layer surface from pointer, keyboard,
 * and accessibility-tree navigation. Prior values are restored exactly, so
 * nested dialogs remain safe when the inner surface closes first.
 */
export function isolateDialogBackground(surface: HTMLElement): () => void {
  const leasedElements = new Set<HTMLElement>();
  // Start at the supplied layer itself so siblings rendered in the same React
  // root are isolated too. Starting at `surface.parentElement` skipped those
  // siblings for slideovers that are not rendered through a portal.
  let current: HTMLElement | null = surface;
  while (current?.parentElement && current !== document.body) {
    const parent: HTMLElement = current.parentElement;
    for (const sibling of Array.from(parent.children)) {
      if (!(sibling instanceof HTMLElement) || sibling === current) continue;
      if (leasedElements.has(sibling)) continue;
      leasedElements.add(sibling);
      acquireIsolation(sibling);
    }
    current = parent;
  }
  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    for (const element of Array.from(leasedElements).reverse()) {
      releaseIsolation(element);
    }
  };
}

/**
 * Lease the document body's scroll lock. Nested overlays share one original
 * value, so closing an inner and outer owner in either order cannot restore a
 * stale intermediate `overflow: hidden` snapshot.
 */
export function lockDocumentBodyScroll(): () => void {
  const body = document.body;
  const existing = lockedBodies.get(body);
  if (existing) {
    existing.leases += 1;
  } else {
    lockedBodies.set(body, { leases: 1, overflow: body.style.overflow });
  }
  body.style.overflow = "hidden";
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const state = lockedBodies.get(body);
    if (!state) return;
    state.leases -= 1;
    if (state.leases > 0) {
      body.style.overflow = "hidden";
      return;
    }
    lockedBodies.delete(body);
    body.style.overflow = state.overflow;
  };
}
