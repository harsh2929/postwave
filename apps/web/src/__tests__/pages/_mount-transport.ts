// SPDX-License-Identifier: AGPL-3.0-only
//
// A recording transport for the mount-reachability tests.
//
// The page harness (_harness.tsx) serves recorded fixtures but keeps no record
// of what was asked, so it cannot prove that a mounted component issued its
// request FROM the page. This wraps it: every request is recorded (method,
// path, query, parsed JSON body), `handler` may answer a request itself, and
// anything it leaves alone falls through to the fixture transport — which in
// turn answers 404 for an unrecorded path, never an invented `{}`.
import { act } from "react";
import { vi } from "vitest";

import { stubFixtureTransport } from "./_harness";

export interface Recorded {
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
}

export type Reply =
  | { status?: number; body?: unknown; headers?: Record<string, string> }
  | undefined;

export function recordingTransport(
  handler: (req: Recorded) => Reply | Promise<Reply> = () => undefined,
): { calls: Recorded[] } {
  stubFixtureTransport();
  const fixtureFetch = globalThis.fetch;
  const calls: Recorded[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const raw =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : (input as Request).url;
      const url = new URL(raw, "http://localhost");
      let body: unknown;
      if (typeof init?.body === "string") {
        try {
          body = JSON.parse(init.body);
        } catch {
          body = init.body;
        }
      }
      const record: Recorded = {
        method: (init?.method ?? "GET").toUpperCase(),
        path: url.pathname,
        query: url.searchParams,
        body,
      };
      calls.push(record);
      const reply = await handler(record);
      if (!reply) return fixtureFetch(input, init);
      return new Response(JSON.stringify(reply.body ?? {}), {
        status: reply.status ?? 200,
        headers: { "content-type": "application/json", ...reply.headers },
      });
    }),
  );
  return { calls };
}

/** Flushes pending promises/effects a few turns, inside act. */
export async function settle(turns = 6): Promise<void> {
  for (let i = 0; i < turns; i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

/** Sets a React-controlled input/textarea value through the native setter. */
export async function typeInto(
  el: HTMLInputElement | HTMLTextAreaElement,
  value: string,
): Promise<void> {
  const proto =
    el.tagName === "TEXTAREA"
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  await act(async () => {
    setter?.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));
  });
}

export async function clickEl(el: Element | null | undefined): Promise<void> {
  if (!el) throw new Error("clickEl: element not found");
  await act(async () => {
    (el as HTMLElement).click();
    await new Promise((r) => setTimeout(r, 0));
  });
}

/** The first button whose trimmed text or aria-label matches. */
export function buttonByText(
  container: ParentNode,
  match: string | RegExp,
): HTMLButtonElement | undefined {
  return [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (b) => {
      const text = `${b.getAttribute("aria-label") ?? ""} ${b.textContent ?? ""}`.trim();
      return typeof match === "string" ? text.includes(match) : match.test(text);
    },
  );
}
