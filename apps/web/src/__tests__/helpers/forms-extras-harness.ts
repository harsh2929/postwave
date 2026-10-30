// SPDX-License-Identifier: AGPL-3.0-only
//
// Shared harness for the forms parity-extras component tests: a recording
// fetch stub that answers through the REAL lib/api transport, plus small DOM
// helpers for the react-dom/client + act pattern (no testing-library here).
import { act } from "react";
import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { vi } from "vitest";

import type { MeResponse } from "@/lib/auth-api";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

export function identity(overrides: Partial<MeResponse> = {}): MeResponse {
  return {
    user_id: "user-1",
    tenant_id: "tenant-1",
    email: "ops@example.test",
    role: "admin",
    effective_role: "admin",
    viewer_mode: false,
    auth_provider: "password",
    email_verified: true,
    workspace_name: "Workspace",
    workspace_slug: "workspace",
    ...overrides,
  };
}

export interface RecordedCall {
  method: string;
  path: string;
  search: string;
  headers: Headers;
  body: unknown;
}

export type Route = (
  call: RecordedCall,
) => Response | Promise<Response> | undefined;

export function json(
  body: unknown,
  init: { status?: number; etag?: string; headers?: Record<string, string> } = {},
): Response {
  const headers = new Headers({
    "content-type": "application/json",
    ...(init.headers ?? {}),
  });
  if (init.etag) headers.set("ETag", init.etag);
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers,
  });
}

/** Stub global fetch; each call is recorded then offered to `route`. */
export function stubFetch(route: Route) {
  const calls: RecordedCall[] = [];
  const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    const url = new URL(raw, "http://postwave.local");
    let body: unknown = undefined;
    if (typeof init?.body === "string" && init.body) {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    const call: RecordedCall = {
      method: (init?.method ?? "GET").toUpperCase(),
      path: url.pathname,
      search: url.search,
      headers: new Headers(init?.headers),
      body,
    };
    calls.push(call);
    const res = await route(call);
    return (
      res ??
      json({ error: { code: "not_found", message: "no route" } }, { status: 404 })
    );
  });
  vi.stubGlobal("fetch", mock);
  return { calls, mock };
}

const roots: Root[] = [];

export function mount(ui: ReactNode): HTMLDivElement {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  act(() => root.render(ui));
  return host;
}

export function unmountAll(): void {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.innerHTML = "";
}

export async function flush(times = 4): Promise<void> {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

export async function eventually(assertion: () => void): Promise<void> {
  let last: unknown;
  for (let i = 0; i < 80; i++) {
    try {
      assertion();
      return;
    } catch (err) {
      last = err;
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0));
      });
    }
  }
  throw last;
}

export function button(name: string, root: ParentNode = document): HTMLButtonElement {
  const match = Array.from(root.querySelectorAll("button")).find(
    (b) => b.textContent?.replace(/\s+/g, " ").trim() === name,
  );
  if (!(match instanceof HTMLButtonElement)) {
    throw new Error(`button not found: ${name}`);
  }
  return match;
}

/** The control a <label> names — via htmlFor, or nested inside it. */
export function field<T extends HTMLElement = HTMLInputElement>(
  labelText: string,
): T {
  const label = Array.from(document.querySelectorAll("label")).find((l) =>
    l.textContent?.includes(labelText),
  );
  if (!label) throw new Error(`label not found: ${labelText}`);
  const target = label.htmlFor
    ? document.getElementById(label.htmlFor)
    : label.querySelector("input, select, textarea");
  if (!target) throw new Error(`control not found for: ${labelText}`);
  return target as T;
}

export function typeInto(el: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )!.set!;
  act(() => {
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

export function choose(el: HTMLSelectElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLSelectElement.prototype,
    "value",
  )!.set!;
  act(() => {
    setter.call(el, value);
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

export async function click(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.click();
  });
}
