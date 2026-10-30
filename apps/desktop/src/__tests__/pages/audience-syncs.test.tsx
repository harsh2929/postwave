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

import type { AudienceSync, AudienceSyncRun } from "../../lib/api-client";

const mocks = vi.hoisted(() => ({
  canAdmin: { value: true },
  list: vi.fn(),
  remove: vi.fn(),
  run: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  capabilityAvailable: vi.fn(),
  capabilityFromApiError: vi.fn(),
  capabilityPartialNotConfigured: vi.fn(),
}));

vi.mock("../../lib/api-client", () => ({
  audienceSyncsApi: {
    list: mocks.list,
    remove: mocks.remove,
    run: mocks.run,
  },
}));

vi.mock("../../lib/store", () => ({
  useCanAdmin: () => mocks.canAdmin.value,
}));

vi.mock("../../lib/capability-observations", () => ({
  useCapabilityReporter: () => ({
    available: mocks.capabilityAvailable,
    fromApiError: mocks.capabilityFromApiError,
    partialNotConfigured: mocks.capabilityPartialNotConfigured,
  }),
}));

vi.mock("../../components/Toast", () => ({
  toast: { error: mocks.toastError, success: mocks.toastSuccess },
}));

vi.mock("../../components/AudienceDestinationsSection", () => ({
  AudienceDestinationsSection: () => <div>audience-destinations</div>,
}));

vi.mock("../../components/WritebackTargetsSection", () => ({
  WritebackTargetsSection: () => <div>writeback-targets</div>,
}));

vi.mock("../../components/audiencesync/AudienceSyncFormModal", () => ({
  AudienceSyncFormModal: ({ open }: { open: boolean }) =>
    open ? <div role="dialog">sync-form</div> : null,
}));

vi.mock("../../components/audiencesync/AudienceSyncRunsSlideover", () => ({
  AudienceSyncRunsSlideover: ({ sync }: { sync: AudienceSync }) => (
    <div role="dialog">runs:{sync.id}</div>
  ),
}));

import { AudienceSyncs, safeDestinationLabel } from "../../pages/AudienceSyncs";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

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
  mocks.list.mockResolvedValue({ data: { items: [sync("alpha")] } });
  mocks.remove.mockResolvedValue({ data: undefined });
  mocks.run.mockResolvedValue({ data: completedRun() });
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
  document.body.style.overflow = "";
  vi.clearAllMocks();
});

function sync(id: string, overrides: Partial<AudienceSync> = {}): AudienceSync {
  return {
    id,
    name: id === "alpha" ? "Alpha export" : `${id} export`,
    source: { list_id: id },
    destination: { type: "webhook", url: `https://${id}.example.test/hook` },
    schedule: "manual",
    enabled: true,
    created_at: "2026-07-16T08:00:00.000Z",
    updated_at: "2026-07-16T08:00:00.000Z",
    ...overrides,
  };
}

function completedRun(
  overrides: Partial<AudienceSyncRun> = {},
): AudienceSyncRun {
  return {
    id: "run-1",
    sync_id: "alpha",
    status: "succeeded",
    rows_exported: 1200,
    batches_sent: 2,
    started_at: "2026-07-16T08:00:00.000Z",
    finished_at: "2026-07-16T08:00:01.000Z",
    ...overrides,
  };
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function render(node: ReactElement = <AudienceSyncs />): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(node));
}

function button(label: string): HTMLButtonElement {
  const match = buttons(label)[0];
  if (!match) throw new Error(`Missing button: ${label}`);
  return match;
}

function buttons(label: string): HTMLButtonElement[] {
  return Array.from(
    document.querySelectorAll<HTMLButtonElement>("button"),
  ).filter((candidate) => candidate.textContent?.trim() === label);
}

async function waitFor(assertion: () => void): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await act(async () => Promise.resolve());
    }
  }
  throw lastError;
}

async function renderLoaded(): Promise<void> {
  render();
  await waitFor(() =>
    expect(document.body.textContent).toContain("Alpha export"),
  );
}

