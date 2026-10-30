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
  count: vi.fn(),
  enqueue: vi.fn(),
  job: vi.fn(),
}));

vi.mock("../../lib/api-client", () => ({
  api: {
    getAuditCount: mocks.count,
    exportAuditAsync: mocks.enqueue,
    getAuditExportJob: mocks.job,
  },
}));

vi.mock("../../lib/file-transfer", () => ({
  downloadUrlToFile: vi.fn(),
}));

import { AuditExportProgress } from "../../components/audit/AuditExportProgress";
import {
  inspectLifecycle,
  resetLifecycleCoordinatorForTests,
  type LifecycleIntent,
} from "../../lib/lifecycle-coordinator";

const quitIntent: LifecycleIntent = {
  kind: "quit-app",
  disposition: "exit",
  title: "Quit Moosewave?",
  description: "Review active work.",
  confirmLabel: "Quit",
};

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  vi.useFakeTimers();
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.count.mockResolvedValue({
    data: { totalEstimate: 25, confidence: "exact" },
  });
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
  resetLifecycleCoordinatorForTests();
  vi.useRealTimers();
});

function render(node: ReactElement): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(node));
}

function rerender(node: ReactElement): void {
  act(() => root?.render(node));
}

function button(label: string): HTMLButtonElement {
  const found = Array.from(document.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!found) throw new Error(`Expected button: ${label}`);
  return found;
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function job(
  status: "pending" | "in_progress" | "completed" | "failed" = "pending",
  exportedRows = 0,
) {
  return {
    id: "export-job-1",
    status,
    exportedRows,
    totalBytes: exportedRows * 8,
    emailOnComplete: false,
    createdAt: "2026-07-16T00:00:00.000Z",
  };
}

async function startExport(onClose = vi.fn()): Promise<void> {
  render(
    <AuditExportProgress
      open
      filters={{ action: "audit.*" }}
      onClose={onClose}
    />,
  );
  await flush();
  act(() => button("Start export").click());
  await flush();
}

describe("audit export progress lifecycle", () => {
  it("never installs polling after a deferred enqueue resolves post-unmount", async () => {
    const enqueue = deferred<{
      data: {
        id: string;
        status: string;
        exportedRows: number;
        totalBytes: number;
      };
    }>();
    mocks.enqueue.mockReturnValue(enqueue.promise);
    const timeoutSpy = vi.spyOn(window, "setTimeout");
    render(
      <AuditExportProgress open filters={{ action: "audit.*" }} onClose={vi.fn()} />,
    );
    await flush();

    act(() => button("Start export").click());
    await flush();
    expect(mocks.enqueue).toHaveBeenCalledTimes(1);
    act(() => root?.unmount());
    root = null;
    await expect(inspectLifecycle(quitIntent)).resolves.toMatchObject([
      {
        label: "Audit export request or progress handle operation",
        level: "blocking",
        canSave: false,
        canDiscard: false,
      },
    ]);

    enqueue.resolve({
      data: {
        id: "export-job-1",
        status: "pending",
        exportedRows: 0,
        totalBytes: 0,
      },
    });
    await flush();

    expect(mocks.job).not.toHaveBeenCalled();
    expect(timeoutSpy).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    await expect(inspectLifecycle(quitIntent)).resolves.toEqual([]);
  });

  it("does not install polling when a deferred enqueue resolves after controlled close", async () => {
    const enqueue = deferred<{ data: ReturnType<typeof job> }>();
    mocks.enqueue.mockReturnValue(enqueue.promise);
    const onClose = vi.fn();
    render(
      <AuditExportProgress
        open
        filters={{ action: "audit.*" }}
        onClose={onClose}
      />,
    );
    await flush();
    act(() => button("Start export").click());
    await flush();
    rerender(
      <AuditExportProgress
        open={false}
        filters={{ action: "audit.*" }}
        onClose={onClose}
      />,
    );

    enqueue.resolve({ data: job() });
    await flush();

    expect(mocks.job).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("revokes an in-flight poll synchronously when the operator stops watching", async () => {
    const polling = deferred<{ data: ReturnType<typeof job> }>();
    const onClose = vi.fn();
    mocks.enqueue.mockResolvedValue({ data: job() });
    mocks.job.mockReturnValue(polling.promise);
    await startExport(onClose);
    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    expect(mocks.job).toHaveBeenCalledTimes(1);

    const close = document.querySelector<HTMLButtonElement>(
      '.modal-card[aria-labelledby] > .modal-header button[aria-label="Close"]',
    );
    expect(close).not.toBeNull();
    act(() => close?.click());
    act(() => button("Stop watching").click());
    await flush();
    expect(onClose).toHaveBeenCalledTimes(1);

    polling.resolve({ data: job("in_progress", 10) });
    await flush();
    expect(vi.getTimerCount()).toBe(0);
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(mocks.job).toHaveBeenCalledTimes(1);
  });

  it("isolates a slow poll across close and reopen generations", async () => {
    const polling = deferred<{ data: ReturnType<typeof job> }>();
    const onClose = vi.fn();
    mocks.enqueue.mockResolvedValue({ data: job() });
    mocks.job.mockReturnValue(polling.promise);
    await startExport(onClose);
    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    expect(mocks.job).toHaveBeenCalledTimes(1);

    rerender(
      <AuditExportProgress
        open={false}
        filters={{ action: "audit.*" }}
        onClose={onClose}
      />,
    );
    rerender(
      <AuditExportProgress
        open
        filters={{ action: "audit.*" }}
        onClose={onClose}
      />,
    );
    await flush();
    expect(mocks.count).toHaveBeenCalledTimes(2);

    polling.resolve({ data: job("in_progress", 12) });
    await flush();
    expect(vi.getTimerCount()).toBe(0);
    expect(document.body.textContent).toContain("Estimated rows");
  });

  it("keeps polling strictly sequential while a slow request is unsettled", async () => {
    const firstPoll = deferred<{ data: ReturnType<typeof job> }>();
    mocks.enqueue.mockResolvedValue({ data: job() });
    mocks.job
      .mockReturnValueOnce(firstPoll.promise)
      .mockResolvedValueOnce({ data: job("completed", 25) });
    await startExport();

    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    expect(mocks.job).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(mocks.job).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);

    firstPoll.resolve({ data: job("in_progress", 8) });
    await flush();
    expect(vi.getTimerCount()).toBe(1);
    await act(async () => vi.advanceTimersByTimeAsync(1_499));
    expect(mocks.job).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTimeAsync(1));
    await flush();
    expect(mocks.job).toHaveBeenCalledTimes(2);
    expect(document.body.textContent).toContain("Ready");
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(mocks.job).toHaveBeenCalledTimes(2);
  });

  it("surfaces a rejected poll, retries it, and terminates on completion", async () => {
    mocks.enqueue.mockResolvedValue({ data: job() });
    mocks.job
      .mockRejectedValueOnce(new Error("connection reset"))
      .mockResolvedValueOnce({ data: job("completed", 25) });
    await startExport();

    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    await flush();
    expect(document.querySelector('[role="status"]')?.textContent).toContain(
      "connection reset",
    );
    expect(vi.getTimerCount()).toBe(1);

    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    await flush();
    expect(mocks.job).toHaveBeenCalledTimes(2);
    expect(document.body.textContent).toContain("Ready");
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(mocks.job).toHaveBeenCalledTimes(2);
  });

  it("retries result errors and stops cleanly on a failed job", async () => {
    mocks.enqueue.mockResolvedValue({ data: job() });
    mocks.job
      .mockResolvedValueOnce({ error: { message: "temporary outage" } })
      .mockResolvedValueOnce({
        data: { ...job("failed"), errorReason: "archive unavailable" },
      });
    await startExport();

    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    await flush();
    expect(document.querySelector('[role="status"]')?.textContent).toContain(
      "temporary outage",
    );
    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    await flush();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "archive unavailable",
    );
    expect(vi.getTimerCount()).toBe(0);
  });
});
