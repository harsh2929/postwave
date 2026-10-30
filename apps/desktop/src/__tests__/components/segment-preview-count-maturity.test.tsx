// @vitest-environment happy-dom

import axe from "axe-core";
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

const mocks = vi.hoisted(() => ({ preview: vi.fn() }));

vi.mock("../../components/segments/segmentsClient", () => ({
  segmentsClient: { previewCount: mocks.preview },
}));

import { SegmentPreviewCount } from "../../components/segments/SegmentPreviewCount";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  mocks.preview.mockResolvedValue({
    data: { count: 42, capped: false, computed_in_ms: 7.4 },
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

function render(text: string): void {
  if (!container) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  }
  act(() => root?.render(<SegmentPreviewCount text={text} debounceMs={400} />));
}

async function advance(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(400);
    await Promise.resolve();
    await Promise.resolve();
  });
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

function button(label: string): HTMLButtonElement {
  const match = Array.from(
    document.querySelectorAll<HTMLButtonElement>("button"),
  ).find((candidate) => candidate.textContent?.trim() === label);
  if (!match) throw new Error(`Missing button: ${label}`);
  return match;
}

describe("SegmentPreviewCount interaction maturity", () => {
  it("shows timing and capped lower-bound truth without title-only detail", async () => {
    mocks.preview.mockResolvedValue({
      data: { count: 1234, capped: true, computed_in_ms: 18.6 },
    });
    render("subscribers who opened recently");
    expect(document.body.textContent).toContain("Waiting for the description");
    await advance();
    expect(document.body.textContent).toContain(
      "At least 1,234 matching subscribers",
    );
    expect(document.body.textContent).toContain("Computed in 19 ms.");
    expect(document.body.textContent).toContain("true count is at least");
    expect(container?.querySelector("[title]")).toBeNull();

    vi.useRealTimers();
    const result = await axe.run(container ?? document.body);
    expect(
      result.violations.filter(
        (violation) =>
          violation.impact === "critical" || violation.impact === "serious",
      ),
    ).toEqual([]);
  });

  it("contains failure, redacts raw detail, and single-flights retry", async () => {
    mocks.preview
      .mockResolvedValueOnce({
        error: {
          kind: "network",
          code: "offline",
          requestId: "segment-preview-request-123",
          message: "private evaluator and tenant detail",
        },
      })
      .mockResolvedValueOnce({
        data: { count: 42, capped: false, computed_in_ms: 7 },
      });
    render("engaged audience");
    await advance();
    expect(document.body.textContent).toContain(
      "The service could not be reached. Check the connection and retry.",
    );
    expect(document.body.textContent).toContain("segment-preview-request-123");
    expect(document.body.textContent).not.toContain("private evaluator");
    const retry = button("Retry count");
    act(() => {
      retry.click();
      retry.click();
    });
    await act(async () => {
      await Promise.resolve();
    });
    await advance();
    expect(mocks.preview).toHaveBeenCalledTimes(2);
    expect(document.body.textContent).toContain("42 matching subscribers");
  });

  it("ignores an older response after the description changes", async () => {
    const older = deferred<{
      data: { count: number; capped: boolean; computed_in_ms: number };
    }>();
    const newer = deferred<{
      data: { count: number; capped: boolean; computed_in_ms: number };
    }>();
    mocks.preview
      .mockReturnValueOnce(older.promise)
      .mockReturnValueOnce(newer.promise);
    render("older description");
    await advance();
    render("newer description");
    await advance();
    await act(async () => {
      newer.resolve({ data: { count: 80, capped: false, computed_in_ms: 5 } });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(document.body.textContent).toContain("80 matching subscribers");
    await act(async () => {
      older.resolve({ data: { count: 10, capped: false, computed_in_ms: 50 } });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(document.body.textContent).toContain("80 matching subscribers");
    expect(document.body.textContent).not.toContain("10 matching subscribers");
  });
});
