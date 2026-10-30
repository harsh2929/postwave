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

import type {
  MigrationDoneEvent,
  MigrationJob,
  MigrationProgressEvent,
} from "../../lib/api-client";

interface StreamHandlers {
  onSnapshot?: (job: MigrationJob) => void;
  onProgress?: (event: MigrationProgressEvent) => void;
  onDone?: (event: MigrationDoneEvent) => void;
  onError?: (error: { message: string }) => void;
  onStatus?: (
    status: "connecting" | "open" | "reconnecting" | "closed",
  ) => void;
}

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  disconnect: vi.fn(),
  cancel: vi.fn(),
  getMigration: vi.fn(),
  handlers: { value: null as StreamHandlers | null },
}));

vi.mock("../../lib/api-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/api-client")>();
  return {
    ...actual,
    api: { ...actual.api, getMigration: mocks.getMigration },
    cancelMigration: mocks.cancel,
    connectMigrationEvents: (_jobId: string, handlers: StreamHandlers) => {
      mocks.handlers.value = handlers;
      return mocks.connect(_jobId, handlers);
    },
  };
});

import {
  normalizeMigrationDoneResources,
  ProgressView,
} from "../../components/migration/ProgressView";

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
  mocks.handlers.value = null;
  mocks.connect.mockReturnValue(mocks.disconnect);
  mocks.getMigration.mockResolvedValue({ data: importingJob() });
  mocks.cancel.mockResolvedValue({
    data: {
      job_id: "migration-job-complete-id",
      cancelled: true,
      status: "failed",
    },
  });
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
});

function importingJob(overrides: Partial<MigrationJob> = {}): MigrationJob {
  return {
    id: "migration-job-complete-id",
    source: "beehiiv",
    status: "importing",
    started_at: "2026-07-17T08:00:00.000Z",
    progress: {
      subscribers_done: 4,
      subscribers_total: 10,
      automations_done: 0,
      automations_total: 3,
      paid_subs_done: 0,
      paid_subs_total: 2,
    },
    ...overrides,
  };
}

function render(node: ReactElement): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(node));
}

