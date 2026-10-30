// @vitest-environment happy-dom

import axe from "axe-core";
import { act, type ComponentProps, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import type {
  ContactHistoryEvent,
  SubscriberDetail,
} from "../../lib/api-client";

const mocks = vi.hoisted(() => ({
  contactRatingGet: vi.fn(),
  contactRatingRecompute: vi.fn(),
  engagementScoreGet: vi.fn(),
  getSubscriber: vi.fn(),
  getSubscriberAISummary: vi.fn(),
  listSubscriberHistory: vi.fn(),
  setSubscriberRating: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("../../lib/api-client", () => ({
  api: { getSubscriber: mocks.getSubscriber },
  contactRatingsApi: {
    get: mocks.contactRatingGet,
    recompute: mocks.contactRatingRecompute,
  },
  engagementScoresApi: { get: mocks.engagementScoreGet },
  getSubscriberAISummary: mocks.getSubscriberAISummary,
  listSubscriberHistory: mocks.listSubscriberHistory,
  setSubscriberRating: mocks.setSubscriberRating,
}));

vi.mock("../../components/Toast", () => ({
  toast: {
    error: mocks.toastError,
    success: mocks.toastSuccess,
  },
}));

import { SubscriberInsightsPanel } from "../../components/subscribers/SubscriberInsightsPanel";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & {
      IS_REACT_ACT_ENVIRONMENT?: boolean;
    }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.getSubscriberAISummary.mockResolvedValue({
    data: {
      summary: "Highly engaged repeat buyer.",
      drivers: [
        { key: "orders", label: "Orders", value: "8 completed orders" },
      ],
      last_updated: "2026-07-15T08:00:00.000Z",
      cache_hit: true,
      source: "ai",
    },
  });
  mocks.engagementScoreGet.mockResolvedValue({
    data: { score: 72, computed_at: "2026-07-14T08:00:00.000Z" },
  });
  mocks.contactRatingGet.mockResolvedValue({
    data: {
      subscriber_id: "subscriber-1",
      stars: 3,
      engagement_score: 72,
      engagement_score_at: "2026-07-14T08:00:00.000Z",
      source: "heuristic",
    },
  });
  mocks.setSubscriberRating.mockResolvedValue({ data: { rating: 4 } });
  mocks.listSubscriberHistory.mockResolvedValue({
    data: { items: [historyEvent()] },
  });
  mocks.contactRatingRecompute.mockResolvedValue({
    data: {
      updated: 5,
      scanned: 10,
      window_days: 90,
      started_at: "2026-07-15T08:00:00.000Z",
      finished_at: "2026-07-15T08:00:01.000Z",
    },
  });
  mocks.getSubscriber.mockResolvedValue({ data: detail({ rating: 5 }) });
});

afterEach(() => {
  if (root) {
    const currentRoot = root;
    act(() => currentRoot.unmount());
    root = null;
  }
  container?.remove();
  container = null;
  document.body.replaceChildren();
  vi.clearAllMocks();
});

type SubscriberDetailWithRating = SubscriberDetail & {
  rating?: number | null;
};

function detail(
  overrides: Partial<SubscriberDetailWithRating> = {},
): SubscriberDetailWithRating {
  return {
    id: "subscriber-1",
    email: "reader@example.com",
    rating: 3,
    prediction: {
      historic_clv_cents: 12_500,
      predicted_clv_cents: 8_000,
      total_clv_cents: 20_500,
      churn_risk: 0.72,
      confidence: 0.84,
      data_sufficiency: "sufficient",
      churn_drivers: [
        {
          key: "recency",
          label: "Purchase recency",
          value: "62 days since purchase",
          impact: "high",
        },
      ],
      calculated_at: "2026-07-14T08:00:00.000Z",
    },
    ...overrides,
  } as SubscriberDetailWithRating;
}

function historyEvent(): ContactHistoryEvent {
  return {
    id: "history-1",
    tenant_id: "tenant-1",
    subscriber_id: "subscriber-1",
    kind: "rating.changed",
    at: "2026-07-15T08:00:00.000Z",
    payload: { rating: 4 },
  };
}

function panel(
  overrides: Partial<ComponentProps<typeof SubscriberInsightsPanel>> = {},
): ReactElement {
  return (
    <SubscriberInsightsPanel
      subscriberId="subscriber-1"
      detail={detail()}
      canMutate
      onHistoryChange={vi.fn()}
      formatRelativeTime={() => "recently"}
      {...overrides}
    />
  );
}

function render(node: ReactElement): {
  rerender: (next: ReactElement) => void;
} {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(node));
  return {
    rerender(next) {
      act(() => root?.render(next));
    },
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function waitFor(assertion: () => void): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 30; attempt += 1) {
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

describe("SubscriberInsightsPanel", () => {
  it("loads and renders AI, rating, engagement, prediction, and signal insights", async () => {
    render(panel());
    await waitFor(() => {
      expect(document.body.textContent).toContain(
        "Highly engaged repeat buyer.",
      );
      expect(document.body.textContent).toContain("72/100");
      expect(document.body.textContent).toContain("Sufficient data");
      expect(document.body.textContent).toContain("High risk");
    });

    expect(mocks.getSubscriberAISummary).toHaveBeenCalledWith("subscriber-1", {
      refresh: false,
    });
    expect(mocks.engagementScoreGet).toHaveBeenCalledWith("subscriber-1");
    expect(mocks.contactRatingGet).toHaveBeenCalledWith("subscriber-1");
    expect(
      document.querySelector('[role="radiogroup"][aria-label="Rating"]'),
    ).not.toBeNull();
    expect(
      document
        .querySelector<HTMLButtonElement>(
          'button[role="radio"][aria-label="3 stars"]',
        )
        ?.getAttribute("aria-checked"),
    ).toBe("true");
    expect(document.body.textContent).toContain(
      "Currency-safe value insights unavailable",
    );
    expect(document.body.textContent).not.toContain("$125");
    expect(document.body.textContent).not.toContain("$205");
  });

  it("expands explanation drivers and refreshes the AI summary bypassing cache", async () => {
    render(panel());
    await waitFor(() => {
      expect(document.body.textContent).toContain(
        "Highly engaged repeat buyer.",
      );
    });
    const explanation = Array.from(document.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("Why is this person here?"),
    );
    expect(explanation?.getAttribute("aria-expanded")).toBe("false");
    act(() => explanation?.click());
    expect(explanation?.getAttribute("aria-expanded")).toBe("true");
    expect(document.body.textContent).toContain("8 completed orders");

    const refresh = Array.from(document.querySelectorAll("button")).find(
      (button) => button.textContent === "Refresh",
    );
    await act(async () => refresh?.click());
    expect(mocks.getSubscriberAISummary).toHaveBeenLastCalledWith(
      "subscriber-1",
      { refresh: true },
    );
  });

  it("persists a manual rating and refreshes contact history", async () => {
    const onHistoryChange = vi.fn();
    render(panel({ onHistoryChange }));
    await waitFor(() => {
      expect(
        document.querySelector('button[role="radio"][aria-label="4 stars"]'),
      ).not.toBeNull();
    });
    const fourStars = document.querySelector<HTMLButtonElement>(
      'button[role="radio"][aria-label="4 stars"]',
    );
    await act(async () => fourStars?.click());

    expect(mocks.setSubscriberRating).toHaveBeenCalledWith("subscriber-1", 4);
    expect(mocks.listSubscriberHistory).toHaveBeenCalledWith("subscriber-1", {
      limit: 50,
    });
    expect(onHistoryChange).toHaveBeenCalledWith([historyEvent()], undefined);
    expect(fourStars?.getAttribute("aria-checked")).toBe("true");
  });

  it("serializes manual rating updates until history reconciliation finishes", async () => {
    const mutation = deferred<{ data: { rating: number } }>();
    mocks.setSubscriberRating.mockReturnValueOnce(mutation.promise);
    render(panel());
    await waitFor(() => {
      expect(document.body.textContent).toContain("3/5");
    });

    const fourStars = document.querySelector<HTMLButtonElement>(
      'button[role="radio"][aria-label="4 stars"]',
    );
    const fiveStars = document.querySelector<HTMLButtonElement>(
      'button[role="radio"][aria-label="5 stars"]',
    );
    act(() => fourStars?.click());
    expect(fourStars?.disabled).toBe(true);
    expect(fourStars?.getAttribute("aria-describedby")).toBeTruthy();
    expect(document.body.textContent).toContain("Saving rating");
    act(() => fiveStars?.click());
    expect(mocks.setSubscriberRating).toHaveBeenCalledTimes(1);

    await act(async () => {
      mutation.resolve({ data: { rating: 4 } });
      await mutation.promise;
    });
    await waitFor(() => expect(fourStars?.disabled).toBe(false));
    expect(fourStars?.getAttribute("aria-checked")).toBe("true");
  });

  it("rolls an optimistic rating back and surfaces the mutation error", async () => {
    mocks.setSubscriberRating.mockResolvedValue({
      error: { message: "Rating update failed" },
    });
    render(panel());
    await waitFor(() => {
      expect(document.body.textContent).toContain("3/5");
    });
    const fiveStars = document.querySelector<HTMLButtonElement>(
      'button[role="radio"][aria-label="5 stars"]',
    );
    await act(async () => fiveStars?.click());

    expect(mocks.toastError).toHaveBeenCalledWith(
      "Couldn't set rating: Rating update failed",
    );
    expect(document.body.textContent).toContain("3/5");
    expect(
      document
        .querySelector('button[role="radio"][aria-label="3 stars"]')
        ?.getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("renders honest unavailable and empty states without nagging", async () => {
    mocks.getSubscriberAISummary.mockResolvedValue({
      error: { kind: "http", status: 404, message: "Not found" },
    });
    mocks.engagementScoreGet.mockResolvedValue({
      error: { kind: "http", status: 404, message: "Not found" },
    });
    mocks.contactRatingGet.mockResolvedValue({
      error: { kind: "http", status: 404, message: "Not found" },
    });
    render(panel({ detail: detail({ prediction: null }) }));
    await waitFor(() => {
      expect(document.body.textContent).toContain(
        "No rating signal recorded yet",
      );
    });

    expect(document.body.textContent).not.toContain("AI summary");
    expect(document.body.textContent).not.toContain("Engagement score");
    expect(document.body.textContent).not.toContain("Insights");
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it("supports retry after a rating-signals error", async () => {
    mocks.contactRatingGet
      .mockResolvedValueOnce({
        error: { kind: "transport", message: "Network unavailable" },
      })
      .mockResolvedValueOnce({
        data: {
          subscriber_id: "subscriber-1",
          stars: 4,
          engagement_score: 72,
          source: "heuristic",
        },
      });
    render(panel());
    await waitFor(() => {
      expect(document.body.textContent).toContain("Network unavailable");
    });
    const retry = Array.from(document.querySelectorAll("button")).find(
      (button) => button.textContent === "Retry",
    );
    await act(async () => retry?.click());
    await waitFor(() => {
      expect(document.body.textContent).toContain("4/5");
    });
    expect(mocks.contactRatingGet).toHaveBeenCalledTimes(2);
  });

  it("gates mutations for viewers while preserving read-only insights", async () => {
    render(panel({ canMutate: false }));
    await waitFor(() => {
      expect(document.body.textContent).toContain(
        "Highly engaged repeat buyer.",
      );
    });
    const ratingButtons = document.querySelectorAll<HTMLButtonElement>(
      'button[role="radio"]',
    );
    expect(ratingButtons).toHaveLength(5);
    for (const button of ratingButtons) {
      expect(button.disabled).toBe(false);
      expect(button.getAttribute("aria-disabled")).toBe("true");
      act(() => button.click());
    }
    expect(mocks.setSubscriberRating).not.toHaveBeenCalled();
    const recompute = Array.from(document.querySelectorAll("button")).find(
      (button) => button.textContent === "Recompute (tenant-wide)",
    );
    expect(recompute?.disabled).toBe(false);
    expect(recompute?.getAttribute("aria-disabled")).toBe("true");
    act(() => recompute?.click());
    expect(mocks.contactRatingRecompute).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain(
      "Viewer role can't start rating recomputation",
    );
  });

  it("recomputes tenant-wide and reconciles the subscriber's rating", async () => {
    render(panel());
    await waitFor(() => {
      expect(document.body.textContent).toContain("3/5");
    });
    const recompute = Array.from(document.querySelectorAll("button")).find(
      (button) => button.textContent === "Recompute (tenant-wide)",
    );
    await act(async () => recompute?.click());

    expect(mocks.contactRatingRecompute).toHaveBeenCalledTimes(1);
    expect(mocks.getSubscriber).toHaveBeenCalledWith("subscriber-1");
    expect(mocks.toastSuccess).toHaveBeenCalledWith(
      expect.stringContaining("5 updated of 10 scanned"),
    );
    expect(document.body.textContent).toContain("5/5");
  });

  it("drops stale fetches and mutation completions after identity changes", async () => {
    const previousSummary = deferred<{
      data: {
        summary: string;
        drivers: never[];
        last_updated: string;
        cache_hit: boolean;
        source: "ai";
      };
    }>();
    const previousMutation = deferred<{ data: { rating: number } }>();
    mocks.getSubscriberAISummary
      .mockReturnValueOnce(previousSummary.promise)
      .mockResolvedValueOnce({
        data: {
          summary: "Second subscriber summary",
          drivers: [],
          last_updated: "2026-07-15T09:00:00.000Z",
          cache_hit: false,
          source: "ai",
        },
      });
    mocks.setSubscriberRating.mockReturnValueOnce(previousMutation.promise);
    const onHistoryChange = vi.fn();
    const view = render(panel({ onHistoryChange }));
    const fourStars = document.querySelector<HTMLButtonElement>(
      'button[role="radio"][aria-label="4 stars"]',
    );
    act(() => fourStars?.click());

    view.rerender(
      panel({
        subscriberId: "subscriber-2",
        detail: detail({ id: "subscriber-2", email: "second@example.com" }),
        onHistoryChange,
      }),
    );
    await waitFor(() => {
      expect(document.body.textContent).toContain("Second subscriber summary");
    });

    await act(async () => {
      previousSummary.resolve({
        data: {
          summary: "Previous subscriber secret",
          drivers: [],
          last_updated: "2026-07-14T09:00:00.000Z",
          cache_hit: false,
          source: "ai",
        },
      });
      previousMutation.resolve({ data: { rating: 4 } });
      await Promise.all([previousSummary.promise, previousMutation.promise]);
    });
    expect(document.body.textContent).not.toContain(
      "Previous subscriber secret",
    );
    expect(
      document
        .querySelector('button[role="radio"][aria-label="3 stars"]')
        ?.getAttribute("aria-checked"),
    ).toBe("true");
    expect(onHistoryChange).not.toHaveBeenCalled();
  });

  it("supports roving star keyboard selection without consuming IME navigation", async () => {
    render(panel());
    await waitFor(() => {
      expect(document.body.textContent).toContain("3/5");
    });
    const selected = document.querySelector<HTMLButtonElement>(
      'button[role="radio"][aria-label="3 stars"]',
    );
    if (!selected) throw new Error("Expected selected rating control");
    act(() => {
      selected.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "ArrowRight",
          bubbles: true,
          isComposing: true,
        }),
      );
    });
    expect(mocks.setSubscriberRating).not.toHaveBeenCalled();

    await act(async () => {
      selected.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
      );
    });
    expect(mocks.setSubscriberRating).toHaveBeenCalledWith("subscriber-1", 4);
    expect(document.activeElement?.getAttribute("aria-label")).toBe("4 stars");
  });

  it("has no serious automated accessibility violations with insight disclosures visible", async () => {
    render(panel());
    await waitFor(() => {
      expect(document.body.textContent).toContain(
        "Highly engaged repeat buyer",
      );
    });
    const details = document.querySelector("details");
    if (details) act(() => details.setAttribute("open", ""));
    const result = await axe.run(container!);
    expect(
      result.violations.filter((violation) =>
        ["serious", "critical"].includes(violation.impact ?? ""),
      ),
    ).toEqual([]);
  });
});