describe("AudienceSyncs", () => {
  it("keeps viewer rows read-only and never renders URL secrets", async () => {
    mocks.canAdmin.value = false;
    mocks.list.mockResolvedValue({
      data: {
        items: [
          sync("alpha", {
            destination: {
              type: "webhook",
              url: "https://alice:super-secret@hooks.example.test/ingest?token=abc#private",
            },
          }),
        ],
      },
    });
    await renderLoaded();

    expect(document.body.textContent).toContain(
      "https://hooks.example.test/ingest",
    );
    expect(document.body.textContent).not.toContain("super-secret");
    expect(document.body.textContent).not.toContain("token=abc");
    expect(button("Runs")).toBeTruthy();
    expect(buttons("Run now")).toHaveLength(0);
    expect(buttons("Edit")).toHaveLength(0);
    expect(buttons("Delete")).toHaveLength(0);
    expect(buttons("New sync")).toHaveLength(0);
    expect(safeDestinationLabel("not-a-url?api_key=secret#private")).toBe(
      "not-a-url",
    );
  });

  it("keeps the newest overlapping list response", async () => {
    const oldLoad = deferred<{ data: { items: AudienceSync[] } }>();
    const newLoad = deferred<{ data: { items: AudienceSync[] } }>();
    mocks.list
      .mockReset()
      .mockReturnValueOnce(oldLoad.promise)
      .mockReturnValueOnce(newLoad.promise);
    render();
    act(() => button("Refresh").click());

    await act(async () => {
      newLoad.resolve({ data: { items: [sync("newest")] } });
      await newLoad.promise;
    });
    await waitFor(() =>
      expect(document.body.textContent).toContain("newest export"),
    );

    await act(async () => {
      oldLoad.resolve({ data: { items: [sync("stale")] } });
      await oldLoad.promise;
    });
    expect(document.body.textContent).toContain("newest export");
    expect(document.body.textContent).not.toContain("stale export");
  });

  it("runs exactly once, locks every mutator, and reports closed-run totals", async () => {
    const pendingRun = deferred<{ data: AudienceSyncRun }>();
    mocks.list.mockResolvedValue({
      data: { items: [sync("alpha"), sync("beta")] },
    });
    mocks.run.mockReturnValue(pendingRun.promise);
    await renderLoaded();

    act(() => buttons("Run now")[0]?.click());
    expect(mocks.run).toHaveBeenCalledTimes(1);
    expect(mocks.run).toHaveBeenCalledWith("alpha");
    expect(button("Running…").disabled).toBe(false);
    expect(button("Running…").getAttribute("aria-disabled")).toBe("true");
    expect(button("Running…").getAttribute("aria-describedby")).toBeTruthy();
    expect(document.body.textContent).toContain(
      "Wait for the current audience-sync operation to finish",
    );
    expect(button("New sync").disabled).toBe(false);
    expect(button("New sync").getAttribute("aria-disabled")).toBe("true");
    expect(buttons("Edit").every((item) => item.disabled)).toBe(true);
    expect(buttons("Delete").every((item) => item.disabled)).toBe(true);
    act(() => buttons("Run now")[0]?.click());
    expect(mocks.run).toHaveBeenCalledTimes(1);

    await act(async () => {
      pendingRun.resolve({ data: completedRun() });
      await pendingRun.promise;
    });
    await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(2));
    expect(mocks.toastSuccess).toHaveBeenCalledWith(
      "Alpha export: exported 1,200 rows in 2 batches",
    );
  });

  it("serializes deletion, keeps the dialog busy, and reloads after success", async () => {
    const pendingDelete = deferred<{ data: undefined }>();
    mocks.list
      .mockResolvedValueOnce({ data: { items: [sync("alpha")] } })
      .mockResolvedValueOnce({ data: { items: [] } });
    mocks.remove.mockReturnValue(pendingDelete.promise);
    await renderLoaded();
    act(() => button("Delete").click());
    act(() => button("Delete sync").click());

    expect(mocks.remove).toHaveBeenCalledTimes(1);
    expect(mocks.remove).toHaveBeenCalledWith("alpha");
    expect(button("Working…").disabled).toBe(true);
    expect(button("Cancel").disabled).toBe(true);
    expect(button("New sync").disabled).toBe(false);
    expect(button("New sync").getAttribute("aria-disabled")).toBe("true");

    await act(async () => {
      pendingDelete.resolve({ data: undefined });
      await pendingDelete.promise;
    });
    await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(2));
    expect(mocks.toastSuccess).toHaveBeenCalledWith('Deleted "Alpha export"');
    await waitFor(() =>
      expect(document.body.textContent).not.toContain("Alpha export"),
    );
  });

  it("describes a missing server capability without showing onboarding", async () => {
    mocks.list.mockResolvedValue({
      error: { kind: "http", status: 404, message: "route missing" },
    });
    render();
    await waitFor(() => {
      expect(document.body.textContent).toContain(
        "Audience syncs aren't enabled on this Moosewave server",
      );
    });
    expect(document.body.textContent).not.toContain(
      "Keep every system in sync with your audience.",
    );
    expect(buttons("New sync")).toHaveLength(0);
    expect(mocks.capabilityPartialNotConfigured).toHaveBeenCalledWith(
      expect.stringContaining("Ad-platform destinations"),
    );
    expect(mocks.capabilityAvailable).not.toHaveBeenCalled();
  });
});
