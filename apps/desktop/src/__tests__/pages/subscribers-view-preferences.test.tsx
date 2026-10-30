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
  get: vi.fn(),
  put: vi.fn(),
  registerGuard: vi.fn(() => () => undefined),
  signalOwnerChanged: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("../../lib/api-client", () => ({
  getSubscribersViewPrefs: mocks.get,
  putSubscribersViewPrefs: mocks.put,
}));

vi.mock("../../lib/lifecycle-coordinator", () => ({
  registerLifecycleGuard: mocks.registerGuard,
  signalLifecycleOwnerChanged: mocks.signalOwnerChanged,
}));

vi.mock("../../components/Toast", () => ({
  toast: { error: mocks.toastError },
}));

vi.mock("../../lib/auth", () => ({
  redact: (value: string) => value.replace(/token=[^\s]+/giu, "token=***"),
}));

import { useSubscribersViewPreferences } from "../../pages/subscribers/useSubscribersViewPreferences";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

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
  vi.clearAllMocks();
  mocks.put.mockResolvedValue({ data: {} });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.clearAllMocks();
});

async function flush(): Promise<void> {
  for (let index = 0; index < 4; index += 1) {
    await act(async () => Promise.resolve());
  }
}

function Harness({ scope }: { scope: string }): ReactElement {
  const view = useSubscribersViewPreferences(scope);
  return (
    <div>
      <span data-testid="columns">{view.visibleColumnKeys.join(",")}</span>
      <span data-testid="loading">{String(view.preferencesLoading)}</span>
      <span data-testid="error">{view.preferencesError ?? "none"}</span>
      <button
        type="button"
        onClick={() => view.updateVisibleColumns(["status"])}
      >
        Use compact columns
      </button>
      <button type="button" onClick={view.retryPreferences}>
        Retry
      </button>
    </div>
  );
}

function render(scope: string): void {
  act(() => root?.render(<Harness scope={scope} />));
}

function text(testId: string): string | null {
  return (
    container?.querySelector(`[data-testid="${testId}"]`)?.textContent ?? null
  );
}

function click(label: string): void {
  const button = [
    ...document.querySelectorAll<HTMLButtonElement>("button"),
  ].find((candidate) => candidate.textContent === label);
  expect(button).toBeDefined();
  act(() => button?.click());
}

describe("Subscribers view preference ownership", () => {
  it("never lets a late GET overwrite a newer local column edit", async () => {
    const load = deferred<{ data: { columns: string[] } }>();
    mocks.get.mockReturnValueOnce(load.promise);
    render("workspace-a");

    click("Use compact columns");
    expect(text("columns")).toBe("email,status");

    await act(async () => {
      load.resolve({ data: { columns: ["email", "tags"] } });
      await load.promise;
    });
    await flush();
    expect(text("columns")).toBe("email,status");
    expect(text("loading")).toBe("false");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    await flush();
    expect(mocks.put).toHaveBeenCalledWith({ columns: ["email", "status"] });
  });

  it("ignores a prior workspace's late response after identity changes", async () => {
    const oldLoad = deferred<{ data: { columns: string[] } }>();
    const newLoad = deferred<{ data: { columns: string[] } }>();
    mocks.get
      .mockReturnValueOnce(oldLoad.promise)
      .mockReturnValueOnce(newLoad.promise);

    render("workspace-a");
    render("workspace-b");
    expect(mocks.get).toHaveBeenCalledTimes(2);

    await act(async () => {
      newLoad.resolve({ data: { columns: ["email", "rating"] } });
      await newLoad.promise;
    });
    await flush();
    expect(text("columns")).toBe("email,rating");

    await act(async () => {
      oldLoad.resolve({ data: { columns: ["email", "tags"] } });
      await oldLoad.promise;
    });
    await flush();
    expect(text("columns")).toBe("email,rating");
  });

  it("redacts preference failures and retries the failed load", async () => {
    mocks.get
      .mockResolvedValueOnce({
        error: { message: "token=private preference service unavailable" },
      })
      .mockResolvedValueOnce({ data: { columns: ["email", "joined"] } });
    render("workspace-a");
    await flush();

    expect(text("error")).toBe("token=*** preference service unavailable");
    click("Retry");
    await flush();
    expect(mocks.get).toHaveBeenCalledTimes(2);
    expect(text("columns")).toBe("email,joined");
    expect(text("error")).toBe("none");
  });
});
