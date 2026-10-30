// @vitest-environment happy-dom

import axe from "axe-core";
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
  timeline: vi.fn(),
}));

vi.mock("../../lib/api-client", () => ({
  analyticsExtrasApi: { crossChannelTimeline: mocks.timeline },
}));

import { CrossChannelTimeline } from "../../components/subscribers/CrossChannelTimeline";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => mocks.timeline.mockReset());

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
});

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function render(node: ReactElement): void {
  if (!container) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  }
  act(() => root?.render(node));
}

function button(label: string): HTMLButtonElement {
  const match = Array.from(document.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!(match instanceof HTMLButtonElement)) {
    throw new Error(`Missing ${label} button`);
  }
  return match;
}

async function waitFor(assertion: () => void): Promise<void> {
  let failure: unknown;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      failure = error;
      await act(async () => Promise.resolve());
    }
  }
  throw failure;
}

function page(
  label: string,
  options: { hasMore?: boolean; nextBefore?: string; at?: string } = {},
) {
  return {
    data: {
      items: [
        {
          at: options.at ?? "2026-07-16T10:00:00Z",
          channel: "sms",
          type: "delivered",
          label,
          detail: `${label} detail that can wrap at high zoom`,
        },
      ],
      has_more: options.hasMore ?? false,
      next_before: options.nextBefore,
    },
  };
}

describe("CrossChannelTimeline interactions", () => {
  it("contains thrown loads, coalesces retry, and renders full visible context", async () => {
    mocks.timeline.mockImplementationOnce(() => {
      throw new Error("timeline offline");
    });
    render(<CrossChannelTimeline subscriberIdOrEmail="person@example.com" />);
    await waitFor(() =>
      expect(document.body.textContent).toContain(
        "Couldn't load email and SMS activity: timeline offline",
      ),
    );

    const pending = deferred<ReturnType<typeof page>>();
    mocks.timeline.mockReturnValue(pending.promise);
    const retry = button("Retry");
    act(() => {
      retry.click();
      retry.click();
    });
    expect(mocks.timeline).toHaveBeenCalledTimes(2);
    pending.resolve(page("SMS delivered"));
    await act(async () => pending.promise);
    await waitFor(() =>
      expect(document.body.textContent).toContain("SMS delivered detail"),
    );
    expect(document.querySelector("[title]")).toBeNull();
    expect(document.querySelector("time")?.getAttribute("datetime")).toBe(
      "2026-07-16T10:00:00Z",
    );

    const results = await axe.run(container!, {
      rules: { region: { enabled: false } },
    });
    expect(
      results.violations.filter((violation) =>
        ["serious", "critical"].includes(violation.impact ?? ""),
      ),
    ).toEqual([]);
  });

  it("single-flights older pages and appends them once", async () => {
    mocks.timeline.mockResolvedValueOnce(
      page("Newest", { hasMore: true, nextBefore: "cursor-1" }),
    );
    const older = deferred<ReturnType<typeof page>>();
    mocks.timeline.mockReturnValue(older.promise);
    render(
      <CrossChannelTimeline subscriberIdOrEmail="subscriber-1" pageSize={25} />,
    );
    await waitFor(() => expect(button("Load older")).toBeTruthy());

    const loadOlder = button("Load older");
    act(() => {
      loadOlder.click();
      loadOlder.click();
    });
    expect(mocks.timeline).toHaveBeenCalledTimes(2);
    expect(mocks.timeline).toHaveBeenLastCalledWith("subscriber-1", {
      limit: 25,
      before: "cursor-1",
    });
    expect(button("Loading…").disabled).toBe(true);

    older.resolve(page("Older", { at: "2026-07-15T10:00:00Z" }));
    await act(async () => older.promise);
    expect(document.body.textContent).toContain("Newest");
    expect(document.body.textContent).toContain("Older");
    expect(document.querySelectorAll("li")).toHaveLength(2);
  });

  it("drops an old subscriber response and calls the latest unavailable handler", async () => {
    const old = deferred<ReturnType<typeof page>>();
    const unavailable = deferred<{
      error: { kind: "http"; status: number; message: string };
    }>();
    mocks.timeline
      .mockReturnValueOnce(old.promise)
      .mockReturnValueOnce(unavailable.promise);
    const oldUnavailable = vi.fn();
    const latestUnavailable = vi.fn();
    render(
      <CrossChannelTimeline
        subscriberIdOrEmail="old@example.com"
        onUnavailable={oldUnavailable}
      />,
    );
    render(
      <CrossChannelTimeline
        subscriberIdOrEmail="new@example.com"
        onUnavailable={latestUnavailable}
      />,
    );

    unavailable.resolve({
      error: { kind: "http", status: 404, message: "not mounted" },
    });
    await act(async () => unavailable.promise);
    await waitFor(() => expect(latestUnavailable).toHaveBeenCalledTimes(1));
    expect(oldUnavailable).not.toHaveBeenCalled();

    old.resolve(page("Stale old activity"));
    await act(async () => old.promise);
    expect(document.body.textContent).not.toContain("Stale old activity");
  });
});
