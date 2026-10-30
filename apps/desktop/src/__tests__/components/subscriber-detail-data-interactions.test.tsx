// @vitest-environment happy-dom

import { act, type ReactElement } from "react";
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
  detail: vi.fn(),
  timeline: vi.fn(),
  activity: vi.fn(),
  history: vi.fn(),
  engagement: vi.fn(),
}));

vi.mock("../../lib/api-client", () => ({
  api: {
    getSubscriber: mocks.detail,
    getSubscriberActivity: mocks.activity,
    getSubscriberEngagement: mocks.engagement,
  },
  getSubscriberTimeline: mocks.timeline,
  listSubscriberHistory: mocks.history,
}));

vi.mock("../../lib/event-bus", () => ({
  useEventSubscription: vi.fn(),
}));

import {
  useSubscriberDetailData,
  useSubscriberNavigation,
} from "../../components/subscribers/useSubscriberDetailData";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  mocks.detail.mockReset();
  mocks.timeline.mockReset().mockResolvedValue({
    data: { subscriber_id: "subscriber-1", events: [] },
  });
  mocks.activity.mockReset().mockResolvedValue({ data: [] });
  mocks.history.mockReset().mockResolvedValue({ data: { items: [] } });
  mocks.engagement.mockReset().mockResolvedValue({ data: null });
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
});

function render(node: ReactElement): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(node));
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function DataHarness(): ReactElement {
  const data = useSubscriberDetailData({
    id: "subscriber-1",
    email: "durable@example.test",
  });
  return (
    <div>
      <span data-testid="loading">{String(data.loadingDetail)}</span>
      <span data-testid="error">{data.detailError}</span>
      <span data-testid="email">{data.detail.email}</span>
      <span data-testid="timeline-subscriber">
        {data.timeline?.subscriber_id}
      </span>
      <span data-testid="activity-count">{data.legacyActivity?.length}</span>
      <span data-testid="history-count">{data.history?.length}</span>
      <span data-testid="history-has-more">{String(data.historyHasMore)}</span>
      <button type="button" data-testid="retry" onClick={data.reloadDetail}>
        Retry
      </button>
      <button
        type="button"
        data-testid="engagement"
        onClick={() => data.setTab("engagement")}
      >
        Engagement
      </button>
      <button
        type="button"
        data-testid="history"
        onClick={() => data.setTab("history")}
      >
        History
      </button>
      <button
        type="button"
        data-testid="history-more"
        onClick={() => void data.loadMoreHistory()}
      >
        Older
      </button>
    </div>
  );
}

function NavigationHarness({
  onNavigate,
  blocked = false,
}: {
  onNavigate: (delta: -1 | 1) => void;
  blocked?: boolean;
}): ReactElement {
  useSubscriberNavigation({
    navIndex: 1,
    navTotal: 3,
    onNavigate,
    blocked,
  });
  return <input aria-label="Editable field" />;
}

