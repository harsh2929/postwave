// @vitest-environment happy-dom

import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  exportSubscribersCSV: vi.fn(),
  saveFile: vi.fn(),
  toastError: vi.fn(),
  toastInfo: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("../../lib/api-client", () => ({
  api: { exportSubscribersCSV: mocks.exportSubscribersCSV },
}));
vi.mock("../../lib/file-transfer", () => ({ saveFile: mocks.saveFile }));
vi.mock("../../components/Toast", () => ({
  toast: {
    error: mocks.toastError,
    info: mocks.toastInfo,
    success: mocks.toastSuccess,
  },
}));

import {
  buildSubscribersExportManifest,
  subscribersExportManifestDetail,
  useSubscribersExport,
  type SubscribersExport,
  type SubscribersExportOutcome,
} from "../../pages/subscribers/useSubscribersExport";
import type { SubscribersData } from "../../pages/subscribers/useSubscribersData";
import type { SubscribersPageState } from "../../pages/subscribers/useSubscribersPageState";

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let controller: SubscribersExport | null = null;

function state(
  overrides: Partial<SubscribersPageState> = {},
): SubscribersPageState {
  return {
    query: "applied search",
    debouncedQuery: "applied search",
    filter: "subscribed",
    showArchived: true,
    sortColumn: "joined",
    sortOrder: "asc",
    ...overrides,
  } as SubscribersPageState;
}

function data(overrides: Partial<SubscribersData> = {}): SubscribersData {
  return {
    loading: false,
    matchTotal: 24,
    pageRows: [{ id: "one", email: "one@example.test" }],
    lastLoadedQueryRef: { current: "applied search" },
    ...overrides,
  } as SubscribersData;
}

function Probe({
  pageState,
  pageData,
}: {
  pageState: SubscribersPageState;
  pageData: SubscribersData;
}): ReactElement {
  controller = useSubscribersExport(pageState, pageData);
  return <span>{controller.exporting ? "exporting" : "idle"}</span>;
}

function renderHook(pageState = state(), pageData = data()): SubscribersExport {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(<Probe pageState={pageState} pageData={pageData} />));
  if (!controller) throw new Error("Subscribers export hook did not render");
  return controller;
}

async function runExport(): Promise<SubscribersExportOutcome> {
  let outcome: SubscribersExportOutcome | undefined;
  await act(async () => {
    outcome = await controller?.exportVisible();
  });
  if (!outcome) throw new Error("Subscribers export did not return an outcome");
  return outcome;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.exportSubscribersCSV.mockResolvedValue({
    data: {
      blob: new Blob(["email\none@example.test\n"], { type: "text/csv" }),
      filename: "subscribers.csv",
      truncated: false,
      exportedRows: 24,
    },
  });
  mocks.saveFile.mockResolvedValue({
    ok: true,
    status: "saved",
    transferId: "transfer-one",
    collision: false,
  });
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  controller = null;
});

