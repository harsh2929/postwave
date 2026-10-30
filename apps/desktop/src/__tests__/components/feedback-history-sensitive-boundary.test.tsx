// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const feedback = vi.hoisted(() => ({ getHistory: vi.fn() }));

vi.mock("../../lib/api-client", () => ({ feedbackApi: feedback }));
vi.mock("../../lib/store", () => ({
  useCanAdmin: () => true,
  useRoleStatus: () => "ready",
  useMe: () => ({ user: "admin@example.test", tenant: "tenant-1" }),
}));

import { FeedbackHistoryPanel } from "../../components/deliverability/FeedbackHistoryPanel";
import { parseFeedbackHistory } from "../../components/deliverability/feedback-history-response-contract";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  feedback.getHistory.mockReset();
});

describe("feedback history sensitive boundary", () => {
  it("discards tenant and raw-provider evidence before React state", () => {
    const parsed = parseFeedbackHistory({
      bounces: [
        {
          id: 1,
          tenant_id: "tenant-secret-canary",
          subscriber_email: "Alice@Example.test",
          bounce_type: "hard",
          esp: "postmark",
          raw: { Authorization: "Bearer provider-secret-canary" },
          received_at: "2026-07-14T00:00:00Z",
        },
      ],
      complaints: [],
    });
    const state = JSON.stringify(parsed);
    expect(state).not.toContain("tenant-secret-canary");
    expect(state).not.toContain("provider-secret-canary");
    expect(state).not.toContain("Alice@Example.test");
    expect(state).not.toContain("raw");
  });

  it("preserves mailbox case until invariant server canonicalization", async () => {
    feedback.getHistory.mockResolvedValue({
      data: { bounces: [], complaints: [] },
    });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root?.render(<FeedbackHistoryPanel />));

    const input =
      container.querySelector<HTMLInputElement>("input[type=email]");
    const form = container.querySelector<HTMLFormElement>("form");
    if (!input || !form) throw new Error("feedback form did not render");
    act(() => {
      input.value = "  Alice.Tag+News@Example.COM  ";
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      form.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
      await Promise.resolve();
    });

    expect(feedback.getHistory).toHaveBeenCalledWith(
      "Alice.Tag+News@Example.COM",
    );
    expect(container.textContent).toContain("never in the URL");
    expect(container.textContent).toContain("not cached");
  });
});
