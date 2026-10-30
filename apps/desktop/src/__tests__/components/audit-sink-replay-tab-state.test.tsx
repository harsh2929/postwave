// @vitest-environment happy-dom

import { act, type ReactElement, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { AuditSink, ReplayJob } from "../../lib/api-client";

const mocks = vi.hoisted(() => ({
  cancel: vi.fn(),
  list: vi.fn(),
  replay: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("../../lib/api-client", () => ({
  api: {
    auditSinkReplay: mocks.replay,
    auditSinkReplayJobCancel: mocks.cancel,
    auditSinkReplayJobsList: mocks.list,
  },
}));

vi.mock("../../components/Toast", () => ({
  toast: { error: mocks.toastError, success: mocks.toastSuccess },
}));

import { AuditSinkReplayTab } from "../../components/audit/AuditSinkReplayTab";

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.replay.mockResolvedValue({ data: { job_id: "queued-job" } });
  mocks.cancel.mockResolvedValue({ data: { ok: true } });
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
});

function render(node: ReactElement): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(node));
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function waitFor(assertion: () => void): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await act(async () => {
        await new Promise((resolve) => window.setTimeout(resolve, 0));
      });
    }
  }
  throw lastError;
}

describe("AuditSinkReplayTab request isolation", () => {
  it("still accepts current job responses after the Strict Mode effect replay", async () => {
    mocks.list.mockResolvedValue({
      data: { jobs: [job("bbbbbbbb-strict-current-job")] },
    });
    render(
      <StrictMode>
        <AuditSinkReplayTab sinks={[sink("sink-b", "Current sink")]} canExecute />
      </StrictMode>,
    );

    await waitFor(() => {
      expect(
        document.querySelector(
          '[data-testid="replay-job-bbbbbbbb-strict-current-job"]',
        ),
      ).not.toBeNull();
    });
    expect(mocks.list.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("never renders a late job response from the previously selected sink", async () => {
    const previous = deferred<{ data: { jobs: ReplayJob[] } }>();
    mocks.list
      .mockReturnValueOnce(previous.promise)
      .mockResolvedValueOnce({ data: { jobs: [job("bbbbbbbb-current-job")] } });
    render(
      <AuditSinkReplayTab
        sinks={[sink("sink-a", "First sink"), sink("sink-b", "Second sink")]}
        canExecute
      />,
    );
    await waitFor(() => expect(mocks.list).toHaveBeenCalledWith("sink-a", { limit: 25 }));

    const select = document.querySelector<HTMLSelectElement>("select");
    if (!select) throw new Error("Expected the sink selector");
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")
        ?.set?.call(select, "sink-b");
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await waitFor(() => {
      expect(document.querySelector('[data-testid="replay-job-bbbbbbbb-current-job"]')).not.toBeNull();
    });

    await act(async () => {
      previous.resolve({ data: { jobs: [job("aaaaaaaa-previous-secret")] } });
      await previous.promise;
    });
    expect(
      document.querySelector('[data-testid="replay-job-aaaaaaaa-previous-secret"]'),
    ).toBeNull();
    expect(document.body.textContent).not.toContain("aaaaaaaa");
  });
});

function sink(id: string, name: string): AuditSink {
  return {
    id,
    kind: "http",
    name,
    enabled: true,
    config: {},
    output_format: "postwave_native",
    webhook_format: "postwave_v1",
    consecutive_failures: 0,
    auto_disable_after: 100,
    circuit_state: "closed",
  };
}

function job(id: string): ReplayJob {
  return {
    id,
    tenant_id: "tenant-1",
    sink_id: "sink-b",
    from_audit_id: 10,
    to_audit_id: 14,
    status: "completed",
    rows_sent: 5,
    rows_failed: 0,
    created_at: "2026-07-15T11:58:00.000Z",
  };
}
