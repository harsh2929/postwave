// SPDX-License-Identifier: AGPL-3.0-only
//
// Shared DOM harness for the subscribers-directory component tests
// (react-dom/client + act — @testing-library is not installed in apps/web).
//
// `navStore` is a reactive stand-in for next/navigation's search params: the
// directory controls write the page's URL state through `router.replace`, and
// the page (or another control) re-reads it through `useSearchParams`, so the
// mock has to publish a replace back to every reader — a static
// URLSearchParams would make every URL write invisible.
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

type Listener = () => void;

export const navStore = (() => {
  let search = "";
  const listeners = new Set<Listener>();
  const replaced: string[] = [];
  return {
    get: (): string => search,
    set(next: string): void {
      search = next.replace(/^\?/, "");
      for (const listener of [...listeners]) listener();
    },
    subscribe(listener: Listener): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    replace(url: string): void {
      replaced.push(url);
      const query = url.includes("?") ? url.slice(url.indexOf("?") + 1) : "";
      this.set(query);
    },
    replaced,
    reset(): void {
      search = "";
      replaced.length = 0;
      listeners.clear();
    },
    params(): URLSearchParams {
      return new URLSearchParams(search);
    },
  };
})();

/** Factory body for `vi.mock("next/navigation", …)`. */
export async function navigationMock(pathname = "/app/subscribers") {
  const React = await import("react");
  const router = {
    push: (url: string) => navStore.replace(url),
    replace: (url: string) => navStore.replace(url),
    refresh: () => undefined,
    back: () => undefined,
    prefetch: () => undefined,
  };
  return {
    useRouter: () => router,
    usePathname: () => pathname,
    useSearchParams: () => {
      const search = React.useSyncExternalStore(
        navStore.subscribe,
        navStore.get,
        navStore.get,
      );
      return React.useMemo(() => new URLSearchParams(search), [search]);
    },
    useParams: () => ({}),
    redirect: () => undefined,
  };
}

const roots: Root[] = [];

export function render(ui: ReactNode): { root: Root; client: QueryClient } {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => {
    root.render(createElement(QueryClientProvider, { client }, ui));
  });
  roots.push(root);
  return { root, client };
}

export function cleanup(): void {
  act(() => {
    for (const root of roots.splice(0)) root.unmount();
  });
  document.body.innerHTML = "";
}

export async function flush(turns = 6): Promise<void> {
  for (let i = 0; i < turns; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

export function button(label: string | RegExp, scope: ParentNode = document): HTMLButtonElement {
  const match = [...scope.querySelectorAll<HTMLButtonElement>("button")].find((candidate) => {
    const text = candidate.textContent?.replace(/\s+/g, " ").trim() ?? "";
    const aria = candidate.getAttribute("aria-label") ?? "";
    return typeof label === "string"
      ? text === label || aria === label
      : label.test(text) || label.test(aria);
  });
  if (!match) throw new Error(`Button not found: ${String(label)}`);
  return match;
}

export function queryButton(label: string | RegExp, scope: ParentNode = document) {
  try {
    return button(label, scope);
  } catch {
    return null;
  }
}

/** The control a <label> names (via htmlFor, or the control nested inside it). */
export function field(
  labelText: string | RegExp,
  scope: ParentNode = document,
): HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement {
  const label = [...scope.querySelectorAll("label")].find((candidate) => {
    const text = candidate.textContent?.replace(/\s+/g, " ").trim() ?? "";
    return typeof labelText === "string" ? text === labelText : labelText.test(text);
  });
  const control = label
    ? label.htmlFor
      ? document.getElementById(label.htmlFor)
      : label.querySelector("input, select, textarea")
    : null;
  if (!control) throw new Error(`Control not found for label: ${String(labelText)}`);
  return control as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
}

export function byAriaLabel<T extends Element = HTMLElement>(
  label: string,
  scope: ParentNode = document,
): T {
  const element = [...scope.querySelectorAll<T>("[aria-label]")].find(
    (candidate) => candidate.getAttribute("aria-label") === label,
  );
  if (!element) throw new Error(`No element labelled: ${label}`);
  return element;
}

export function type(
  control: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement,
  value: string,
): void {
  const proto =
    control instanceof HTMLSelectElement
      ? window.HTMLSelectElement.prototype
      : control instanceof HTMLTextAreaElement
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype;
  act(() => {
    Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(control, value);
    control.dispatchEvent(new Event("input", { bubbles: true }));
    control.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

export function click(element: HTMLElement): void {
  act(() => element.click());
}

export function dialogs(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('[role="dialog"], [role="alertdialog"]')];
}

/** The most recently opened dialog. */
export function topDialog(): HTMLElement {
  const all = dialogs();
  const last = all[all.length - 1];
  if (!last) throw new Error("No dialog is open");
  return last;
}

/** A `Response` carrying an ETag, for transports that read it in onResponse. */
export function etagResponse(etag: string): Response {
  return new Response(null, { status: 200, headers: { ETag: etag } });
}
