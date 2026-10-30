// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// The web Copilot rail (AI-feature parity): generating surfaces AI subject
// ideas the user can apply, each shown under the AI-interaction disclosure.
import { act, createElement } from "react";
import type { ReactNode } from "react";
import type { Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

import { trackRoot, unmountRoots } from "../_roots";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@/lib/clipboard", () => ({
  copyToClipboard: vi.fn(async () => true),
  isClipboardAvailable: () => true,
}));

// With a campaignId the rail also mounts its campaign-bound sections, which
// read the caller's identity; those sections have their own suite
// (campaign-copilot-sections.test.tsx). Here identity never resolves, so no
// request leaves the test.
vi.mock("@/lib/auth-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth-api")>()),
  whoami: vi.fn(() => new Promise(() => {})),
}));

import { CopilotRail } from "@/components/ai/copilot-rail";
import type { ContentOptimizerPreview } from "@/lib/content-optimizer-api";

afterEach(() => {
  unmountRoots();
  vi.clearAllMocks();
  document.body.replaceChildren();
});

function render(ui: ReactNode): Root {
  const container = document.createElement("div");
  document.body.append(container);
  const root = trackRoot(container);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrap = (node: ReactNode) =>
    createElement(QueryClientProvider, { client }, node);
  act(() => root.render(wrap(ui)));
  // Re-renders keep the same provider, as the app shell does.
  return {
    render: (node: ReactNode) => root.render(wrap(node)),
    unmount: () => root.unmount(),
  };
}

const wait = (ms = 0) => new Promise((r) => window.setTimeout(r, ms));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function findButton(label: string): HTMLButtonElement | undefined {
  return Array.from(document.querySelectorAll("button")).find((b) =>
    b.textContent?.includes(label),
  ) as HTMLButtonElement | undefined;
}