describe("Subscribers complete-view export", () => {
  it("builds a visible bounded manifest without hidden control characters", () => {
    const manifest = buildSubscribersExportManifest(
      state({ debouncedQuery: "private@example.test\u202E=cmd" }),
      24,
      new Date("2026-07-18T08:30:00.000Z"),
    );
    expect(manifest).toEqual({
      generatedAt: "2026-07-18T08:30:00.000Z",
      query: "private@example.test\u202E=cmd",
      status: "enabled",
      includeArchived: true,
      sort: "created_at",
      order: "asc",
      expectedRows: 24,
      cap: 10_000,
      scope: "applied_view",
      classification: "personal",
      source: "server_complete",
    });
    const detail = subscribersExportManifestDetail(manifest!);
    expect(detail).toContain("private@example.test\\u202E=cmd");
    expect(detail).toContain("cap 10,000");
    expect(detail).toContain("personal data");
    expect(detail).toContain("server-complete path");
    expect(detail).not.toContain("\u202E");
  });

  it("freezes the applied query, archived scope, filter, and full-result sort", async () => {
    renderHook();

    await expect(runExport()).resolves.toBe("saved");

    expect(mocks.exportSubscribersCSV).toHaveBeenCalledWith({
      status: "enabled",
      q: "applied search",
      includeArchived: true,
      sort: "created_at",
      order: "asc",
    });
    expect(mocks.saveFile).toHaveBeenCalledWith({
      data: expect.any(Blob),
      suggestedName: "subscribers.csv",
      label: "Subscribers export",
      privacy: "personal",
      mimeType: "text/csv;charset=utf-8",
    });
    expect(mocks.toastInfo).toHaveBeenCalledWith({
      message: "Preparing the frozen subscriber export",
      detail: expect.stringContaining(
        "Applied query “applied search” · status enabled · active + archived · created_at asc · 24 matching · cap 10,000 · personal data · server-complete path",
      ),
      duration: 8_000,
    });
    expect(mocks.toastSuccess).toHaveBeenCalledWith(
      "Saved 24 rows from the complete applied view (including archived records).",
    );
  });

  it("blocks while visible search text is not the applied result", async () => {
    renderHook(state({ query: "new live text" }));

    await expect(runExport()).resolves.toBe("blocked");
    expect(mocks.exportSubscribersCSV).not.toHaveBeenCalled();
    expect(mocks.saveFile).not.toHaveBeenCalled();
    expect(mocks.toastInfo).toHaveBeenCalledWith(
      "Wait for the applied subscriber view to finish updating.",
    );
  });

  it("never substitutes a page-only file after server failure", async () => {
    mocks.exportSubscribersCSV.mockResolvedValue({
      error: { kind: "http", status: 503, message: "private upstream detail" },
    });
    renderHook();

    await expect(runExport()).resolves.toBe("failed");
    expect(mocks.saveFile).not.toHaveBeenCalled();
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
    expect(mocks.toastError).toHaveBeenCalledWith(
      "Couldn't prepare the complete applied subscriber export. No page-only fallback was saved.",
    );
    expect(JSON.stringify(mocks.toastError.mock.calls)).not.toContain(
      "private upstream detail",
    );
  });

  it("refuses to persist an export without a consistent server row receipt", async () => {
    mocks.exportSubscribersCSV.mockResolvedValue({
      data: {
        blob: new Blob(["unverifiable"], { type: "text/csv" }),
        filename: "subscribers.csv",
        truncated: true,
        exportedRows: null,
      },
    });
    renderHook();

    await expect(runExport()).resolves.toBe("failed");
    expect(mocks.saveFile).not.toHaveBeenCalled();
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
    expect(mocks.toastError).toHaveBeenCalledWith(
      "The server didn't return a consistent export row receipt. No unverifiable file was saved.",
    );
  });

  it("treats picker cancellation as neutral and save failure as failure", async () => {
    mocks.saveFile.mockResolvedValueOnce({
      ok: true,
      status: "cancelled",
      transferId: "cancelled-one",
    });
    renderHook();
    await expect(runExport()).resolves.toBe("cancelled");
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
    expect(mocks.toastError).not.toHaveBeenCalled();

    mocks.saveFile.mockResolvedValueOnce({
      ok: false,
      transferId: "failed-one",
      code: "write_failed",
      message: "Moosewave could not save the file.",
    });
    await expect(runExport()).resolves.toBe("failed");
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
    expect(mocks.toastError).toHaveBeenCalledWith(
      "Moosewave could not save the file.",
    );
  });

  it("reports browser handoff as started rather than persisted", async () => {
    mocks.saveFile.mockResolvedValue({
      ok: true,
      status: "download_started",
      transferId: "browser-download-one",
      collision: false,
    });
    renderHook();

    await expect(runExport()).resolves.toBe("started");
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
    expect(mocks.toastInfo).toHaveBeenCalledWith(
      "Download started for 24 rows from the complete applied view (including archived records). Check your browser's downloads for completion.",
    );
  });

  it("discloses capped output as partial rather than successful completion", async () => {
    mocks.exportSubscribersCSV.mockResolvedValue({
      data: {
        blob: new Blob(["partial"], { type: "text/csv" }),
        filename: "subscribers.csv",
        truncated: true,
        exportedRows: 10_000,
      },
    });
    renderHook(state({ showArchived: false }));

    await expect(runExport()).resolves.toBe("partial");
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
    expect(mocks.toastInfo).toHaveBeenCalledWith(
      "Partial export saved: 10,000 rows from the applied view (active records only). Refine the view to export the remainder.",
    );
  });

  it("single-flights generation and keeps busy through persistence", async () => {
    let resolveSave: ((value: unknown) => void) | null = null;
    mocks.saveFile.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSave = resolve;
        }),
    );
    const initial = renderHook();
    let first: Promise<SubscribersExportOutcome> | undefined;
    await act(async () => {
      first = initial.exportVisible();
      await Promise.resolve();
    });
    expect(container?.textContent).toBe("exporting");

    await expect(controller?.exportVisible()).resolves.toBe("busy");
    expect(mocks.exportSubscribersCSV).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveSave?.({
        ok: true,
        status: "saved",
        transferId: "saved-one",
        collision: false,
      });
      await first;
    });
    expect(container?.textContent).toBe("idle");
  });
});
