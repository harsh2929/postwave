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
  load: vi.fn(),
  clear: vi.fn(),
  remove: vi.fn(),
  subscribe: vi.fn(() => () => undefined),
}));

vi.mock("../../components/playground/playground-history-storage", () => ({
  recordHistoryEntry: vi.fn(),
  loadPlaygroundHistory: mocks.load,
  clearHistory: mocks.clear,
  removeHistoryEntry: mocks.remove,
  subscribeToPlaygroundHistory: mocks.subscribe,
  isPlaygroundHistoryStorageEvent: () => false,
}));

vi.mock("../../components/playground/Copy", () => ({
  CopyButton: ({
    value,
    contentClass,
  }: {
    value: string;
    contentClass?: string;
  }) => (
    <button
      type="button"
      data-copy-value={value}
      data-content-class={contentClass}
    >
      Copy URL
    </button>
  ),
}));

import {
  PlaygroundHistory,
  type HistoryEntry,
} from "../../components/playground/PlaygroundHistory";

const ALPHA = "1111111111111111";
const BETA = "2222222222222222";
let root: Root | null = null;
let container: HTMLDivElement | null = null;

function entry(label: string): HistoryEntry {
  return {
    id: `${label}-id`,
    ts: Date.now(),
    method: "POST",
    pathTemplate: `/api/v1/${label}`,
    status: 202,
    durationMs: 42,
    outcome: "http",
    ambiguous: false,
    parameterNamesOmitted: {
      path: ["id"],
      query: ["email"],
      header: ["X-Customer-Context"],
    },
    customHeaderNamesOmitted: ["X-Customer-Context"],
    body: "",
    bodyOmitted: true,
  };
}

function ready(entries: HistoryEntry[], warning: string | null = null) {
  return { entries, state: "ready", warning, retryable: false } as const;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  mocks.load.mockReset();
  mocks.clear.mockReset();
  mocks.remove.mockReset();
  mocks.subscribe.mockClear();
  mocks.load.mockResolvedValue(ready([]));
  mocks.clear.mockResolvedValue(undefined);
  mocks.remove.mockResolvedValue(undefined);
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

function render(node: ReactElement): void {
  if (!container) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  }
  act(() => root?.render(node));
}