describe("subscriber detail data interaction contract", () => {
  it("contains a thrown fanout, preserves durable data, and recovers on retry", async () => {
    mocks.detail
      .mockRejectedValueOnce(new Error("subscriber gateway unavailable"))
      .mockResolvedValueOnce({
        data: { id: "subscriber-1", email: "fresh@example.test" },
      });
    render(<DataHarness />);
    await settle();
    expect(document.querySelector('[data-testid="loading"]')?.textContent).toBe(
      "false",
    );
    expect(
      document.querySelector('[data-testid="error"]')?.textContent,
    ).toContain("subscriber gateway unavailable");
    expect(document.querySelector('[data-testid="email"]')?.textContent).toBe(
      "durable@example.test",
    );

    act(() =>
      document
        .querySelector<HTMLButtonElement>('[data-testid="retry"]')
        ?.click(),
    );
    await settle();
    await settle();
    expect(mocks.detail).toHaveBeenCalledTimes(2);
    expect(document.querySelector('[data-testid="error"]')?.textContent).toBe(
      "",
    );
    expect(document.querySelector('[data-testid="email"]')?.textContent).toBe(
      "fresh@example.test",
    );
  });

  it("does not steal navigation arrows from IME composition or editable controls", () => {
    const onNavigate = vi.fn();
    render(<NavigationHarness onNavigate={onNavigate} />);
    act(() => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          bubbles: true,
          key: "ArrowRight",
          isComposing: true,
        }),
      );
    });
    expect(onNavigate).not.toHaveBeenCalled();

    const input = document.querySelector("input")!;
    act(() => {
      input.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, key: "ArrowRight" }),
      );
    });
    expect(onNavigate).not.toHaveBeenCalled();

    act(() => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, key: "ArrowRight" }),
      );
    });
    expect(onNavigate).toHaveBeenCalledWith(1);
  });

  it("does not navigate to another subscriber while a detail mutation is busy", () => {
    const onNavigate = vi.fn();
    render(<NavigationHarness onNavigate={onNavigate} blocked />);

    act(() => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, key: "ArrowRight" }),
      );
    });

    expect(onNavigate).not.toHaveBeenCalled();
  });

  it("keeps the verified timeline when a refresh returns another subscriber", async () => {
    mocks.detail.mockResolvedValue({
      data: { id: "subscriber-1", email: "fresh@example.test" },
    });
    mocks.timeline
      .mockResolvedValueOnce({
        data: { subscriber_id: "subscriber-1", events: [] },
      })
      .mockResolvedValueOnce({
        data: { subscriber_id: "subscriber-other", events: [] },
      });
    mocks.activity.mockResolvedValue({
      data: [{ type: "sent", at: "2026-07-18T10:00:00.000Z" }],
    });
    mocks.history.mockResolvedValue({
      data: { items: [{ id: "history-1" }] },
    });
    render(<DataHarness />);
    await settle();
    expect(
      document.querySelector('[data-testid="timeline-subscriber"]')
        ?.textContent,
    ).toBe("subscriber-1");
    expect(mocks.activity).not.toHaveBeenCalled();
    expect(mocks.history).not.toHaveBeenCalled();

    act(() =>
      document
        .querySelector<HTMLButtonElement>('[data-testid="engagement"]')
        ?.click(),
    );
    await settle();
    await settle();
    expect(mocks.activity).toHaveBeenCalledTimes(1);
    expect(
      document.querySelector('[data-testid="activity-count"]')?.textContent,
    ).toBe("1");

    act(() =>
      document
        .querySelector<HTMLButtonElement>('[data-testid="history"]')
        ?.click(),
    );
    await settle();
    await settle();
    expect(
      document.querySelector('[data-testid="history-count"]')?.textContent,
    ).toBe("1");

    act(() =>
      document
        .querySelector<HTMLButtonElement>('[data-testid="retry"]')
        ?.click(),
    );
    await settle();
    expect(
      document.querySelector('[data-testid="timeline-subscriber"]')
        ?.textContent,
    ).toBe("subscriber-1");
    expect(
      document.querySelector('[data-testid="activity-count"]')?.textContent,
    ).toBe("1");
    expect(
      document.querySelector('[data-testid="history-count"]')?.textContent,
    ).toBe("1");
    expect(
      document.querySelector('[data-testid="error"]')?.textContent,
    ).toContain("different subscriber");
    expect(mocks.activity).toHaveBeenCalledTimes(1);
    expect(mocks.history).toHaveBeenCalledTimes(1);
  });

  it("threads abort signals into owned requests and aborts them on close", async () => {
    let resolveDetail: ((value: unknown) => void) | undefined;
    let resolveTimeline: ((value: unknown) => void) | undefined;
    mocks.detail.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveDetail = resolve;
        }),
    );
    mocks.timeline.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveTimeline = resolve;
        }),
    );

    render(<DataHarness />);
    const detailSignal = mocks.detail.mock.calls[0]?.[1]?.signal as
      | AbortSignal
      | undefined;
    const timelineSignal = mocks.timeline.mock.calls[0]?.[1]?.signal as
      | AbortSignal
      | undefined;
    expect(detailSignal?.aborted).toBe(false);
    expect(timelineSignal?.aborted).toBe(false);

    act(() => root?.unmount());
    root = null;
    expect(detailSignal?.aborted).toBe(true);
    expect(timelineSignal?.aborted).toBe(true);

    resolveDetail?.({ data: null });
    resolveTimeline?.({ data: null });
    await settle();
  });

  it("paginates history without duplicate rows or same-tick duplicate requests", async () => {
    let resolveOlder: ((value: unknown) => void) | undefined;
    mocks.detail.mockResolvedValue({
      data: { id: "subscriber-1", email: "fresh@example.test" },
    });
    mocks.history
      .mockResolvedValueOnce({
        data: {
          subscriber_id: "subscriber-1",
          items: [{ id: "history-1", subscriber_id: "subscriber-1" }],
          next_cursor: "cursor-one",
        },
      })
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveOlder = resolve;
          }),
      );
    render(<DataHarness />);
    await settle();

    act(() =>
      document
        .querySelector<HTMLButtonElement>('[data-testid="history"]')
        ?.click(),
    );
    await settle();
    expect(
      document.querySelector('[data-testid="history-count"]')?.textContent,
    ).toBe("1");
    expect(
      document.querySelector('[data-testid="history-has-more"]')?.textContent,
    ).toBe("true");

    act(() => {
      const button = document.querySelector<HTMLButtonElement>(
        '[data-testid="history-more"]',
      );
      button?.click();
      button?.click();
    });
    expect(mocks.history).toHaveBeenCalledTimes(2);
    expect(mocks.history.mock.calls[1]?.[1]).toMatchObject({
      limit: 50,
      before: "cursor-one",
      signal: expect.any(AbortSignal),
    });

    await act(async () => {
      resolveOlder?.({
        data: {
          subscriber_id: "subscriber-1",
          items: [
            { id: "history-1", subscriber_id: "subscriber-1" },
            { id: "history-2", subscriber_id: "subscriber-1" },
          ],
        },
      });
      await Promise.resolve();
    });
    expect(
      document.querySelector('[data-testid="history-count"]')?.textContent,
    ).toBe("2");
    expect(
      document.querySelector('[data-testid="history-has-more"]')?.textContent,
    ).toBe("false");
  });
});
