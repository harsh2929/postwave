// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-only
//
// Pre-send check on a pasted draft (desktop PresendCheckPanel parity):
// subject / from / body → POST /api/v1/presend/verdict → EQ + voice drift +
// placement. Real transport; only `fetch` is stubbed.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PresendCheckPanel } from "@/components/ai/presend-check-panel";
import { decodePresendDraftVerdict } from "@/lib/presend-draft-api";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const COMPLETE = {
  verdict: "warn",
  complete: true,
  summary: "Voice drift is noticeable; review before sending.",
  components: [
    { name: "eq_score", status: "ok", score: 82, message: "Content reads cleanly." },
    { name: "voice_drift", status: "warn", score: 58, message: "Tone is more formal than your profile." },
    { name: "placement", status: "ok", score: 0.91 },
  ],
  computed_at: "2026-09-12T08:00:00Z",
};

interface Seen {
  method: string;
  path: string;
  headers: Headers;
  body: unknown;
}

let seen: Seen[] = [];
let respond: () => Response = () => json(200, COMPLETE);
const roots: Root[] = [];

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function eventually(assertion: () => void): Promise<void> {
  let last: unknown;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      last = error;
      await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    }
  }
  throw last;
}

async function mount(props: { canRun: boolean; blockedReason?: string }) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <PresendCheckPanel {...props} />
      </QueryClientProvider>,
    );
  });
  return container;
}

function control<T extends HTMLElement>(label: string): T {
  const found = [...document.querySelectorAll("label")].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  const element = found ? document.getElementById(found.htmlFor) : null;
  if (!element) throw new Error(`no ${label}`);
  return element as T;
}

async function type(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  await act(async () => {
    const proto =
      element instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function runButton(): HTMLButtonElement {
  const found = [...document.querySelectorAll("button")].find((candidate) =>
    /run pre-send check|running checks/i.test(candidate.textContent ?? ""),
  );
  if (!(found instanceof HTMLButtonElement)) throw new Error("no run button");
  return found;
}

async function fillDraft() {
  await type(control<HTMLInputElement>("Subject"), "  September news  ");
  await type(control<HTMLInputElement>("Sender email"), "news@brand.example");
  await type(control<HTMLTextAreaElement>("Message body"), "<p>Hello there</p>");
}

beforeEach(() => {
  seen = [];
  respond = () => json(200, COMPLETE);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const raw =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      seen.push({
        method: (init?.method ?? "GET").toUpperCase(),
        path: new URL(raw, "http://postwave.test").pathname,
        headers: new Headers(init?.headers),
        body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      });
      return respond();
    }),
  );
});

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("pre-send check on a pasted draft", () => {
  it("posts the draft and renders all three checks against it", async () => {
    const container = await mount({ canRun: true });
    expect(runButton().disabled).toBe(true);
    await fillDraft();
    expect(runButton().disabled).toBe(false);
    await act(async () => runButton().click());

    await eventually(() => expect(seen).toHaveLength(1));
    expect(seen[0]?.method).toBe("POST");
    expect(seen[0]?.path).toBe("/api/v1/presend/verdict");
    expect(seen[0]?.body).toEqual({
      subject: "September news",
      from: "news@brand.example",
      html: "<p>Hello there</p>",
      text: "<p>Hello there</p>",
    });
    // Grading persists nothing: no replayable idempotency receipt is minted.
    expect(seen[0]?.headers.has("Idempotency-Key")).toBe(false);

    await eventually(() => expect(container.textContent).toContain("Review suggested"));
    expect(container.textContent).toContain("Current draft");
    expect(container.textContent).toContain("3 of 3 checks completed");
    expect(container.textContent).toContain("Content quality");
    expect(container.textContent).toContain("Completed · 82 / 100");
    expect(container.textContent).toContain("Tone is more formal than your profile.");
    expect(container.textContent).toContain("Needs review · 58 / 100");
    expect(container.textContent).toContain("Completed · 91%");

    // Editing the draft retires the result instead of letting it describe new text.
    await type(control<HTMLInputElement>("Subject"), "October news");
    expect(container.textContent).toContain("Previous result — was review suggested");
    expect(container.textContent).toContain("Draft changed");
  });

  it("never reads an incomplete run as a pass", async () => {
    respond = () =>
      json(200, {
        verdict: "incomplete",
        complete: false,
        summary: "Some checks could not run.",
        components: [
          { name: "eq_score", status: "ok", score: 90 },
          { name: "voice_drift", status: "error", error: "Voice drift check unavailable." },
        ],
        computed_at: "2026-09-12T08:00:00Z",
      });
    const container = await mount({ canRun: true });
    await fillDraft();
    await act(async () => runButton().click());
    await eventually(() => expect(container.textContent).toContain("Incomplete review"));
    expect(container.textContent).toContain("Incomplete — do not infer a pass");
    expect(container.textContent).toContain("Voice drift check unavailable.");
    // The placement check the server never returned is named, not dropped.
    expect(container.textContent).toContain(
      "Primary placementNo result was returned for this check.Unknown · —",
    );
    expect(container.textContent).not.toContain("Checks completed");
  });

  it("refuses a green verdict the component set contradicts", () => {
    const contradicted = decodePresendDraftVerdict({
      ...COMPLETE,
      verdict: "ok",
      complete: true,
      components: [
        { name: "eq_score", status: "ok", score: 90 },
        { name: "voice_drift", status: "ok", score: 90 },
        { name: "placement", status: "skipped" },
      ],
    });
    expect(contradicted.complete).toBe(false);
    // A duplicated check means the server's set is not the one this client
    // knows how to read; it may not stand behind a "complete" claim.
    const duplicated = decodePresendDraftVerdict({
      ...COMPLETE,
      verdict: "ok",
      components: [
        { name: "eq_score", status: "ok", score: 90 },
        { name: "eq_score", status: "critical", score: 10 },
        { name: "voice_drift", status: "ok", score: 90 },
        { name: "placement", status: "ok", score: 0.9 },
      ],
    });
    expect(duplicated.complete).toBe(false);
    expect(() =>
      decodePresendDraftVerdict({
        ...COMPLETE,
        components: [{ name: "eq_score", status: "ok" }],
      }),
    ).toThrow(/completed without a score/u);
  });

  it("shows the server's refusal and keeps the draft", async () => {
    respond = () =>
      json(403, {
        error: { code: "forbidden", message: "Your role cannot run pre-send checks." },
      });
    const container = await mount({ canRun: true });
    await fillDraft();
    await act(async () => runButton().click());
    await eventually(() =>
      expect(container.textContent).toContain("Your role cannot run pre-send checks."),
    );
    expect(control<HTMLInputElement>("Subject").value).toBe("  September news  ");
  });

  it("withholds the run for a role without write:campaigns and says why", async () => {
    const container = await mount({
      canRun: false,
      blockedReason: "Owner, admin, or editor access is required.",
    });
    await fillDraft();
    expect(runButton().disabled).toBe(true);
    expect(container.textContent).toContain("Owner, admin, or editor access is required.");
    expect(seen).toHaveLength(0);
  });
});
