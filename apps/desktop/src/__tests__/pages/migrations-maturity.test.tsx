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

import type { MigrationJob } from "../../lib/api-client";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

interface StreamHandlers {
  onStatus?: (
    status: "connecting" | "open" | "reconnecting" | "closed",
  ) => void;
  onProgress?: (event: unknown) => void;
  onSnapshot?: (job: MigrationJob) => void;
  onDone?: (event: { job: MigrationJob }) => void;
  onError?: (error: { message: string }) => void;
}

const mocks = vi.hoisted(() => ({
  canAdmin: { value: true },
  roleStatus: { value: "ready" },
  listMigrations: vi.fn(),
  listSources: vi.fn(),
  getMigration: vi.fn(),
  refreshSession: vi.fn(),
  rollback: vi.fn(),
  resume: vi.fn(),
  cancel: vi.fn(),
  connect: vi.fn(),
  disconnect: vi.fn(),
  streamHandlers: { value: null as StreamHandlers | null },
  consumeReturn: vi.fn(),
  setSection: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  toastInfo: vi.fn(),
  openUrl: vi.fn(),
}));

vi.mock("../../lib/api-client", () => ({
  api: {
    listMigrations: mocks.listMigrations,
    listMigrationSources: mocks.listSources,
    getMigration: mocks.getMigration,
    refreshMigrationSourceSession: mocks.refreshSession,
    rollbackMigration: mocks.rollback,
    resumeMigration: mocks.resume,
  },
  cancelMigration: mocks.cancel,
  connectMigrationEvents: mocks.connect,
}));

vi.mock("../../lib/store", () => ({
  useCanAdmin: () => mocks.canAdmin.value,
  useRoleStatus: () => mocks.roleStatus.value,
  setSection: mocks.setSection,
}));

vi.mock("../../lib/migration-deep-link", () => ({
  consumePendingMigrationApiKeyReturn: mocks.consumeReturn,
}));

vi.mock("../../components/Toast", () => ({
  toast: {
    error: mocks.toastError,
    success: mocks.toastSuccess,
    info: mocks.toastInfo,
  },
}));

vi.mock("../../lib/tauri", () => ({
  tauriApi: { openUrl: mocks.openUrl },
}));

vi.mock("../../lib/dashboard-url", () => ({
  getDashboardUrl: () => "https://dashboard.example.test",
}));

vi.mock("../../components/MigrationWizard", () => ({
  MigrationWizard: ({
    initialSourceId,
    initialCapabilities,
    onClose,
  }: {
    initialSourceId?: string;
    initialCapabilities?: unknown[];
    onClose: (created: boolean) => void;
  }) => (
    <div role="dialog" aria-label="Migration wizard mock">
      Wizard source: {initialSourceId ?? "none"}
      <span>Wizard capabilities: {initialCapabilities?.length ?? 0}</span>
      <button type="button" onClick={() => onClose(false)}>
        Close wizard
      </button>
    </div>
  ),
}));

import { Migrations } from "../../pages/Migrations";

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & {
      IS_REACT_ACT_ENVIRONMENT?: boolean;
    }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.canAdmin.value = true;
  mocks.roleStatus.value = "ready";
  mocks.consumeReturn.mockReturnValue(null);
  mocks.listMigrations.mockResolvedValue({ data: [liveJob()] });
  mocks.getMigration.mockImplementation((jobId: string) =>
    Promise.resolve({
      data: jobId === "job-complete-456" ? completedJob() : liveJob(),
    }),
  );
  mocks.listSources.mockResolvedValue({ data: sourceCapabilities() });
  mocks.rollback.mockResolvedValue({
    data: { job_id: "job-complete-456", state: "running" },
  });
  mocks.resume.mockResolvedValue({
    data: { job_id: "job-live-123", status: "importing" },
  });
  mocks.cancel.mockResolvedValue({
    data: { job_id: "job-live-123", cancelled: true, status: "importing" },
  });
  mocks.refreshSession.mockResolvedValue({ data: liveJob() });
  mocks.connect.mockImplementation(
    (_jobId: string, handlers: StreamHandlers) => {
      mocks.streamHandlers.value = handlers;
      return mocks.disconnect;
    },
  );
  mocks.openUrl.mockResolvedValue(undefined);
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
  document.body.style.overflow = "";
  mocks.streamHandlers.value = null;
});

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function sourceCapabilities(): Array<{
  source: "beehiiv";
  auth_method: string;
  supports: { subscribers: boolean; automation_mode: "rebuild_review" };
}> {
  return [
    {
      source: "beehiiv",
      auth_method: "api_key",
      supports: { subscribers: true, automation_mode: "rebuild_review" },
    },
  ];
}

