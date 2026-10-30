// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-only
//
// governance-76: agent-origin evidence for an agent-requested approval.
// Drives the real transport through a stubbed fetch so the assertions cover
// the request actually sent (GET /api/v1/agent-routines/runs/by-approval/{id}),
// the approval_id re-validation, and what the reviewer is shown.
import { act, createElement } from "react";
import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AgentOriginEvidencePanel } from "@/components/approvals/agent-origin-evidence-panel";
import {
  AgentEvidenceContractError,
  decodeAgentOriginEvidence,
  htmlToReadableText,
} from "@/lib/approval-agent-evidence-api";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const APPROVAL_ID = "apr_7";
const SCOPE = ["settings", "tnt_1", "admin", "approvals", "usr_1", "member-mode"];

let fetchMock: ReturnType<
  typeof vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>
>;
const roots: Root[] = [];

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function run(overrides: Record<string, unknown> = {}) {
  return {
    id: "run_1",
    routine_id: "rtn_1",
    status: "succeeded",
    output_kind: "campaign",
    output_ref: "cmp_9",
    approval_id: APPROVAL_ID,
    prompt_used: "Draft the September win-back email.",
    context_used: "Segment: lapsed 90d (1,204 contacts)",
    reasoning: "Lapsed buyers respond to a time-boxed offer.",
    draft_preview: {
      kind: "campaign",
      name: "Win-back",
      subject: "We saved your cart",
      preview_text: "20% off ends Friday",
      body: "<p>Hello &amp; welcome back</p><script>alert(1)</script><p>Bye</p>",
    },
    started_at: "2026-09-10T08:00:00Z",
    finished_at: "2026-09-10T08:01:00Z",
    ...overrides,
  };
}

beforeEach(() => {
  fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
    json(200, run()),
  );
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

function render(ui: ReactNode): void {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  act(() =>
    root.render(createElement(QueryClientProvider, { client }, ui)),
  );
}

async function eventually(assertion: () => void): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await act(async () => {
        await new Promise((resolve) => window.setTimeout(resolve, 0));
      });
    }
  }
  throw lastError;
}

function requests(): Array<{ method: string; path: string }> {
  return fetchMock.mock.calls.map(([input, init]) => {
    const url =
      input instanceof Request
        ? input.url
        : input instanceof URL
          ? input.href
          : String(input);
    return {
      method: (input instanceof Request ? input.method : init?.method) ?? "GET",
      path: new URL(url, "http://localhost").pathname,
    };
  });
}

function panel(approval: { id: string; requestedByActorType?: string }) {
  return createElement(AgentOriginEvidencePanel, {
    approval,
    scopeKey: SCOPE,
  });
}