async function waitFor(assertion: () => void): Promise<void> {
  let failure: unknown;
  for (let attempt = 0; attempt < 80; attempt += 1) {
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

function button(label: string): HTMLButtonElement {
  const match = Array.from(document.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!(match instanceof HTMLButtonElement)) {
    throw new Error(`Missing button: ${label}`);
  }
  return match;
}

describe("PlaygroundHistory privacy interactions", () => {
  it("synchronously hides the old identity and ignores its stale load", async () => {
    const alphaLoad = deferred<ReturnType<typeof ready>>();
    const betaLoad = deferred<ReturnType<typeof ready>>();
    mocks.load.mockImplementation((scope: string) =>
      scope === ALPHA ? alphaLoad.promise : betaLoad.promise,
    );
    render(<PlaygroundHistory identityScope={ALPHA} onReplay={vi.fn()} />);
    expect(document.body.textContent).toContain("Loading encrypted");

    render(<PlaygroundHistory identityScope={BETA} onReplay={vi.fn()} />);
    expect(document.body.textContent).not.toContain("alpha");
    await act(async () => betaLoad.resolve(ready([entry("beta")])));
    await waitFor(() =>
      expect(document.body.textContent).toContain("/api/v1/beta"),
    );
    await act(async () => alphaLoad.resolve(ready([entry("alpha")])));
    expect(document.body.textContent).toContain("/api/v1/beta");
    expect(document.body.textContent).not.toContain("/api/v1/alpha");
  });

  it("discloses value minimization while preserving safe replay", async () => {
    const onReplay = vi.fn();
    const reader = entry("reader");
    mocks.load.mockResolvedValue(ready([reader]));
    render(<PlaygroundHistory identityScope={ALPHA} onReplay={onReplay} />);
    await waitFor(() =>
      expect(document.body.textContent).toContain("/api/v1/reader"),
    );

    expect(document.body.textContent).toContain("Encrypted on this device");
    expect(document.body.textContent).toContain("Only route templates");
    expect(document.body.textContent).toContain("body private");
    expect(document.body.textContent).toContain("headers private");
    expect(document.body.textContent).toContain("values private");
    expect(document.body.textContent).not.toContain("reader@example.com");
    expect(document.body.textContent).not.toContain("Copy URL");

    const replay = document.querySelector<HTMLButtonElement>(
      'button[aria-label^="Replay POST /api/v1/reader, request 1 of 1"]',
    );
    if (!replay) throw new Error("Missing replay action");
    expect(replay.getAttribute("aria-label")).toContain("status 202");
    expect(replay.getAttribute("aria-label")).toContain("42 milliseconds");
    expect(replay.getAttribute("aria-label")).toContain("body private");
    expect(replay.getAttribute("aria-label")).toContain(
      "parameter values private",
    );
    act(() => replay.click());
    expect(onReplay).toHaveBeenCalledWith(reader);
  });

  it("uniquely names repeated replay and remove actions", async () => {
    const onReplay = vi.fn();
    const newest = { ...entry("duplicate"), id: "duplicate-new" };
    const older = {
      ...entry("duplicate"),
      id: "duplicate-old",
      ts: newest.ts - 1,
    };
    mocks.load
      .mockResolvedValueOnce(ready([newest, older]))
      .mockResolvedValueOnce(ready([older]));
    render(<PlaygroundHistory identityScope={ALPHA} onReplay={onReplay} />);
    await waitFor(() =>
      expect(document.body.textContent).toContain("2 requests"),
    );

    const replay = Array.from(
      document.querySelectorAll<HTMLButtonElement>(
        'button[aria-label^="Replay POST /api/v1/duplicate"]',
      ),
    );
    expect(replay[0]?.getAttribute("aria-label")).toContain("request 1 of 2");
    expect(replay[1]?.getAttribute("aria-label")).toContain("request 2 of 2");
    act(() => replay[1]?.click());
    expect(onReplay).toHaveBeenCalledWith(older);

    const remove = Array.from(
      document.querySelectorAll<HTMLButtonElement>(
        'button[aria-label^="Remove POST /api/v1/duplicate"]',
      ),
    );
    expect(remove.map((button) => button.getAttribute("aria-label"))).toEqual([
      "Remove POST /api/v1/duplicate, request 1 of 2, from history",
      "Remove POST /api/v1/duplicate, request 2 of 2, from history",
    ]);
    await act(async () => remove[0]?.click());
    await waitFor(() =>
      expect(mocks.remove).toHaveBeenCalledWith(ALPHA, newest.id),
    );
  });

  it("labels an unknown mutation outcome and requires acknowledgement before replay", async () => {
    const onReplay = vi.fn();
    const uncertain = {
      ...entry("uncertain"),
      status: 0,
      outcome: "timeout" as const,
      ambiguous: true,
    };
    mocks.load.mockResolvedValue(ready([uncertain]));
    render(<PlaygroundHistory identityScope={ALPHA} onReplay={onReplay} />);
    await waitFor(() =>
      expect(document.body.textContent).toContain("outcome unknown"),
    );

    const replay = document.querySelector<HTMLButtonElement>(
      'button[aria-label^="Review unknown outcome before replaying POST /api/v1/uncertain"]',
    );
    if (!replay) throw new Error("Missing unknown-outcome replay review");
    act(() => replay.click());
    expect(onReplay).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain(
      "The server may have committed the prior request",
    );

    await act(async () => button("Open blank replay draft").click());
    expect(onReplay).toHaveBeenCalledWith(uncertain);
  });

  it("renders a contract-blocked HTTP response as blocked rather than successful", async () => {
    mocks.load.mockResolvedValue(
      ready([
        {
          ...entry("contract"),
          status: 200,
          outcome: "contract",
          ambiguous: false,
        },
      ]),
    );
    render(<PlaygroundHistory identityScope={ALPHA} onReplay={vi.fn()} />);
    await waitFor(() =>
      expect(document.body.textContent).toContain("/api/v1/contract"),
    );

    const status = Array.from(document.querySelectorAll(".badge")).find(
      (item) => item.textContent === "BLOCKED",
    );
    expect(status?.classList.contains("danger")).toBe(true);
    expect(document.body.textContent).not.toContain("200");
  });

  it("offers retry for unavailable storage and recovers truthfully", async () => {
    mocks.load
      .mockResolvedValueOnce({
        entries: [],
        state: "unavailable",
        warning: "Encrypted request history is temporarily unavailable.",
        retryable: true,
      })
      .mockResolvedValueOnce(ready([entry("recovered")]));
    render(<PlaygroundHistory identityScope={ALPHA} onReplay={vi.fn()} />);
    await waitFor(() =>
      expect(document.body.textContent).toContain("temporarily unavailable"),
    );
    act(() => button("Retry encrypted history").click());
    await waitFor(() =>
      expect(document.body.textContent).toContain("/api/v1/recovered"),
    );
    expect(mocks.load).toHaveBeenCalledTimes(2);
  });

  it("serializes visible delete and confirmed clear states through refresh", async () => {
    const initial = [entry("one"), entry("two")];
    mocks.load
      .mockResolvedValueOnce(ready(initial))
      .mockResolvedValueOnce(ready([initial[1]!]))
      .mockResolvedValueOnce(ready([]));
    render(<PlaygroundHistory identityScope={ALPHA} onReplay={vi.fn()} />);
    await waitFor(() =>
      expect(document.body.textContent).toContain("2 requests"),
    );

    const remove = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Remove POST /api/v1/one, request 1 of 2, from history"]',
    );
    if (!remove) throw new Error("Missing remove action");
    await act(async () => remove.click());
    await waitFor(() =>
      expect(document.body.textContent).toContain("1 request"),
    );
    expect(mocks.remove).toHaveBeenCalledWith(ALPHA, initial[0]!.id);

    act(() => button("Clear all").click());
    const dialog = document.querySelector('[role="alertdialog"]');
    const confirm = Array.from(dialog?.querySelectorAll("button") ?? []).find(
      (candidate) => candidate.textContent?.trim() === "Clear all",
    );
    if (!(confirm instanceof HTMLButtonElement)) {
      throw new Error("Missing clear confirmation");
    }
    await act(async () => confirm.click());
    await waitFor(() =>
      expect(document.body.textContent).toContain("No requests yet"),
    );
    expect(mocks.clear).toHaveBeenCalledWith(ALPHA);
  });
});