function liveJob(overrides: Partial<MigrationJob> = {}): MigrationJob {
  return {
    id: "job-live-123",
    source: "beehiiv",
    status: "importing",
    started_at: "2026-07-16T08:00:00.000Z",
    rollback_until: "2026-07-23T09:00:00.000Z",
    source_session_expires_at: "2099-01-01T00:00:00.000Z",
    cursor: { provider_cursor: "cursor-secret-value" },
    progress: {
      subscribers_done: 50,
      subscribers_total: 100,
      automations_done: 0,
      automations_total: 5,
      paid_subs_done: 0,
      paid_subs_total: 3,
    },
    ...overrides,
  };
}

function completedJob(overrides: Partial<MigrationJob> = {}): MigrationJob {
  return liveJob({
    id: "job-complete-456",
    status: "completed",
    completed_at: "2026-07-16T09:00:00.000Z",
    rollback_until: "2099-07-23T09:00:00.000Z",
    verification_report: {
      subscribers_imported: 100,
      suppression_list_size: 4,
      resource_completeness: [
        {
          resource: "subscribers",
          label: "Subscribers",
          source_total: 100,
          imported: 100,
          supported: true,
          status: "imported_runtime",
        },
      ],
      discovery_warnings: [
        "Authorization: Bearer report-secret at https://provider.test/private",
      ],
      data_loss_estimate_pct: 0,
    },
    ...overrides,
  });
}

function render(node: ReactElement = <Migrations />): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(node));
}

function buttons(label: string): HTMLButtonElement[] {
  return Array.from(
    document.querySelectorAll<HTMLButtonElement>("button"),
  ).filter((candidate) => candidate.textContent?.trim() === label);
}

function button(label: string): HTMLButtonElement {
  const match = buttons(label)[0];
  if (!match) throw new Error(`Missing button: ${label}`);
  return match;
}