function renderProgress(onComplete = vi.fn(), onCancel = vi.fn()): void {
  render(
    <ProgressView
      jobId="migration-job-complete-id"
      source="beehiiv"
      sourceLabel="Beehiiv"
      onComplete={onComplete}
      onCancel={onCancel}
    />,
  );
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

function setInput(input: HTMLInputElement, value: string): void {
  act(() => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

describe("migration live progress maturity", () => {
  it("strictly decodes exact terminal resource outcomes", () => {
    expect(
      normalizeMigrationDoneResources({
        subscribers: { imported: 10, skipped: 1, failed: 0, review: 2 },
      }),
    ).toEqual({
      subscribers: { imported: 10, skipped: 1, failed: 0, review: 2 },
    });
    expect(
      normalizeMigrationDoneResources({
        subscribers: { imported: 10, skipped: -1, failed: 0 },
      }),
    ).toBeNull();
    expect(
      normalizeMigrationDoneResources({
        subscribers: { imported: Number.NaN, skipped: 0, failed: 0 },
      }),
    ).toBeNull();
  });

  it("shows full provenance, ignores provider step text, and exposes stream recovery", async () => {
    renderProgress();
    expect(document.body.textContent).toContain("migration-job-complete-id");
    expect(
      document
        .querySelector('[role="progressbar"]')
        ?.hasAttribute("aria-valuenow"),
    ).toBe(false);

    act(() => {
      mocks.handlers.value?.onSnapshot?.(importingJob());
      mocks.handlers.value?.onProgress?.({
        resource: "subscribers",
        completed: 5,
        total: 10,
        current_step: "Authorization: Bearer raw-provider-secret",
        at: "2026-07-17T08:01:00.000Z",
        snapshot: { subscribers_done: 5, subscribers_total: 10 },
      });
      mocks.handlers.value?.onError?.({
        message: "provider password=raw-stream-secret",
      });
    });

    expect(document.body.textContent).toContain("Importing subscribers");
    expect(document.body.textContent).not.toContain("raw-provider-secret");
    expect(document.body.textContent).not.toContain("raw-stream-secret");
    expect(button("Reconnect live updates")).not.toBeNull();
    const result = await axe.run(document.body, {
      rules: { region: { enabled: false } },
    });
    expect(
      result.violations.filter((violation) =>
        ["serious", "critical"].includes(violation.impact ?? ""),
      ),
    ).toEqual([]);
  });

  it("requires the exact job id and single-flights cancellation", async () => {
    let resolve!: (value: {
      data: { job_id: string; cancelled: boolean; status: string };
    }) => void;
    const pending = new Promise<{
      data: { job_id: string; cancelled: boolean; status: string };
    }>((done) => {
      resolve = done;
    });
    mocks.cancel.mockReturnValueOnce(pending);
    const onCancel = vi.fn();
    renderProgress(vi.fn(), onCancel);
    act(() => mocks.handlers.value?.onSnapshot?.(importingJob()));
    act(() => button("Cancel migration").click());

    const confirm = button("Cancel this migration");
    const input = document.querySelector<HTMLInputElement>(
      ".migration-confirm-field input",
    );
    expect(input).not.toBeNull();
    expect(confirm.getAttribute("aria-disabled")).toBe("true");
    setInput(input!, "migration-job");
    expect(confirm.getAttribute("aria-disabled")).toBe("true");
    setInput(input!, "migration-job-complete-id");
    expect(confirm.getAttribute("aria-disabled")).toBeNull();

    act(() => {
      confirm.click();
      confirm.click();
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(mocks.cancel).toHaveBeenCalledTimes(1);
    expect(button("Requesting cancellation…").getAttribute("aria-busy")).toBe(
      "true",
    );

    await act(async () => {
      resolve({
        data: {
          job_id: "migration-job-complete-id",
          cancelled: true,
          status: "failed",
        },
      });
      await pending;
    });
    await flush();
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).not.toContain(
      "Cancel at the next safe checkpoint?",
    );
  });

  it("fails closed on mismatched acknowledgements without rendering raw errors", async () => {
    mocks.cancel.mockResolvedValueOnce({
      error: {
        status: 500,
        code: "migration_cancel_failed",
        message: "Authorization: Bearer do-not-render",
      },
    });
    renderProgress();
    act(() => button("Cancel migration").click());
    const input = document.querySelector<HTMLInputElement>(
      ".migration-confirm-field input",
    );
    setInput(input!, "migration-job-complete-id");
    act(() => button("Cancel this migration").click());
    await flush();

    expect(document.body.textContent).toContain(
      "Cancellation could not be confirmed.",
    );
    expect(document.body.textContent).not.toContain("do-not-render");
    expect(button("Cancel this migration")).not.toBeNull();
  });

  it("contains synchronous stream setup failures and offers reconnect", () => {
    mocks.connect.mockImplementationOnce(() => {
      throw new Error("provider token=do-not-render");
    });
    expect(() => renderProgress()).not.toThrow();
    expect(document.body.textContent).not.toContain("do-not-render");
    expect(button("Reconnect live updates")).not.toBeNull();
  });

  it("waits for a matching terminal snapshot when a done event is inconsistent", () => {
    const onComplete = vi.fn();
    renderProgress(onComplete);
    act(() =>
      mocks.handlers.value?.onDone?.({
        status: "completed",
        resources: {},
        job: importingJob(),
      }),
    );

    expect(onComplete).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain(
      "A terminal event could not be verified",
    );
    expect(button("Reconnect live updates")).not.toBeNull();
  });

  it("preserves exact done resources instead of reconstructing skipped work", () => {
    const onComplete = vi.fn();
    renderProgress(onComplete);
    act(() => {
      mocks.handlers.value?.onSnapshot?.(importingJob());
      mocks.handlers.value?.onDone?.({
        status: "completed",
        resources: {
          subscribers: { imported: 9, skipped: 0, failed: 1, review: 0 },
        },
        job: importingJob({ status: "completed" }),
      });
    });

    expect(onComplete).toHaveBeenCalledWith(
      expect.objectContaining({
        resources: {
          subscribers: { imported: 9, skipped: 0, failed: 1, review: 0 },
        },
      }),
    );
  });
});
