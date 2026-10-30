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

const mocks = vi.hoisted(() => ({ timeline: vi.fn() }));

vi.mock("../../lib/api-client", () => ({
  api: {},
  getSubscriberTimeline: mocks.timeline,
}));

vi.mock("../../components/subscriber/TimelineEvent", () => ({
  TimelineEvent: ({ event }: { event: { subject?: string } }) => (
    <li>{event.subject}</li>
  ),
}));

import { Timeline } from "../../components/subscriber/Timeline";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  mocks.timeline.mockReset();
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
});

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

async function waitFor(assertion: () => void): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await act(async () => Promise.resolve());
    }
  }
  throw lastError;
}

function response(subscriberId: string, subject: string, hasMore = false) {
  return {
    data: {
      subscriber_id: subscriberId,
      events: [
        {
          type: "sent",
          occurred_at: "2026-07-18T10:00:00.000Z",
          subject,
        },
      ],
      pagination: { has_more: hasMore },
    },
  };
}

describe("subscriber Timeline response integrity", () => {
  it("keeps verified events through a mismatched refresh and offers retry", async () => {
    mocks.timeline
      .mockResolvedValueOnce(response("subscriber-1", "Verified event"))
      .mockResolvedValueOnce(response("subscriber-other", "Foreign event"))
      .mockResolvedValueOnce(response("subscriber-1", "Recovered event"));
    const onUnavailable = vi.fn();
    const view = render(
      <Timeline
        subscriberId="subscriber-1"
        pageSize={50}
        onUnavailable={onUnavailable}
      />,
    );
    await waitFor(() => {
      expect(document.body.textContent).toContain("Verified event");
    });

    view.rerender(
      <Timeline
        subscriberId="subscriber-1"
        pageSize={25}
        onUnavailable={onUnavailable}
      />,
    );
    await waitFor(() => {
      expect(document.body.textContent).toContain("different subscriber");
    });
    expect(document.body.textContent).toContain("Verified event");
    expect(document.body.textContent).not.toContain("Foreign event");

    await act(async () => {
      document.querySelector<HTMLButtonElement>("button")?.click();
    });
    await waitFor(() => {
      expect(document.body.textContent).toContain("Recovered event");
    });
    expect(document.body.textContent).not.toContain("Verified event");
    expect(onUnavailable).not.toHaveBeenCalled();
  });

  it("single-flights pagination and rejects another subscriber's page", async () => {
    mocks.timeline
      .mockResolvedValueOnce(response("subscriber-1", "Newest event", true))
      .mockResolvedValueOnce(response("subscriber-other", "Foreign older"));
    render(<Timeline subscriberId="subscriber-1" />);
    await waitFor(() => {
      expect(document.body.textContent).toContain("Load more");
    });
    const loadMore = document.querySelector<HTMLButtonElement>("button");
    act(() => {
      loadMore?.click();
      loadMore?.click();
    });
    await waitFor(() => {
      expect(document.body.textContent).toContain("different subscriber");
    });

    expect(mocks.timeline).toHaveBeenCalledTimes(2);
    expect(document.body.textContent).toContain("Newest event");
    expect(document.body.textContent).not.toContain("Foreign older");
  });
});
