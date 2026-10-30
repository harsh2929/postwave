// @vitest-environment happy-dom

import { act, Fragment, type ReactElement } from "react";
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

import type { PreSendRefineResult } from "../../lib/api-client";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  preview: vi.fn(),
  clear: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("../../lib/api-client", () => ({
  presendRefineApi: {
    get: mocks.get,
    preview: mocks.preview,
    clear: mocks.clear,
  },
}));

vi.mock("../../components/Toast", () => ({
  toast: {
    error: mocks.toastError,
    success: mocks.toastSuccess,
  },
}));

import { PreSendRefinePanel } from "../../components/PreSendRefinePanel";

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
  vi.useFakeTimers();
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.get.mockResolvedValue({ data: result({ excluded_count: 0 }) });
  mocks.clear.mockResolvedValue({ data: { cleared: 0 } });
});

afterEach(() => {
  vi.useRealTimers();
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

function result(
  overrides: Partial<PreSendRefineResult> = {},
): PreSendRefineResult {
  return {
    campaign_id: "campaign-1",
    churn_threshold: 80,
    cooling_off_hours: 24,
    excluded_count: 4,
    cooling_off_count: 3,
    dry_run: true,
    exclude_recently_paused: false,
    affected_subscribers_sample: [
      {
        subscriber_id: "subscriber-1",
        email: "risk@example.com",
        churn_score: 96,
        reason: "churn_risk",
      },
    ],
    ...overrides,
  };
}

function component(campaignID: string | number = "campaign-1"): ReactElement {
  return <PreSendRefinePanel campaignID={campaignID} canMutate />;
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

function button(label: string): HTMLButtonElement {
  const match = Array.from(
    document.querySelectorAll<HTMLButtonElement>("button"),
  ).find((candidate) => candidate.textContent?.trim() === label);
  if (!match) throw new Error(`Missing button: ${label}`);
  return match;
}

function range(value: number): void {
  const element = document.querySelector<HTMLInputElement>(
    'input[type="range"]',
  );
  if (!element) throw new Error("Missing churn threshold range");
  act(() => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set?.call(element, String(value));
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function runDebounce(): Promise<void> {
  act(() => {
    vi.advanceTimersByTime(250);
  });
  await flush();
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

describe("PreSendRefinePanel", () => {
  it("previews, applies, and clears the exact campaign refinement", async () => {
    mocks.preview
      .mockResolvedValueOnce({ data: result() })
      .mockResolvedValueOnce({
        data: result({ dry_run: false, excluded_count: 4 }),
      });
    mocks.clear.mockResolvedValueOnce({ data: { cleared: 4 } });
    render(component());
    await runDebounce();

    expect(mocks.preview).toHaveBeenCalledWith("campaign-1", {
      churn_threshold: 80,
      exclude_recently_paused: false,
      dry_run: true,
    });
    expect(document.body.textContent).toContain("risk@example.com");

    act(() => button("Apply refinement").click());
    await flush();
    expect(mocks.preview).toHaveBeenLastCalledWith("campaign-1", {
      churn_threshold: 80,
      exclude_recently_paused: false,
      dry_run: false,
    });
    expect(document.body.textContent).toContain("4 excluded");
    expect(mocks.toastSuccess).toHaveBeenCalledWith(
      "Refinement applied — 4 subscribers excluded for this send.",
    );

    act(() => button("Send anyway").click());
    expect(mocks.clear).not.toHaveBeenCalled();
    act(() => button("Clear exclusions and send anyway").click());
    await flush();
    expect(mocks.clear).toHaveBeenCalledWith("campaign-1");
    expect(document.body.textContent).toContain("Not applied");
    expect(mocks.toastSuccess).toHaveBeenLastCalledWith(
      "Send anyway — 4 exclusions cleared; everyone re-enters this send.",
    );
  });

  it("ignores an older preview that resolves after a newer threshold", async () => {
    const stale = deferred<{ data: PreSendRefineResult }>();
    mocks.preview.mockReturnValueOnce(stale.promise).mockResolvedValueOnce({
      data: result({
        churn_threshold: 90,
        excluded_count: 1,
        affected_subscribers_sample: [
          {
            subscriber_id: "new",
            email: "newest@example.com",
            churn_score: 99,
            reason: "churn_risk",
          },
        ],
      }),
    });
    render(component());
    await runDebounce();
    range(90);
    await runDebounce();
    expect(document.body.textContent).toContain("newest@example.com");

    stale.resolve({
      data: result({
        affected_subscribers_sample: [
          {
            subscriber_id: "stale",
            email: "stale@example.com",
            churn_score: 81,
            reason: "churn_risk",
          },
        ],
      }),
    });
    await flush();

    expect(document.body.textContent).toContain("newest@example.com");
    expect(document.body.textContent).not.toContain("stale@example.com");
  });

  it("hides cleanly when an older deployment lacks the route", async () => {
    mocks.get.mockResolvedValueOnce({
      error: { status: 404, message: "Not found" },
    });
    render(component());
    await flush();

    expect(document.body.textContent).not.toContain("Audience refinement");
    await runDebounce();
    expect(mocks.preview).not.toHaveBeenCalled();
  });

  it("never reports an unknown saved state as not applied and fails closed", async () => {
    mocks.get.mockResolvedValueOnce({
      error: { status: 503, message: "Verification unavailable" },
    });
    mocks.preview.mockResolvedValueOnce({ data: result() });
    render(component());
    await runDebounce();

    expect(document.body.textContent).toContain("Saved state unavailable");
    expect(document.body.textContent).toContain("Verification unavailable");
    expect(document.body.textContent).not.toContain("Not applied");
    expect(button("Apply refinement").disabled).toBe(true);
    expect(button("Send anyway").disabled).toBe(true);
    expect(mocks.preview).toHaveBeenCalledTimes(1);

    mocks.get.mockResolvedValueOnce({
      data: result({ dry_run: false, excluded_count: 2 }),
    });
    act(() => button("Retry saved state").click());
    await flush();

    expect(document.body.textContent).toContain("2 excluded");
    expect(document.body.textContent).not.toContain("Saved state unavailable");
    expect(button("Apply refinement").disabled).toBe(false);
    expect(button("Send anyway").disabled).toBe(false);
  });

  it("shows a truthful loading state and ignores a late saved-state response after unmount", async () => {
    const saved = deferred<{ data: PreSendRefineResult }>();
    mocks.get.mockReturnValueOnce(saved.promise);
    const view = render(component());

    expect(document.body.textContent).toContain("Checking saved state…");
    expect(document.body.textContent).not.toContain("Not applied");
    expect(button("Apply refinement").disabled).toBe(true);

    view.rerender(<Fragment />);
    saved.resolve({ data: result({ excluded_count: 8 }) });
    await flush();

    expect(document.body.textContent).not.toContain("8 excluded");
  });

  it("suppresses an apply completion after the campaign panel unmounts", async () => {
    const apply = deferred<{ data: PreSendRefineResult }>();
    mocks.preview
      .mockResolvedValueOnce({ data: result() })
      .mockReturnValueOnce(apply.promise);
    const view = render(component());
    await runDebounce();
    act(() => button("Apply refinement").click());

    view.rerender(<Fragment />);
    apply.resolve({ data: result({ dry_run: false }) });
    await flush();

    expect(mocks.toastSuccess).not.toHaveBeenCalled();
  });
});
