// @vitest-environment happy-dom

import axe from "axe-core";
import { act, type ReactElement, type ReactNode } from "react";
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

import type { AudienceSync, AudienceSyncRun } from "../../lib/api-client";

const mocks = vi.hoisted(() => ({
  downloadReceipt: vi.fn(),
  listRuns: vi.fn(),
  onExcludedCountChange: null as ((count: number | null) => void) | null,
  run: vi.fn(),
  saveFile: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("../../lib/api-client", () => ({
  audienceSyncsApi: {
    downloadExclusionReceipt: mocks.downloadReceipt,
    listRuns: mocks.listRuns,
    run: mocks.run,
  },
}));

vi.mock("../../lib/file-transfer", () => ({
  saveFile: mocks.saveFile,
}));

vi.mock("../../components/Toast", () => ({
  toast: {
    error: mocks.toastError,
    success: mocks.toastSuccess,
  },
}));

vi.mock("../../components/SlideoverShell", () => ({
  SlideoverShell: ({
    title,
    subtitle,
    headerActions,
    children,
    footer,
  }: {
    title: ReactNode;
    subtitle?: ReactNode;
    headerActions?: ReactNode;
    children: ReactNode;
    footer?: ReactNode;
  }) => (
    <aside aria-label="Audience sync run details">
      <h2>{title}</h2>
      {subtitle}
      {headerActions}
      {children}
      {footer}
    </aside>
  ),
}));

vi.mock("../../components/dataplatform/SyncConsentPreviewPanel", () => ({
  SyncConsentPreviewPanel: ({
    onExcludedCountChange,
  }: {
    onExcludedCountChange: (count: number | null) => void;
  }) => {
    mocks.onExcludedCountChange = onExcludedCountChange;
    return <div>Verified consent preview</div>;
  },
}));

import { AudienceSyncRunsSlideover } from "../../components/audiencesync/AudienceSyncRunsSlideover";

const sync: AudienceSync = {
  id: "sync-complete-identifier-001",
  name: "Warehouse audience",
  source: { segment_id: "segment-complete-identifier-001" },
  destination: {
    type: "webhook",
    url: "https://operator:private@example.test/hooks/token/secret-value?api_key=private-query#bearer-private",
    secret_set: true,
  },
  schedule: "manual",
  enabled: true,
  created_at: "2026-07-01T08:00:00.000Z",
  updated_at: "2026-07-16T08:00:00.000Z",
};

function run(overrides: Partial<AudienceSyncRun> = {}): AudienceSyncRun {
  return {
    id: "run-complete-identifier-001",
    sync_id: sync.id,
    status: "failed",
    rows_exported: 48,
    batches_sent: 2,
    started_at: "2026-07-16T08:10:00.000Z",
    finished_at: "2026-07-16T08:10:08.000Z",
    error:
      "receiver 401 https://user:password@private.internal/hook?token=secret subscriber@example.test",
    external_job_id: "provider-job-complete-001",
    external_audience_id: "provider-audience-complete-001",
    provider_message: "Authorization bearer live-private-token",
    provider_status: "401",
    provider_checked_at: "2026-07-16T08:10:08.000Z",
    provider_poll_attempts: 1,
    excluded_count: 3,
    ...overrides,
  };
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.onExcludedCountChange = null;
  mocks.listRuns.mockResolvedValue({ data: { items: [run()] } });
  mocks.run.mockResolvedValue({ data: run() });
  mocks.downloadReceipt.mockResolvedValue({
    data: {
      blob: new Blob(["id,reason\n"], { type: "text/csv" }),
      filename: "exclusion-receipt.csv",
    },
  });
  mocks.saveFile.mockResolvedValue({ ok: true });
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

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function button(label: string): HTMLButtonElement {
  const match = Array.from(
    document.querySelectorAll<HTMLButtonElement>("button"),
  ).find((candidate) => candidate.textContent?.trim() === label);
  if (!match) throw new Error(`Missing button: ${label}`);
  return match;
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

function renderSurface(props?: { canRun?: boolean; onRan?: () => void }): void {
  render(
    <AudienceSyncRunsSlideover
      sync={sync}
      canRun={props?.canRun ?? true}
      onClose={vi.fn()}
      onRan={props?.onRan ?? vi.fn()}
    />,
  );
}

describe("AudienceSyncRunsSlideover maturity", () => {
  it("classifies sensitive failures, redacts destination details, and exposes complete evidence accessibly", async () => {
    renderSurface({ canRun: false });
    await flush();

    expect(document.body.textContent).toContain(
      "receiver rejected the configured authentication",
    );
    expect(document.body.textContent).toContain("run-complete-identifier-001");
    expect(document.body.textContent).toContain("sync-complete-identifier-001");
    expect(document.body.textContent).toContain(
      "https://example.test/hooks/[redacted]/[redacted]",
    );
    for (const secret of [
      "operator",
      "private-query",
      "bearer-private",
      "live-private-token",
      "subscriber@example.test",
      "private.internal",
    ]) {
      expect(document.body.textContent).not.toContain(secret);
    }
    expect(container?.querySelector("[title]")).toBeNull();

    const runNow = button("Run now");
    expect(runNow.disabled).toBe(false);
    expect(runNow.getAttribute("aria-disabled")).toBe("true");
    expect(document.body.textContent).toContain(
      "administrator role is required",
    );

    const details = document.querySelector<HTMLDetailsElement>("details");
    expect(details).not.toBeNull();
    act(() => details?.setAttribute("open", ""));
    expect(details?.textContent).toContain("provider-job-complete-001");
    expect(details?.textContent).toContain("provider-audience-complete-001");

    const result = await axe.run(container ?? document.body);
    expect(
      result.violations.filter(
        (violation) =>
          violation.impact === "critical" || violation.impact === "serious",
      ),
    ).toEqual([]);
  });

  it("contains history rejection and retries without exposing thrown detail", async () => {
    mocks.listRuns
      .mockRejectedValueOnce(
        new Error("database host, tenant predicate, and private payload"),
      )
      .mockResolvedValueOnce({ data: { items: [run()] } });
    renderSurface();
    await flush();

    expect(document.body.textContent).toContain(
      "The service could not be reached. Check the connection and retry.",
    );
    expect(document.body.textContent).not.toContain("database host");
    act(() => button("Retry").click());
    await flush();
    expect(mocks.listRuns).toHaveBeenCalledTimes(2);
    expect(document.body.textContent).toContain("run-complete-identifier-001");
  });

  it("single-flights a run and reports a failed closed result with only safe support detail", async () => {
    const pending = deferred<{ data: AudienceSyncRun }>();
    mocks.run.mockReturnValue(pending.promise);
    const onRan = vi.fn();
    renderSurface({ onRan });
    await flush();

    act(() => {
      button("Run now").click();
      button("Run now").click();
    });
    expect(mocks.run).toHaveBeenCalledTimes(1);
    expect(button("Running…").disabled).toBe(false);
    expect(button("Running…").getAttribute("aria-disabled")).toBe("true");
    expect(document.body.textContent).toContain("up to 60 seconds");

    await act(async () => {
      pending.resolve({ data: run() });
      await pending.promise;
      await Promise.resolve();
      await Promise.resolve();
    });
    await flush();

    expect(onRan).toHaveBeenCalledTimes(1);
    expect(mocks.toastError).toHaveBeenCalledWith({
      message: "The audience sync run failed.",
      detail:
        "The receiver rejected the configured authentication. Support reference: run run-complete-identifier-001.",
    });
    expect(JSON.stringify(mocks.toastError.mock.calls)).not.toContain(
      "live-private-token",
    );
    expect(mocks.listRuns).toHaveBeenCalledTimes(2);
  });

  it("fails closed on an invalid run response instead of announcing success", async () => {
    mocks.run.mockResolvedValue({
      data: { ...run(), sync_id: "different-sync" },
    });
    const onRan = vi.fn();
    renderSurface({ onRan });
    await flush();
    act(() => button("Run now").click());
    await flush();

    expect(onRan).not.toHaveBeenCalled();
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
    expect(mocks.toastError).toHaveBeenCalledWith({
      message: "The audience sync response could not be verified.",
      detail:
        "No success state is being assumed. Refresh history before retrying.",
    });
  });

  it("single-flights confidential receipt transfer and confirms only a completed save", async () => {
    const pending = deferred<{
      data: { blob: Blob; filename: string };
    }>();
    mocks.downloadReceipt.mockReturnValue(pending.promise);
    renderSurface();
    await flush();

    act(() => {
      button("Download receipt").click();
      button("Download receipt").click();
    });
    expect(mocks.downloadReceipt).toHaveBeenCalledTimes(1);
    expect(button("Downloading receipt…").disabled).toBe(false);
    expect(button("Downloading receipt…").getAttribute("aria-disabled")).toBe(
      "true",
    );

    const blob = new Blob(["id,reason\n"], { type: "text/csv" });
    await act(async () => {
      pending.resolve({
        data: { blob, filename: "exclusion-receipt.csv" },
      });
      await pending.promise;
      await Promise.resolve();
      await Promise.resolve();
    });
    await flush();

    expect(mocks.saveFile).toHaveBeenCalledWith({
      data: blob,
      suggestedName: "exclusion-receipt.csv",
      label: "Audience sync exclusion receipt",
      privacy: "confidential",
      mimeType: "text/csv;charset=utf-8",
    });
    expect(mocks.toastSuccess).toHaveBeenCalledWith({
      message: "Exclusion receipt saved.",
      detail:
        "Run run-complete-identifier-001 was exported through the confidential transfer flow.",
    });
  });

  it("retains and labels verified history when a background refresh fails", async () => {
    renderSurface();
    await flush();
    mocks.listRuns.mockResolvedValueOnce({
      error: {
        kind: "timeout",
        message: "private upstream timeout detail",
      },
    });
    act(() => button("Refresh history").click());
    await flush();

    expect(document.body.textContent).toContain("run-complete-identifier-001");
    expect(document.body.textContent).toContain(
      "Showing last verified audience-sync run history",
    );
    expect(document.body.textContent).not.toContain(
      "private upstream timeout detail",
    );
  });
});
