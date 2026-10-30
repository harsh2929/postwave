// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-only
//
// analytics-54 — Top sequence funnel. Asserted by the two requests it makes
// (GET /api/v1/voice/sequences, then GET /api/v1/voice/sequences/{first}/funnel),
// the steps it draws from the funnel payload, desktop's "nothing to show"
// parity when there is no sequence or no funnel events, and the server's
// sentence on a failed read.

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TopSequenceFunnelPanel } from "@/components/analytics/top-sequence-funnel-panel";
import {
  parseSequenceFunnel,
  parseVoiceSequenceList,
} from "@/lib/sequence-funnel-api";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const TENANT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SEQ = "5b1c2d3e-0000-4000-8000-000000000001";

const FUNNEL = {
  sequence_id: SEQ,
  steps: [
    {
      position: 0,
      reached: 1000,
      opened: 400,
      clicked: 100,
      open_rate: 0.4,
      click_rate: 0.1,
      dropoff_pct: 0,
    },
    {
      position: 1,
      reached: 800,
      opened: 240,
      clicked: 40,
      open_rate: 0.3,
      click_rate: 0.05,
      dropoff_pct: 0.2,
    },
  ],
};

type Reply = { status: number; body: unknown };
let listReply: Reply;
let funnelReply: Reply;
let transport: ReturnType<typeof vi.fn>;

function stub() {
  const fn = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const raw =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    const url = new URL(raw, "http://localhost");
    const { status, body } =
      url.pathname === "/api/v1/voice/sequences"
        ? listReply
        : url.pathname.endsWith("/funnel")
          ? funnelReply
          : { status: 404, body: {} };
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

function requestPaths(): string[] {
  return transport.mock.calls.map(
    ([input]) => new URL(String(input), "http://localhost").pathname,
  );
}

let root: Root | null = null;

async function flush() {
  await new Promise((resolve) => window.setTimeout(resolve, 0));
}

async function waitFor(assertion: () => void) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await act(async () => flush());
    }
  }
  throw lastError;
}

async function render(tenantId = TENANT) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  const container = document.createElement("div");
  document.body.append(container);
  await act(async () => {
    root = createRoot(container);
    root.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(TopSequenceFunnelPanel, {
          tenantId,
          role: "viewer",
          userId: "user-1",
        }),
      ),
    );
  });
  await act(async () => flush());
  return container;
}

beforeEach(() => {
  listReply = {
    status: 200,
    body: [
      { id: SEQ, name: "Welcome series", status: "active", emails: [] },
      { id: "second", name: "Other", status: "active", emails: [] },
    ],
  };
  funnelReply = { status: 200, body: FUNNEL };
  transport = stub();
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("Top sequence funnel (analytics-54)", () => {
  it("reads the sequence list, then the FIRST sequence's funnel, and draws each step", async () => {
    const container = await render();
    await waitFor(() =>
      expect(
        container.querySelectorAll('[data-testid="sequence-funnel-step"]'),
      ).toHaveLength(2),
    );
    expect(requestPaths()).toEqual([
      "/api/v1/voice/sequences",
      `/api/v1/voice/sequences/${SEQ}/funnel`,
    ]);
    const steps = [
      ...container.querySelectorAll('[data-testid="sequence-funnel-step"]'),
    ].map((li) => li.textContent);
    expect(steps[0]).toBe(
      "Step 11,000 reached · 400 opened · 100 clickedOpen 40.0% · click 10.0%",
    );
    expect(steps[1]).toBe(
      "Step 2800 reached · 240 opened · 40 clickedOpen 30.0% · click 5.0% · 20.0% dropped off before this step",
    );
    const link = container.querySelector("a");
    expect(link?.textContent).toBe("Welcome series");
    expect(link?.getAttribute("href")).toBe(`/app/sequences/${SEQ}`);
  });

  it("renders nothing (desktop parity) when the workspace has no sequences — and never asks for a funnel", async () => {
    listReply = { status: 200, body: [] };
    const container = await render();
    await waitFor(() => expect(requestPaths()).toHaveLength(1));
    await act(async () => flush());
    expect(container.textContent).toBe("");
    expect(requestPaths()).toEqual(["/api/v1/voice/sequences"]);
  });

  it("renders nothing when the first sequence has no funnel events yet", async () => {
    funnelReply = { status: 200, body: { sequence_id: SEQ, steps: [] } };
    const container = await render();
    await waitFor(() => expect(requestPaths()).toHaveLength(2));
    await act(async () => flush());
    expect(container.textContent).toBe("");
  });

  it("a refused funnel read renders the server's sentence, and Retry re-requests it", async () => {
    funnelReply = {
      status: 403,
      body: {
        error: {
          code: "forbidden",
          message: "Your role cannot read sequence reports.",
        },
      },
    };
    const container = await render();
    await waitFor(() =>
      expect(container.querySelector('[role="alert"]')?.textContent).toContain(
        "Couldn't load the sequence funnel: Your role cannot read sequence reports.",
      ),
    );
    funnelReply = { status: 200, body: FUNNEL };
    await act(async () => {
      [...container.querySelectorAll("button")]
        .find((b) => b.textContent?.trim() === "Retry")
        ?.click();
    });
    await waitFor(() =>
      expect(
        container.querySelectorAll('[data-testid="sequence-funnel-step"]'),
      ).toHaveLength(2),
    );
    expect(
      requestPaths().filter((p) => p.endsWith("/funnel")).length,
    ).toBeGreaterThanOrEqual(2);
  });

  it("makes no request before the identity resolves", async () => {
    const container = await render("anon");
    await act(async () => flush());
    expect(requestPaths()).toEqual([]);
    expect(container.textContent).toBe("");
  });
});

describe("sequence funnel parsers", () => {
  it("unwraps list envelopes and rejects non-lists instead of reading them as empty", () => {
    expect(parseVoiceSequenceList({ items: [{ id: "a", name: "A" }] })).toEqual([
      { id: "a", name: "A" },
    ]);
    expect(parseVoiceSequenceList([{ id: 7 }, { name: "no id" }])).toEqual([
      { id: "7", name: "Untitled sequence" },
    ]);
    expect(() => parseVoiceSequenceList("<!doctype html>")).toThrow(
      "unexpected shape",
    );
    expect(() => parseVoiceSequenceList({ total: 0 })).toThrow(
      "unexpected shape",
    );
  });

  it("rejects a funnel without a steps array and zero-fills noisy counters", () => {
    expect(() => parseSequenceFunnel({ sequence_id: "x" }, "x")).toThrow(
      "unexpected shape",
    );
    expect(
      parseSequenceFunnel(
        { steps: [{ position: 2, step_id: "p2:yes:p3", reached: "9" }] },
        "req",
      ),
    ).toEqual({
      sequenceId: "req",
      steps: [
        {
          position: 2,
          stepId: "p2:yes:p3",
          reached: 0,
          opened: 0,
          clicked: 0,
          openRate: 0,
          clickRate: 0,
          dropoffPct: 0,
        },
      ],
    });
  });
});