describe("AgentOriginEvidencePanel (governance-76)", () => {
  it("fetches the linked run for an agent-requested approval and renders its evidence as plain text", async () => {
    render(panel({ id: APPROVAL_ID, requestedByActorType: "agent" }));

    await eventually(() =>
      expect(document.body.textContent).toContain(
        "A linked agent run was verified for this approval.",
      ),
    );
    expect(requests()).toEqual([
      {
        method: "GET",
        path: `/api/v1/agent-routines/runs/by-approval/${APPROVAL_ID}`,
      },
    ]);
    expect(
      document.querySelector('[data-testid="agent-reasoning"]')?.textContent,
    ).toBe("Lapsed buyers respond to a time-boxed offer.");
    expect(
      document.querySelector('[data-testid="agent-prompt"]')?.textContent,
    ).toBe("Draft the September win-back email.");
    expect(document.body.textContent).toContain(
      "Segment: lapsed 90d (1,204 contacts)",
    );
    const preview = document.querySelector(
      '[data-testid="agent-draft-preview"]',
    );
    expect(preview?.textContent).toContain("We saved your cart");
    expect(preview?.textContent).toContain("20% off ends Friday");
    expect(preview?.textContent).toContain("Hello & welcome back");
    expect(preview?.querySelector("script")).toBeNull();
    expect(document.body.textContent).toContain("Agent run verified");
    expect(document.body.textContent).toContain("run_1");
  });

  it("makes no lookup for a request that does not name an agent", async () => {
    render(panel({ id: APPROVAL_ID, requestedByActorType: "user" }));
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain(
      "This record does not identify an agent-authored request, so no agent-run lookup was made.",
    );
  });

  it("refuses a run linked to a different approval", async () => {
    fetchMock.mockImplementation(async () =>
      json(200, run({ approval_id: "apr_other" })),
    );
    render(panel({ id: APPROVAL_ID, requestedByActorType: "agent" }));
    await eventually(() =>
      expect(document.querySelector('[role="alert"]')?.textContent).toContain(
        "linked to a different approval",
      ),
    );
    expect(document.body.textContent).not.toContain(
      "Lapsed buyers respond to a time-boxed offer.",
    );
    expect(document.body.textContent).not.toContain("Agent run verified");
  });

  it("reports a 404 as no linked run, not as proof of authorship", async () => {
    fetchMock.mockImplementation(async () =>
      json(404, {
        error: { code: "routine_not_found", message: "agent routine not found" },
      }),
    );
    render(panel({ id: APPROVAL_ID, requestedByActorType: "agent" }));
    await eventually(() =>
      expect(document.body.textContent).toContain(
        "No linked agent run was returned. This does not prove who authored the request.",
      ),
    );
    expect(document.querySelector('[role="alert"]')).toBeNull();
  });

  it("renders the server's denial sentence and retries the same request", async () => {
    fetchMock.mockImplementation(async () =>
      json(403, {
        error: {
          code: "insufficient_scope",
          message: "This API key lacks the agent_routines:read scope.",
        },
      }),
    );
    render(panel({ id: APPROVAL_ID, requestedByActorType: "agent" }));
    await eventually(() =>
      expect(document.querySelector('[role="alert"]')?.textContent).toContain(
        "This API key lacks the agent_routines:read scope.",
      ),
    );
    fetchMock.mockImplementation(async () => json(200, run()));
    const retry = Array.from(document.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Retry evidence",
    );
    if (!retry) throw new Error("no retry");
    await act(async () => retry.click());
    await eventually(() =>
      expect(document.body.textContent).toContain(
        "A linked agent run was verified for this approval.",
      ),
    );
    expect(requests()).toHaveLength(2);
    expect(new Set(requests().map((request) => request.path))).toEqual(
      new Set([`/api/v1/agent-routines/runs/by-approval/${APPROVAL_ID}`]),
    );
  });
});

describe("approval-agent-evidence-api contract", () => {
  it("decodes a sequence snapshot and rejects duplicate step positions", () => {
    const evidence = decodeAgentOriginEvidence(
      run({
        output_kind: "sequence",
        draft_preview: {
          kind: "sequence",
          name: "Onboarding",
          steps: [
            { position: 1, delay_hours: 0, subject: "Hi", body: "<b>One</b>" },
            { position: 2, delay_hours: 48, subject: "Tip", body: "Two" },
          ],
        },
      }),
      APPROVAL_ID,
    );
    expect(evidence.draftPreview).toEqual({
      kind: "sequence",
      name: "Onboarding",
      steps: [
        { position: 1, delayHours: 0, subject: "Hi", body: "<b>One</b>" },
        { position: 2, delayHours: 48, subject: "Tip", body: "Two" },
      ],
    });
    expect(() =>
      decodeAgentOriginEvidence(
        run({
          draft_preview: {
            kind: "sequence",
            name: "x",
            steps: [
              { position: 1, delay_hours: 0, subject: "a", body: "b" },
              { position: 1, delay_hours: 1, subject: "c", body: "d" },
            ],
          },
        }),
        APPROVAL_ID,
      ),
    ).toThrow(AgentEvidenceContractError);
    expect(() =>
      decodeAgentOriginEvidence(run({ approval_id: undefined }), APPROVAL_ID),
    ).toThrow("linked to a different approval");
    expect(() =>
      decodeAgentOriginEvidence(
        run({ reasoning: "hidden \u202e override" }),
        APPROVAL_ID,
      ),
    ).toThrow(AgentEvidenceContractError);
    expect(htmlToReadableText("<p>a &amp;lt; b</p><li>c</li>")).toBe(
      "a &lt; b\n• c",
    );
  });
});