describe("CopilotRail", () => {
  it("generates subject ideas and applies a chosen one", async () => {
    const generate = vi.fn(async () => ["Big news inside", "Your July recap"]);
    const onApplySubject = vi.fn();

    render(
      createElement(CopilotRail, {
        subject: "monthly update",
        generate,
        onApplySubject,
      }),
    );

    await act(async () => {
      findButton("Generate")!.dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
      await wait(0);
    });

    expect(generate).toHaveBeenCalledWith(
      "monthly update",
      expect.any(AbortSignal),
    );
    const ideas = document.querySelector(
      '[data-testid="copilot-subject-ideas"]',
    );
    expect(ideas?.textContent).toContain("Big news inside");
    expect(ideas?.textContent).toContain("Your July recap");

    // Applying an idea calls back into the editor.
    await act(async () => {
      findButton("Apply")!.dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
      await wait(0);
    });
    expect(onApplySubject).toHaveBeenCalledWith("Big news inside");
  });

  it("surfaces a friendly error when generation fails", async () => {
    const generate = vi.fn(async () => {
      throw new Error("boom");
    });
    render(createElement(CopilotRail, { subject: "x", generate }));
    await act(async () => {
      findButton("Generate")!.dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
      await wait(0);
    });
    expect(document.body.textContent).toContain(
      "Couldn't reach the AI service",
    );
  });

  it("keeps the newest subject request when an older response arrives last", async () => {
    const first = deferred<string[]>();
    const second = deferred<string[]>();
    const signals: AbortSignal[] = [];
    const generate = vi.fn((value: string, signal?: AbortSignal) => {
      if (signal) signals.push(signal);
      return value === "first subject" ? first.promise : second.promise;
    });
    const root = render(
      createElement(CopilotRail, { subject: "first subject", generate }),
    );

    await act(async () => {
      findButton("Generate")!.click();
      await wait(0);
    });
    await act(async () => {
      root.render(
        createElement(CopilotRail, { subject: "second subject", generate }),
      );
      await wait(0);
    });
    expect(signals[0]?.aborted).toBe(true);
    await act(async () => {
      findButton("Generate")!.click();
      second.resolve(["Newest idea"]);
      await wait(0);
    });
    expect(document.body.textContent).toContain("Newest idea");

    await act(async () => {
      first.resolve(["Stale idea"]);
      await wait(0);
    });
    expect(document.body.textContent).toContain("Newest idea");
    expect(document.body.textContent).not.toContain("Stale idea");
  });

  it("deduplicates same-tick generation clicks", async () => {
    const pending = deferred<string[]>();
    const generate = vi.fn(() => pending.promise);
    render(createElement(CopilotRail, { subject: "one subject", generate }));

    await act(async () => {
      const trigger = findButton("Generate")!;
      trigger.click();
      trigger.click();
      await wait(0);
    });

    expect(generate).toHaveBeenCalledTimes(1);
    await act(async () => {
      pending.resolve(["Only idea"]);
      await wait(0);
    });
  });

  it("drops blank and duplicate ideas before rendering actionable rows", async () => {
    const generate = vi.fn(async () => [
      "Same idea",
      " Same idea ",
      "",
      "Other idea",
    ]);
    render(createElement(CopilotRail, { subject: "one subject", generate }));

    await act(async () => {
      findButton("Generate")!.click();
      await wait(0);
    });

    expect(
      document.querySelectorAll('[data-testid="copilot-subject-ideas"] li'),
    ).toHaveLength(2);
    expect(document.body.textContent).toContain("Same idea");
    expect(document.body.textContent).toContain("Other idea");
  });

  it("shows nothing AI-generated (and no disclosure) before first run", () => {
    render(createElement(CopilotRail, { subject: "x", generate: vi.fn() }));
    expect(
      document.querySelector('[data-testid="copilot-subject-ideas"]'),
    ).toBeNull();
  });

  it("omits the content-optimizer section without a campaignId", () => {
    render(createElement(CopilotRail, { subject: "x", generate: vi.fn() }));
    expect(
      document.querySelector('[data-testid="copilot-optimizer"]'),
    ).toBeNull();
  });

  it("previews the content-optimizer allocation when given a campaignId (CAMP-045)", async () => {
    const previewOptimizer = vi.fn(async () => ({
      campaign_id: "c1",
      method: "thompson",
      primary_metric: "open_rate",
      exploration_rate: 0.1,
      min_sample_per_arm: 100,
      generated_at: "2026-07-26T00:00:00Z",
      recommended_arms: [
        {
          key: "control",
          subject: "Original subject",
          allocation_percent: 62,
          exploration_percent: 10,
          exploitation_percent: 52,
          score: 0.31,
          reason: "Highest observed open rate",
        },
        {
          key: "variant-b",
          subject: "Bolder subject",
          allocation_percent: 38,
          exploration_percent: 10,
          exploitation_percent: 28,
          score: 0.24,
          reason: "Under-sampled — exploring",
        },
      ],
    }));

    render(
      createElement(CopilotRail, {
        subject: "x",
        generate: vi.fn(),
        campaignId: "c1",
        previewOptimizer,
      }),
    );

    await act(async () => {
      findButton("Preview")!.dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
      await wait(0);
    });

    expect(previewOptimizer).toHaveBeenCalledWith(
      "c1",
      expect.any(AbortSignal),
    );
    const arms = document.querySelector(
      '[data-testid="copilot-optimizer-arms"]',
    );
    expect(arms?.textContent).toContain("Original subject");
    expect(arms?.textContent).toContain("62%");
    expect(arms?.textContent).toContain("Under-sampled — exploring");
  });

  it("does not paint an optimizer response for a campaign that is no longer open", async () => {
    const first = deferred<ContentOptimizerPreview>();
    const second = deferred<ContentOptimizerPreview>();
    const signals: AbortSignal[] = [];
    const previewOptimizer = vi.fn(
      (campaignId: string, signal?: AbortSignal) => {
        if (signal) signals.push(signal);
        return campaignId === "c1" ? first.promise : second.promise;
      },
    );
    const root = render(
      createElement(CopilotRail, {
        subject: "x",
        campaignId: "c1",
        previewOptimizer,
      }),
    );

    await act(async () => {
      findButton("Preview")!.click();
      await wait(0);
    });
    await act(async () => {
      root.render(
        createElement(CopilotRail, {
          subject: "x",
          campaignId: "c2",
          previewOptimizer,
        }),
      );
      await wait(0);
    });
    expect(signals[0]?.aborted).toBe(true);
    await act(async () => {
      findButton("Preview")!.click();
      second.resolve({
        campaign_id: "c2",
        method: "thompson",
        primary_metric: "open_rate",
        exploration_rate: 0.1,
        min_sample_per_arm: 100,
        generated_at: "2026-08-27T00:00:00Z",
        recommended_arms: [
          {
            key: "new",
            subject: "Newest allocation",
            allocation_percent: 100,
            exploration_percent: 0,
            exploitation_percent: 100,
            score: 1,
            reason: "Current campaign",
          },
        ],
      });
      await wait(0);
    });

    first.resolve({
      campaign_id: "c1",
      method: "thompson",
      primary_metric: "open_rate",
      exploration_rate: 0.1,
      min_sample_per_arm: 100,
      generated_at: "2026-08-27T00:00:00Z",
      recommended_arms: [
        {
          key: "old",
          subject: "Stale allocation",
          allocation_percent: 100,
          exploration_percent: 0,
          exploitation_percent: 100,
          score: 1,
          reason: "Old campaign",
        },
      ],
    });
    await act(async () => {
      await wait(0);
    });

    expect(document.body.textContent).toContain("Newest allocation");
    expect(document.body.textContent).not.toContain("Stale allocation");
  });
});
