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
  getSegmentBestSendTime: vi.fn(),
}));

vi.mock("../../lib/api-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/api-client")>();
  return {
    ...actual,
    apiSendTimeAssets: {
      ...actual.apiSendTimeAssets,
      getSegmentBestSendTime: mocks.getSegmentBestSendTime,
    },
  };
});

import {
  normalizeSendTime,
  SendTimeOptBanner,
} from "../../components/SendTimeOptBanner";

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
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-07-26T10:00:00.000Z"));
  mocks.getSegmentBestSendTime.mockResolvedValue({
    data: recommendation("09:00"),
  });
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
  vi.useRealTimers();
});

describe("SendTimeOptBanner", () => {
  it("requires an explicit audience scope and makes no unscoped request", async () => {
    render(<SendTimeOptBanner onApply={vi.fn()} />);
    await settle();

    expect(mocks.getSegmentBestSendTime).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain(
      "Choose a segment or campaign audience",
    );
  });

  it("renders canonical segment coverage and applies the next UTC occurrence", async () => {
    const onApply = vi.fn();
    render(<SendTimeOptBanner segmentId="segment-1" onApply={onApply} />);

    expect(document.querySelector(".ai-banner-loading")).not.toBeNull();
    await settle();

    expect(mocks.getSegmentBestSendTime).toHaveBeenCalledWith({
      segmentId: "segment-1",
      campaignId: null,
    });
    expect(document.body.textContent).toContain("9:00 AM UTC");
    expect(document.body.textContent).toContain("75% model coverage");
    expect(document.body.textContent).toContain(
      "96 subscribers have cached signal",
    );

    const apply =
      document.querySelector<HTMLButtonElement>("button.btn-primary");
    expect(apply?.disabled).toBe(false);
    act(() => apply?.click());
    expect(onApply).toHaveBeenCalledWith("2026-07-27T09:00:00.000Z");
  });

  it.each([404, 405, 501, 503])(
    "keeps capability status %s as a quiet honest fallback",
    async (status) => {
      mocks.getSegmentBestSendTime.mockResolvedValue({
        error: {
          status,
          code: "insufficient_data",
          message: "not available",
        },
      });
      render(<SendTimeOptBanner campaignId="campaign-1" onApply={vi.fn()} />);
      await settle();

      expect(document.body.textContent).toContain(
        "needs at least 30 subscribers with cached engagement signal",
      );
      expect(document.querySelector("button")).toBeNull();
    },
  );

  it("rejects malformed success payloads instead of producing an actionable time", async () => {
    mocks.getSegmentBestSendTime.mockResolvedValue({
      data: {
        ...recommendation("09:00"),
        best_hour_utc: "09:garbage",
      },
    });
    render(<SendTimeOptBanner segmentId="segment-1" onApply={vi.fn()} />);
    await settle();

    expect(document.body.textContent).toContain(
      "Send-time analysis unavailable yet",
    );
    expect(document.querySelector("button")).toBeNull();
  });

  it("ignores a stale response after the campaign scope changes", async () => {
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    mocks.getSegmentBestSendTime
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);

    render(<SendTimeOptBanner campaignId="campaign-a" onApply={vi.fn()} />);
    rerender(<SendTimeOptBanner campaignId="campaign-b" onApply={vi.fn()} />);

    await act(async () => {
      second.resolve({ data: recommendation("14:00") });
      await second.promise;
    });
    await settle();
    expect(document.body.textContent).toContain("2:00 PM UTC");

    await act(async () => {
      first.resolve({ data: recommendation("06:00") });
      await first.promise;
    });
    await settle();
    expect(document.body.textContent).toContain("2:00 PM UTC");
    expect(document.body.textContent).not.toContain("6:00 AM UTC");
  });
});

describe("normalizeSendTime", () => {
  it("accepts only the canonical strict segment-best contract", () => {
    expect(normalizeSendTime(recommendation("23:00"))?.hour).toBe(23);
    expect(normalizeSendTime({ ...recommendation("09:00"), hour: 99 })).toEqual(
      expect.objectContaining({ hour: 9 }),
    );
    expect(normalizeSendTime(recommendation("24:00"))).toBeNull();
    expect(
      normalizeSendTime({
        ...recommendation("09:00"),
        computed_at: null,
      }),
    ).toBeNull();
  });
});

function recommendation(hour: string) {
  return {
    best_hour_utc: hour,
    confidence: 0.75,
    sample_size: 96,
    computed_at: "2026-07-26T09:45:00.000Z",
  };
}

function render(element: ReactElement): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(element));
}

function rerender(element: ReactElement): void {
  act(() => root?.render(element));
}

async function settle(turns = 5): Promise<void> {
  for (let index = 0; index < turns; index += 1) {
    await act(async () => Promise.resolve());
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