async function waitFor(assertion: () => void): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 60; attempt += 1) {
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

async function renderLoaded(): Promise<void> {
  render();
  await waitFor(() =>
    expect(document.body.textContent).toContain("job-live-123"),
  );
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

describe("Migrations production maturity", () => {
  it("renders verified semantic evidence, full identifiers, and source truth without native titles", async () => {
    await renderLoaded();

    expect(document.querySelector("table")?.textContent).toContain(
      "job-live-123",
    );
    expect(
      document.querySelector('time[datetime="2026-07-16T08:00:00.000Z"]'),
    ).not.toBeNull();
    expect(document.body.textContent).toContain("metadata only");
    expect(document.body.textContent).toContain("never Stripe billing objects");
    expect(document.querySelectorAll("[title]")).toHaveLength(0);

    const result = await axe.run(document.body, {
      rules: { region: { enabled: false } },
    });
    expect(
      result.violations.filter((violation) =>
        ["serious", "critical"].includes(violation.impact ?? ""),
      ),
    ).toEqual([]);

    const source = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Start Beehiiv migration"]',
    );
    expect(source).not.toBeNull();
    act(() => source?.click());
    expect(document.body.textContent).toContain("Wizard source: beehiiv");
  });

  it("keeps viewer permission reasons focusable and blocks every mutation entry", async () => {
    mocks.canAdmin.value = false;
    await renderLoaded();

    const newMigration = button("New migration");
    expect(newMigration.disabled).toBe(false);
    expect(newMigration.getAttribute("aria-disabled")).toBe("true");
    newMigration.focus();
    expect(document.activeElement).toBe(newMigration);
    expect(document.body.textContent).toContain(
      "Viewer mode: an admin role is required",
    );

    const source = document.querySelector<HTMLButtonElement>(
      'button[aria-label^="Start Beehiiv migration"]',
    );
    expect(source).not.toBeNull();
    expect(source?.getAttribute("aria-disabled")).toBe("true");
    act(() => source?.click());
    expect(document.body.textContent).not.toContain("Wizard source:");

    const cancel = button("Cancel job");
    expect(cancel.disabled).toBe(false);
    expect(cancel.getAttribute("aria-disabled")).toBe("true");
    act(() => cancel.click());
    expect(mocks.cancel).not.toHaveBeenCalled();
  });

  it("keeps large-history search and page boundaries explicit and keyboard reachable", async () => {
    await renderLoaded();
    const searchLabel = Array.from(document.querySelectorAll("label")).find(
      (label) => label.textContent?.trim() === "Search verified jobs",
    );
    const search = document.getElementById(
      searchLabel?.htmlFor ?? "missing",
    ) as HTMLInputElement | null;
    expect(search).not.toBeNull();
    expect(button("Previous page").getAttribute("aria-disabled")).toBe("true");
    expect(button("Next page").getAttribute("aria-disabled")).toBe("true");
    button("Next page").focus();
    expect(document.activeElement).toBe(button("Next page"));

    setInput(search!, "no-such-job");
    expect(document.body.textContent).toContain(
      "No jobs match the current filter and search",
    );
    expect(button("Clear search").getAttribute("aria-disabled")).toBeNull();
    act(() => button("Clear search").click());
    expect(document.body.textContent).toContain("job-live-123");
  });

  it("single-flights refresh, retains stale verified rows, and never exposes raw service errors", async () => {
    await renderLoaded();
    const pending = deferred<{
      error: {
        message: string;
        kind: "network";
        code: string;
        requestId: string;
      };
    }>();
    const baselineCalls = mocks.listMigrations.mock.calls.length;
    mocks.listMigrations.mockReturnValueOnce(pending.promise);

    const refresh = button("Refresh");
    act(() => {
      refresh.click();
      refresh.click();
    });
    expect(mocks.listMigrations).toHaveBeenCalledTimes(baselineCalls + 1);

    await act(async () => {
      pending.resolve({
        error: {
          message: "postgres password=hunter2 provider=https://private.test",
          kind: "network",
          code: "MIGRATION_LIST_TIMEOUT",
          requestId: "req-safe-7",
        },
      });
      await pending.promise;
    });
    await waitFor(() =>
      expect(document.body.textContent).toContain(
        "last verified snapshot remains visible",
      ),
    );

    expect(document.body.textContent).toContain("job-live-123");
    expect(document.body.textContent).toContain("MIGRATION_LIST_TIMEOUT");
    expect(document.body.textContent).toContain("req-safe-7");
    expect(document.body.textContent).not.toContain("hunter2");
    expect(document.body.textContent).not.toContain("private.test");
  });

  it("distinguishes an unverified initial failure from a verified empty history", async () => {
    mocks.listMigrations.mockRejectedValue(
      new Error("database password=initial-secret"),
    );
    mocks.listSources.mockResolvedValue({
      error: {
        message: "provider token=source-secret",
        kind: "network",
        code: "SOURCE_CATALOG_OFFLINE",
      },
    });
    render();
    await waitFor(() =>
      expect(document.body.textContent).toContain(
        "No verified migration history is available",
      ),
    );

    expect(document.body.textContent).toContain(
      "No verified source catalog is available",
    );
    expect(document.body.textContent).toContain(
      "Migration history could not be verified",
    );
    expect(document.body.textContent).toContain(
      "Migration history is unavailable",
    );
    expect(document.body.textContent).toContain("Verification required");
    expect(document.body.textContent).not.toContain(
      "Migration history is being verified",
    );
    expect(document.body.textContent).not.toContain("Verification pending");
    expect(document.body.textContent).not.toContain("initial-secret");
    expect(document.body.textContent).not.toContain("source-secret");
    expect(document.body.textContent).not.toContain("verified empty history");
    expect(
      document.querySelector('[aria-label="Verifying migration history"]'),
    ).toBeNull();
  });

  it("blocks setup until the initial source catalog is verified and reuses that exact snapshot", async () => {
    const pending = deferred<{ data: ReturnType<typeof sourceCapabilities> }>();
    mocks.listSources.mockReturnValueOnce(pending.promise);
    render();

    await waitFor(() => expect(mocks.listSources).toHaveBeenCalledTimes(1));
    const newMigration = button("New migration");
    expect(newMigration.getAttribute("aria-disabled")).toBe("true");
    expect(document.body.textContent).toContain(
      "Migration setup will be available after the source capability catalog is verified",
    );
    act(() => newMigration.click());
    expect(document.body.textContent).not.toContain("Wizard source:");

    await act(async () => {
      pending.resolve({ data: sourceCapabilities() });
      await pending.promise;
    });
    await waitFor(() =>
      expect(newMigration.getAttribute("aria-disabled")).toBeNull(),
    );
    act(() => newMigration.click());
    expect(document.body.textContent).toContain("Wizard source: none");
    expect(document.body.textContent).toContain("Wizard capabilities: 1");
    expect(mocks.listSources).toHaveBeenCalledTimes(1);
  });

  it("does not certify a malformed source catalog as a verified empty catalog", async () => {
    mocks.listSources.mockResolvedValue({ data: { count: 0 } });
    render();
    await waitFor(() =>
      expect(document.body.textContent).toContain(
        "No verified source catalog is available",
      ),
    );

    expect(document.body.textContent).toContain(
      "migration_sources_invalid_envelope",
    );
    expect(document.body.textContent).not.toContain(
      "No compatible migration adapters are available",
    );
  });

  it("retains stale source context but blocks source-card starts until reverified", async () => {
    await renderLoaded();
    mocks.listSources.mockResolvedValueOnce({
      error: {
        kind: "network",
        code: "SOURCE_REFRESH_FAILED",
        message: "provider token=not-for-rendering",
      },
    });
    act(() => button("Refresh").click());
    await waitFor(() =>
      expect(document.body.textContent).toContain(
        "Starting from a source card is unavailable until the capability catalog is freshly verified",
      ),
    );

    const source = document.querySelector<HTMLButtonElement>(
      'button[aria-label*="Capability verification is stale"]',
    );
    expect(source).not.toBeNull();
    expect(source?.disabled).toBe(false);
    expect(source?.getAttribute("aria-disabled")).toBe("true");
    act(() => source?.click());
    expect(document.body.textContent).not.toContain("Wizard source:");
    expect(document.body.textContent).not.toContain("not-for-rendering");
  });

  it("closes pending tenant mutations if admin permission is revoked", async () => {
    await renderLoaded();
    act(() => button("Cancel job").click());
    expect(document.body.textContent).toContain(
      "Cancel at the next checkpoint?",
    );

    mocks.canAdmin.value = false;
    act(() => root?.render(<Migrations />));
    await waitFor(() =>
      expect(document.body.textContent).not.toContain(
        "Cancel at the next checkpoint?",
      ),
    );
    expect(mocks.cancel).not.toHaveBeenCalled();
  });

  it("removes an open detail snapshot when the refreshed read is denied", async () => {
    await renderLoaded();
    act(() => button("View details").click());
    expect(document.body.textContent).toContain("Job provenance");
    mocks.listMigrations.mockResolvedValueOnce({
      error: {
        status: 403,
        code: "permission_denied",
        message: "prior tenant detail must not remain",
      },
    });

    act(() => button("Refresh").click());
    await waitFor(() =>
      expect(document.body.textContent).not.toContain("Job provenance"),
    );
    expect(document.body.textContent).toContain(
      "No verified migration history is available",
    );
    expect(document.body.textContent).not.toContain(
      "prior tenant detail must not remain",
    );
  });

  it("refreshes an open detail from its exact job endpoint", async () => {
    await renderLoaded();
    act(() => button("View details").click());
    const listCalls = mocks.listMigrations.mock.calls.length;

    await act(async () => {
      button("Refresh snapshot").click();
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(mocks.getMigration).toHaveBeenCalledWith("job-live-123"),
    );
    expect(mocks.listMigrations).toHaveBeenCalledTimes(listCalls);
  });

  it("contains live stream races and renders checkpoint truth without raw payload or cursor detail", async () => {
    await renderLoaded();
    act(() => button("View details").click());
    await waitFor(() =>
      expect(mocks.connect).toHaveBeenCalledWith(
        "job-live-123",
        expect.any(Object),
      ),
    );

    act(() => {
      mocks.streamHandlers.value?.onStatus?.("open");
      mocks.streamHandlers.value?.onProgress?.({
        resource: "automations",
        completed: 1,
        total: 5,
        current_step: "Authorization: Bearer stream-super-secret",
        snapshot: liveJob().progress,
        at: "2026-07-17T08:30:00.000Z",
      });
      mocks.streamHandlers.value?.onError?.({
        message: "provider token=raw-stream-secret",
      });
    });

    expect(document.body.textContent).toContain("Automation rebuild records");
    expect(document.body.textContent).toContain("0 of 5");
    expect(document.body.textContent).toContain(
      "1 server cursor field recorded",
    );
    expect(document.body.textContent).toContain("The stream was interrupted");
    expect(document.body.textContent).not.toContain("stream-super-secret");
    expect(document.body.textContent).not.toContain("raw-stream-secret");
    expect(document.body.textContent).not.toContain("cursor-secret-value");

    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    const result = await axe.run(dialog ?? document.body, {
      rules: { region: { enabled: false } },
    });
    expect(
      result.violations.filter((violation) =>
        ["serious", "critical"].includes(violation.impact ?? ""),
      ),
    ).toEqual([]);
  });

  it("requires the exact job for cancellation and rejects an unverified acknowledgement", async () => {
    mocks.cancel.mockResolvedValue({
      data: { job_id: "wrong-job", cancelled: true, status: "importing" },
    });
    await renderLoaded();
    act(() => button("Cancel job").click());
    expect(document.body.textContent).toContain(
      "Cancel at the next checkpoint?",
    );

    const confirm = button("Cancel this job");
    expect(confirm.getAttribute("aria-disabled")).toBe("true");
    const input = document.querySelector<HTMLInputElement>("input.input.mono");
    setInput(input!, "job-live-123");
    act(() => confirm.click());

    await waitFor(() =>
      expect(mocks.toastError).toHaveBeenCalledWith(
        expect.objectContaining({
          message: "Cancellation could not be confirmed.",
          detail: expect.stringContaining("migration_cancel_invalid_ack"),
        }),
      ),
    );
    await waitFor(() => expect(buttons("Cancel this job")).toHaveLength(1));
    expect(document.body.textContent).toContain(
      "Cancel at the next checkpoint?",
    );
  });

  it("resumes a cancelled job from its checkpoint exactly once", async () => {
    const cancelled = liveJob({
      status: "failed",
      error: "migration cancelled by operator at provider checkpoint",
    });
    mocks.listMigrations.mockResolvedValue({
      data: [cancelled],
    });
    mocks.getMigration.mockResolvedValue({ data: cancelled });
    render();
    await waitFor(() =>
      expect(document.body.textContent).toContain("job-live-123"),
    );
    act(() => button("View details").click());
    expect(document.body.textContent).not.toContain("provider checkpoint");
    act(() => button("Resume from checkpoint").click());

    const confirm = buttons("Resume from checkpoint").at(-1)!;
    act(() => {
      confirm.click();
      confirm.click();
    });
    await waitFor(() => expect(mocks.resume).toHaveBeenCalledTimes(1));
    expect(mocks.resume).toHaveBeenCalledWith("job-live-123");
    await waitFor(() =>
      expect(mocks.toastSuccess).toHaveBeenCalledWith(
        expect.objectContaining({ message: "Resume accepted" }),
      ),
    );
  });

  it("keeps resume blocked until same-job credential recovery is verified by a fresh exact read", async () => {
    const stale = liveJob({
      status: "failed",
      error: "migration cancelled by operator",
      source_session_expires_at: null,
    });
    const healthy = liveJob({
      status: "failed",
      error: "migration cancelled by operator",
    });
    mocks.listMigrations.mockResolvedValue({ data: [stale] });
    mocks.refreshSession.mockResolvedValue({ data: healthy });
    // The reconnect acknowledgement alone must not unlock resume. Simulate a
    // stale first GET, then a later authoritative healthy read.
    mocks.getMigration.mockResolvedValue({ data: stale });

    render();
    await waitFor(() =>
      expect(document.body.textContent).toContain("job-live-123"),
    );
    act(() => button("View details").click());

    const resume = button("Resume from checkpoint");
    expect(resume.getAttribute("aria-disabled")).toBe("true");
    act(() => resume.click());
    expect(buttons("Resume from checkpoint")).toHaveLength(1);
    expect(mocks.resume).not.toHaveBeenCalled();

    const apiKey = document.querySelector<HTMLInputElement>(
      'input[type="password"]',
    );
    expect(apiKey).not.toBeNull();
    setInput(apiKey!, "beehiiv-secret");
    act(() => button("Refresh this job's session").click());

    await waitFor(() => expect(mocks.refreshSession).toHaveBeenCalledTimes(1));
    expect(mocks.refreshSession).toHaveBeenCalledWith("job-live-123", {
      apiKey: "beehiiv-secret",
      accountId: "",
      extra: {},
    });
    await waitFor(() =>
      expect(document.body.textContent).toContain(
        "migration_source_session_not_healthy",
      ),
    );
    expect(button("Resume from checkpoint").getAttribute("aria-disabled")).toBe(
      "true",
    );

    mocks.getMigration.mockResolvedValue({ data: healthy });
    act(() => button("Verify refreshed session").click());
    await waitFor(() =>
      expect(
        button("Resume from checkpoint").getAttribute("aria-disabled"),
      ).toBeNull(),
    );
    expect(mocks.getMigration).toHaveBeenCalledWith("job-live-123");
    expect(mocks.resume).not.toHaveBeenCalled();
  });

  it("rejects a wrong-source fresh resume snapshot before the mutation", async () => {
    const cancelled = liveJob({
      status: "failed",
      error: "migration cancelled by operator",
    });
    mocks.listMigrations.mockResolvedValue({ data: [cancelled] });
    mocks.getMigration.mockResolvedValue({
      data: { ...cancelled, source: "klaviyo" },
    });

    render();
    await waitFor(() =>
      expect(document.body.textContent).toContain("job-live-123"),
    );
    act(() => button("View details").click());
    act(() => button("Resume from checkpoint").click());
    const confirm = buttons("Resume from checkpoint").at(-1)!;
    act(() => confirm.click());

    await waitFor(() =>
      expect(mocks.toastError).toHaveBeenCalledWith(
        expect.objectContaining({
          detail: expect.stringContaining(
            "migration_resume_preflight_unavailable",
          ),
        }),
      ),
    );
    expect(mocks.resume).not.toHaveBeenCalled();
  });

  it("routes OAuth recovery to the hosted exact-job workspace", async () => {
    const mailchimp = liveJob({
      source: "mailchimp",
      status: "failed",
      error: "migration cancelled by operator",
      source_session_expires_at: null,
      selected_audience_ids: ["audience-one"],
    });
    mocks.listMigrations.mockResolvedValue({ data: [mailchimp] });

    render();
    await waitFor(() =>
      expect(document.body.textContent).toContain("job-live-123"),
    );
    act(() => button("View details").click());
    act(() => button("Open this exact job in web").click());

    await waitFor(() =>
      expect(mocks.openUrl).toHaveBeenCalledWith(
        "https://dashboard.example.test/app/migrations/job-live-123",
      ),
    );
    expect(button("Resume from checkpoint").getAttribute("aria-disabled")).toBe(
      "true",
    );
  });

  it("does not misrepresent original import counters as rollback completion", async () => {
    mocks.listMigrations.mockResolvedValue({
      data: [liveJob({ status: "rolling_back" })],
    });
    render();
    await waitFor(() =>
      expect(document.body.textContent).toContain(
        "Rollback is in progress. Original import scope",
      ),
    );
    expect(buttons("Cancel job")).toHaveLength(0);
    act(() => button("View details").click());
    expect(document.body.textContent).toContain(
      "No rollback percentage is inferred",
    );
    expect(document.body.textContent).toContain("Not a rollback percentage");
  });

  it("requires the exact job identifier and single-flights rollback through acknowledgement", async () => {
    mocks.listMigrations.mockResolvedValue({ data: [completedJob()] });
    const pending = deferred<{
      data: { job_id: string; state: string };
    }>();
    mocks.rollback.mockReturnValueOnce(pending.promise);
    render();
    await waitFor(() =>
      expect(document.body.textContent).toContain("job-complete-456"),
    );
    act(() => button("View details").click());
    expect(document.body.textContent).not.toContain("report-secret");
    expect(document.body.textContent).not.toContain("provider.test");
    expect(document.body.textContent).toContain("Cutover review is required");
    expect(document.body.textContent).not.toContain("Everything imported");
    act(() => button("Roll back imported records").click());

    const alertDialog = document.querySelector<HTMLElement>(
      '[role="alertdialog"]',
    );
    const axeResult = await axe.run(alertDialog ?? document.body, {
      rules: { region: { enabled: false } },
    });
    expect(
      axeResult.violations.filter((violation) =>
        ["serious", "critical"].includes(violation.impact ?? ""),
      ),
    ).toEqual([]);

    const confirm = button("Roll back this job");
    expect(confirm.disabled).toBe(false);
    expect(confirm.getAttribute("aria-disabled")).toBe("true");
    const input = document.querySelector<HTMLInputElement>("input.input.mono");
    expect(input).not.toBeNull();
    setInput(input!, "job-complete");
    expect(confirm.getAttribute("aria-disabled")).toBe("true");
    setInput(input!, "job-complete-456");
    expect(confirm.getAttribute("aria-disabled")).toBeNull();

    act(() => {
      confirm.click();
      confirm.click();
    });
    await waitFor(() => expect(mocks.rollback).toHaveBeenCalledTimes(1));
    expect(mocks.getMigration).toHaveBeenCalledWith("job-complete-456");
    expect(mocks.rollback).toHaveBeenCalledWith("job-complete-456");
    expect(button("Requesting rollback…").getAttribute("aria-busy")).toBe(
      "true",
    );

    await act(async () => {
      pending.resolve({
        data: { job_id: "job-complete-456", state: "running" },
      });
      await pending.promise;
    });
    await waitFor(() =>
      expect(document.body.textContent).not.toContain(
        "Roll back imported records?",
      ),
    );
    expect(mocks.toastSuccess).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Rollback accepted" }),
    );
  });

  it("contains synchronous mutation failures and keeps the exact confirmation available for retry", async () => {
    mocks.listMigrations.mockResolvedValue({ data: [completedJob()] });
    mocks.rollback.mockImplementationOnce(() => {
      throw new Error("provider secret=do-not-render");
    });
    render();
    await waitFor(() =>
      expect(document.body.textContent).toContain("job-complete-456"),
    );
    act(() => button("View details").click());
    act(() => button("Roll back imported records").click());
    const input = document.querySelector<HTMLInputElement>("input.input.mono");
    setInput(input!, "job-complete-456");
    act(() => button("Roll back this job").click());

    await waitFor(() =>
      expect(mocks.toastError).toHaveBeenCalledWith(
        expect.objectContaining({
          message: "Rollback could not be confirmed.",
        }),
      ),
    );
    await waitFor(() => expect(buttons("Roll back this job")).toHaveLength(1));
    expect(JSON.stringify(mocks.toastError.mock.calls)).not.toContain(
      "do-not-render",
    );
    expect(document.body.textContent).toContain("Roll back imported records?");
    expect(
      button("Roll back this job").getAttribute("aria-disabled"),
    ).toBeNull();
  });

  it("lets an acknowledged mutation settle after unmount without starting a detached refresh", async () => {
    mocks.listMigrations.mockResolvedValue({ data: [completedJob()] });
    const pending = deferred<{
      data: { job_id: string; state: string };
    }>();
    mocks.rollback.mockReturnValueOnce(pending.promise);
    render();
    await waitFor(() =>
      expect(document.body.textContent).toContain("job-complete-456"),
    );
    act(() => button("View details").click());
    act(() => button("Roll back imported records").click());
    const input = document.querySelector<HTMLInputElement>("input.input.mono");
    setInput(input!, "job-complete-456");
    act(() => button("Roll back this job").click());
    const listCallsBeforeUnmount = mocks.listMigrations.mock.calls.length;

    act(() => root?.unmount());
    root = null;
    await act(async () => {
      pending.resolve({
        data: { job_id: "job-complete-456", state: "running" },
      });
      await pending.promise;
    });

    expect(mocks.listMigrations).toHaveBeenCalledTimes(listCallsBeforeUnmount);
  });
});
