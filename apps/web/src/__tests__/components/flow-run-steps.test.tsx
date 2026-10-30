// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-only
//
// The inspector must make a RETRY visible.
//
// That is the whole reason this view exists. A `flow_runs` row carries ONE
// status for the traversal, so a run whose node failed and then succeeded reads
// as "completed" and the failure disappears. If this component collapses the two
// attempts, it reproduces the exact blindness it was built to remove.

import { act, createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { trackRoot, unmountRoots } from "../_roots";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const listRunSteps = vi.fn();
vi.mock("@/lib/flows-api", () => ({
  flowsApi: {
    listRunSteps: (...args: unknown[]) => listRunSteps(...args),
  },
}));
// The panel renders relative times; the real component pulls in more than this
// test needs and its output is time-dependent.
vi.mock("@/components/relative-time", () => ({
  RelativeTime: ({ iso }: { iso: string }) => createElement("time", null, iso),
}));
vi.mock("@/components/ui/skeleton", () => ({
  Skeleton: () => createElement("div", { "data-testid": "skeleton" }),
}));

const { FlowRunSteps } = await import(
  "@/app/(dashboard)/app/flows/_components/flow-run-steps"
);
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");

let host: HTMLDivElement | null = null;
afterEach(() => {
  unmountRoots();
  host?.remove();
  host = null;
  listRunSteps.mockReset();
});

async function renderSteps() {
  host = document.createElement("div");
  document.body.appendChild(host);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const root = trackRoot(host);
  await act(async () => {
    root.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(FlowRunSteps, { runId: "run-1" }),
      ),
    );
  });
  // Settle the query AND the re-render it causes.
  //
  // One microtask turn is not enough and the first version of this test failed
  // on it, reading the skeleton and reporting that the retry had been
  // collapsed. `isFetching() === 0` alone is also not enough — it says the data
  // landed, not that React has re-rendered with it — so each poll is wrapped in
  // `act`, which flushes the render.
  for (let i = 0; i < 20 && client.isFetching() > 0; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return host;
}

describe("FlowRunSteps", () => {
  it("shows BOTH attempts of a retried node, with the failure reason", async () => {
    listRunSteps.mockResolvedValue([
      {
        node_id: "send-welcome",
        action_kind: "send_email",
        applied: 0,
        skipped: 0,
        failed: 1,
        error: "smtp timeout",
        occurred_at: "2026-08-12T10:00:00Z",
      },
      {
        node_id: "send-welcome",
        action_kind: "send_email",
        applied: 1,
        skipped: 0,
        failed: 0,
        occurred_at: "2026-08-12T10:01:00Z",
      },
    ]);

    const el = await renderSteps();
    const text = el.textContent ?? "";
    const occurrences = (text.match(/send-welcome/g) ?? []).length;
    expect(
      occurrences,
      "the two attempts of one node were collapsed; a retry is invisible again",
    ).toBe(2);
    // The failure must survive the successful retry: it is what somebody came
    // here to read.
    expect(text).toContain("smtp timeout");
    expect(text).toContain("failed");
    expect(text).toContain("applied");
  });

  it("says 'none recorded' rather than showing an error for an empty run", async () => {
    listRunSteps.mockResolvedValue([]);
    const el = await renderSteps();
    const text = el.textContent ?? "";
    // A run that has not reached a node yet is ordinary. Rendering a failure
    // there teaches people to ignore the failure state.
    expect(text).toContain("No node attempts recorded");
    expect(text).not.toContain("Could not load");
  });
});
