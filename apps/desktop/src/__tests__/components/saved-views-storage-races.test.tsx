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
  save: vi.fn(),
}));

vi.mock("../../lib/sensitive-local-data", () => ({
  loadSensitiveLocalData: mocks.load,
  saveSensitiveLocalData: mocks.save,
}));

import { SavedViewsMenu } from "../../components/analytics/SavedViewsMenu";
import {
  type SavedView,
  type SavedViewsStorage,
  useEncryptedSavedViews,
} from "../../components/analytics/saved-views-storage";

const ALPHA = "dddddddddddddddd";
const BETA = "eeeeeeeeeeeeeeee";
const GAMMA = "ffffffffffffffff";
let container: HTMLDivElement | null = null;
let root: Root | null = null;
let latestStorage: SavedViewsStorage | null = null;

interface LoadResult {
  value: SavedView[];
  state: "ready" | "unavailable";
  warning: string | null;
  retryable: boolean;
}

function ready(value: SavedView[] = []): LoadResult {
  return { value, state: "ready", warning: null, retryable: false };
}

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

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  localStorage.clear();
  latestStorage = null;
  mocks.load.mockReset().mockResolvedValue(ready());
  mocks.save.mockReset().mockImplementation(
    async (options: { value: SavedView[] }) => options.value,
  );
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
  vi.restoreAllMocks();
  localStorage.clear();
});

function render(node: ReactElement): void {
  if (!container) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  }
  act(() => root?.render(node));
}

function menu(scope: string): ReactElement {
  return (
    <SavedViewsMenu
      current={{ range: "30d", vsPrevious: true }}
      onApply={vi.fn()}
      storageScope={scope}
    />
  );
}

function HookHarness({ scope }: { scope: string }): ReactElement {
  latestStorage = useEncryptedSavedViews(scope);
  return <span>{latestStorage.loading ? "loading" : "ready"}</span>;
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

const alphaView: SavedView = {
  id: "alpha",
  name: "Alpha view",
  range: "30d",
  vsPrevious: true,
};
const betaView: SavedView = {
  id: "beta",
  name: "Beta view",
  range: "30d",
  vsPrevious: true,
};
const gammaView: SavedView = {
  id: "gamma",
  name: "Gamma view",
  range: "30d",
  vsPrevious: true,
};

describe("Saved Views storage concurrency", () => {
  it("isolates immediately and ignores an older scope load that finishes last", async () => {
    const alpha = deferred<LoadResult>();
    const beta = deferred<LoadResult>();
    const gamma = deferred<LoadResult>();
    mocks.load.mockImplementation(
      (options: { identityScope: string }) =>
        ({ [ALPHA]: alpha, [BETA]: beta, [GAMMA]: gamma })[
          options.identityScope
        ]!.promise,
    );

    render(menu(ALPHA));
    alpha.resolve(ready([alphaView]));
    await waitFor(() =>
      expect(document.body.textContent).toContain("View · Alpha view"),
    );
    render(menu(BETA));
    expect(document.body.textContent).not.toContain("Alpha view");
    render(menu(GAMMA));
    gamma.resolve(ready([gammaView]));
    await waitFor(() =>
      expect(document.body.textContent).toContain("View · Gamma view"),
    );
    beta.resolve(ready([betaView]));
    await act(async () => beta.promise);
    expect(document.body.textContent).toContain("Gamma view");
    expect(document.body.textContent).not.toContain("Beta view");
  });

  it("surfaces an unexpected load rejection and retries without hanging", async () => {
    mocks.load
      .mockRejectedValueOnce(new Error("keychain bridge failed"))
      .mockResolvedValueOnce(ready());
    render(menu(ALPHA));
    act(() => {
      document
        .querySelector<HTMLButtonElement>('button[aria-haspopup="dialog"]')
        ?.click();
    });
    await waitFor(() =>
      expect(document.body.textContent).toContain("couldn't be opened"),
    );
    const retry = Array.from(document.querySelectorAll("button")).find(
      (candidate) => candidate.textContent?.trim() === "Retry encrypted storage",
    );
    expect(retry).not.toBeUndefined();
    act(() => retry?.click());
    await waitFor(() =>
      expect(document.body.textContent).toContain("No saved views yet"),
    );
    expect(mocks.load).toHaveBeenCalledTimes(2);
  });

  it("keeps the 20-view limit visible and blocks an over-limit save", async () => {
    mocks.load.mockResolvedValue(
      ready(
        Array.from({ length: 20 }, (_, index) => ({
          ...alphaView,
          id: `view-${index}`,
          name: `View ${index}`,
        })),
      ),
    );
    render(menu(ALPHA));
    act(() => {
      document
        .querySelector<HTMLButtonElement>('button[aria-haspopup="dialog"]')
        ?.click();
    });
    await waitFor(() =>
      expect(document.body.textContent).toContain("Maximum 20 saved views"),
    );
    const create = document.querySelector<HTMLButtonElement>(
      "[data-saved-view-create]",
    );
    expect(create?.getAttribute("aria-disabled")).toBe("true");
    act(() => create?.click());
    expect(document.querySelector(".modal-card")).toBeNull();
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("serializes writes and computes the second mutation from durable data", async () => {
    const first = deferred<SavedView[]>();
    const second = deferred<SavedView[]>();
    mocks.save
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    render(<HookHarness scope={ALPHA} />);
    await waitFor(() => expect(latestStorage?.loading).toBe(false));

    let firstResult!: ReturnType<SavedViewsStorage["add"]>;
    let secondResult!: ReturnType<SavedViewsStorage["add"]>;
    act(() => {
      firstResult = latestStorage!.add(alphaView);
      secondResult = latestStorage!.add(betaView);
    });
    await waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(1));
    first.resolve([alphaView]);
    await waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(2));
    expect(mocks.save.mock.calls[1]?.[0]).toMatchObject({
      identityScope: ALPHA,
      value: [alphaView, betaView],
    });
    second.resolve([alphaView, betaView]);
    await act(async () => Promise.all([firstResult, secondResult]));
    expect(latestStorage?.views).toEqual([alphaView, betaView]);
  });

  it("rejects scope-stale and unmounted write completions without UI adoption", async () => {
    const oldWrite = deferred<SavedView[]>();
    const unmountedWrite = deferred<SavedView[]>();
    mocks.save
      .mockReturnValueOnce(oldWrite.promise)
      .mockReturnValueOnce(unmountedWrite.promise);
    render(<HookHarness scope={ALPHA} />);
    await waitFor(() => expect(latestStorage?.loading).toBe(false));
    const oldResult = latestStorage!.add(alphaView);
    await waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(1));
    render(<HookHarness scope={BETA} />);
    await waitFor(() => expect(latestStorage?.loading).toBe(false));
    oldWrite.resolve([alphaView]);
    await expect(oldResult).resolves.toMatchObject({ ok: false, stale: true });
    expect(latestStorage?.views).toEqual([]);

    const pending = latestStorage!.add(betaView);
    await waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(2));
    act(() => root?.unmount());
    root = null;
    unmountedWrite.resolve([betaView]);
    await expect(pending).resolves.toMatchObject({ ok: false, stale: true });
  });
});
