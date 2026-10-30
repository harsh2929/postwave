// @vitest-environment happy-dom

import { readFileSync } from "node:fs";
import { act } from "react";
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

const mocks = vi.hoisted(() => ({
  distribution: vi.fn(),
  subscribers: vi.fn(),
  onOpenSubscriber: vi.fn(),
}));

vi.mock("../../lib/api-client", () => ({
  engagementScoresApi: {
    distribution: mocks.distribution,
    subscribers: mocks.subscribers,
  },
}));

import { EngagementScoreSection } from "../../components/subscribers/EngagementScoreSection";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const distribution = {
  data: {
    buckets: [
      { range: "0–49", min: 0, max: 49, count: 4 },
      { range: "50–100", min: 50, max: 100, count: 6 },
    ],
  },
};

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
  vi.clearAllMocks();
  mocks.distribution.mockResolvedValue(distribution);
  mocks.subscribers.mockResolvedValue({
    data: {
      items: [
        {
          id: "subscriber-1",
          email: "alice@example.test",
          score: 72,
        },
      ],
      total: 1,
      page: 1,
      per_page: 25,
    },
  });
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
  vi.clearAllMocks();
});

function renderSection(): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root?.render(
      <EngagementScoreSection onOpenSubscriber={mocks.onOpenSubscriber} />,
    ),
  );
}

async function flushEffects(): Promise<void> {
  for (let index = 0; index < 5; index += 1) {
    await act(async () => Promise.resolve());
  }
}

function click(element: Element | null): void {
  expect(element).not.toBeNull();
  act(() => (element as HTMLElement).click());
}

function buttonByText(text: string): HTMLButtonElement | null {
  return (
    Array.from(container?.querySelectorAll("button") ?? []).find(
      (button) => button.textContent?.trim() === text,
    ) ?? null
  );
}

function buttonContainingText(text: string): HTMLButtonElement | null {
  return (
    Array.from(container?.querySelectorAll("button") ?? []).find((button) =>
      button.textContent?.includes(text),
    ) ?? null
  );
}

describe("EngagementScoreSection", () => {
  it("loads the distribution, browses a slice, and opens the selected subscriber", async () => {
    renderSection();
    await flushEffects();

    expect(mocks.distribution).toHaveBeenCalledTimes(1);
    expect(container?.textContent).toContain("10 scored subscribers");
    expect(container?.querySelector("table.data-table")).not.toBeNull();
    expect(container?.textContent).toContain(
      "Moosewave engagement-score distribution API",
    );
    expect(container?.textContent).toContain("Export data CSV");
    click(buttonContainingText("Scores 50–100"));
    await flushEffects();

    expect(mocks.subscribers).toHaveBeenCalledWith({
      min: 50,
      max: 100,
      page: 1,
      perPage: 25,
    });
    expect(container?.textContent).toContain("alice@example.test");
    expect(container?.textContent).toContain("Page 1 of 1 · 1 shown of 1");
    click(
      container?.querySelector(
        'button[aria-label="Open subscriber alice@example.test"]',
      ) ?? null,
    );
    expect(mocks.onOpenSubscriber).toHaveBeenCalledWith(
      "subscriber-1",
      "alice@example.test",
    );
    expect(container?.querySelectorAll("button[title]")).toHaveLength(0);
  });

  it("keeps the latest browse request when an older range resolves last", async () => {
    const first = deferred<{
      data: {
        items: Array<{ id: string; email: string; score: number }>;
        total: number;
        page: number;
        per_page: number;
      };
    }>();
    const second = deferred<{
      data: {
        items: Array<{ id: string; email: string; score: number }>;
        total: number;
        page: number;
        per_page: number;
      };
    }>();
    mocks.subscribers
      .mockReset()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    renderSection();
    await flushEffects();

    click(buttonByText("Browse by score"));
    expect(mocks.subscribers).toHaveBeenNthCalledWith(1, {
      page: 1,
      perPage: 25,
    });
    click(buttonContainingText("Scores 50–100"));
    expect(mocks.subscribers).toHaveBeenNthCalledWith(2, {
      min: 50,
      max: 100,
      page: 1,
      perPage: 25,
    });

    await act(async () => {
      second.resolve({
        data: {
          items: [{ id: "current", email: "current@example.test", score: 88 }],
          total: 1,
          page: 1,
          per_page: 25,
        },
      });
      await second.promise;
    });
    expect(container?.textContent).toContain("current@example.test");

    await act(async () => {
      first.resolve({
        data: {
          items: [{ id: "stale", email: "stale@example.test", score: 12 }],
          total: 1,
          page: 1,
          per_page: 25,
        },
      });
      await first.promise;
    });
    expect(container?.textContent).toContain("current@example.test");
    expect(container?.textContent).not.toContain("stale@example.test");
  });

  it("hides only an unavailable 404 and keeps permission failures retryable", async () => {
    mocks.distribution.mockResolvedValueOnce({
      error: { kind: "http", status: 404, message: "Not found" },
    });
    renderSection();
    await flushEffects();
    expect(container?.querySelector('[role="region"]')).toBeNull();

    act(() => root?.unmount());
    root = null;
    container?.replaceChildren();
    mocks.distribution
      .mockReset()
      .mockResolvedValueOnce({
        error: { kind: "http", status: 403, message: "Forbidden" },
      })
      .mockResolvedValueOnce(distribution);
    root = createRoot(container!);
    act(() =>
      root?.render(
        <EngagementScoreSection onOpenSubscriber={mocks.onOpenSubscriber} />,
      ),
    );
    await flushEffects();

    expect(container?.querySelector('[role="region"]')).not.toBeNull();
    expect(container?.textContent).toContain(
      "Couldn't load score distribution: Forbidden",
    );
    click(buttonByText("Retry"));
    await flushEffects();
    expect(mocks.distribution).toHaveBeenCalledTimes(2);
    expect(container?.textContent).toContain("10 scored subscribers");
  });

  it("turns thrown distribution and browse failures into actionable states", async () => {
    mocks.distribution.mockRejectedValueOnce(new Error("Network offline"));
    renderSection();
    await flushEffects();

    expect(container?.textContent).toContain(
      "Couldn't load score distribution: Network offline",
    );
    click(buttonByText("Retry"));
    await flushEffects();
    expect(container?.textContent).toContain("10 scored subscribers");

    mocks.subscribers.mockRejectedValueOnce(new Error("Browse offline"));
    click(buttonByText("Browse by score"));
    await flushEffects();
    expect(container?.textContent).toContain("Browse offline");
    expect(container?.querySelector('[role="alert"]')).not.toBeNull();
  });

  it("keeps the controller/presentation boundary and removes the ratchet", () => {
    const source = readFileSync(
      "src/components/subscribers/EngagementScoreSection.tsx",
      "utf8",
    );
    expect(source).toContain("useEngagementScoreSectionController");
    expect(source).toContain("EngagementScoreSectionPresentation");
    expect(source).toMatch(
      /const controller = useEngagementScoreSectionController\(\);/,
    );
    const budgets = readFileSync(
      "scripts/function-quality-budgets.json",
      "utf8",
    );
    expect(budgets).not.toContain(
      '"src/components/subscribers/EngagementScoreSection.tsx"',
    );
  });
});
