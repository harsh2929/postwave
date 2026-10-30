// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  isTauri: vi.fn(),
  openDialog: vi.fn(),
  saveDialog: vi.fn(),
  readFile: vi.fn(),
  stat: vi.fn(),
  openUrl: vi.fn(),
  anchorClick: vi.fn(),
  createObjectUrl: vi.fn(),
  revokeObjectUrl: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: mocks.openDialog,
  save: mocks.saveDialog,
}));
vi.mock("@tauri-apps/plugin-fs", () => ({
  readFile: mocks.readFile,
  stat: mocks.stat,
}));
vi.mock("../../lib/tauri", () => ({
  isTauri: mocks.isTauri,
  tauriApi: { openUrl: mocks.openUrl },
}));

import {
  downloadUrlToFile,
  pickFileMetadata,
  pickImportFiles,
  sanitizeSuggestedFilename,
  saveFile,
  validateImportFiles,
} from "../../lib/file-transfer";
import {
  configureTransferHistoryIdentity,
  getTransferHistory,
  resetTransferHistoryForTests,
  subscribeTransferHistory,
} from "../../lib/file-transfer-history";
import type { ImportPolicy } from "../../lib/file-transfer-types";
import { resetLifecycleCoordinatorForTests } from "../../lib/lifecycle-coordinator";
import { purgePrivateSessionState } from "../../lib/private-session-state";

const CSV_POLICY: ImportPolicy = {
  label: "test CSV",
  privacy: "confidential",
  extensions: ["csv"],
  maxBytes: 1024,
};
const MACOS_TEST_HOME = ["", "Users", "test"].join("/");
const TRANSFER_HISTORY_PREFIX = "postwave.desktop.transfer-history.v2:";

function transferHistoryKeys(): string[] {
  return Array.from({ length: localStorage.length }, (_, index) =>
    localStorage.key(index),
  ).filter(
    (key): key is string => key?.startsWith(TRANSFER_HISTORY_PREFIX) === true,
  );
}

beforeEach(() => {
  resetLifecycleCoordinatorForTests();
  resetTransferHistoryForTests();
  localStorage.clear();
  configureTransferHistoryIdentity("user-a", "tenant-a");
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.isTauri.mockReturnValue(false);
  mocks.openUrl.mockResolvedValue(undefined);
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    value: mocks.createObjectUrl,
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    value: mocks.revokeObjectUrl,
  });
  mocks.createObjectUrl.mockReturnValue("blob:postwave-transfer");
  Object.defineProperty(HTMLAnchorElement.prototype, "click", {
    configurable: true,
    value: mocks.anchorClick,
  });
});

afterEach(() => {
  resetLifecycleCoordinatorForTests();
  resetTransferHistoryForTests();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("file transfer service", () => {
  it("normalizes unsafe suggested names without retaining a path", () => {
    expect(sanitizeSuggestedFilename("../../Quarter:One?.csv")).toBe(
      "Quarter_One_.csv",
    );
    expect(sanitizeSuggestedFilename("CON.csv")).toBe("_CON.csv");
    expect(sanitizeSuggestedFilename(".."))?.toBeNull();
  });

  it("validates extension, empty, per-file, and aggregate limits", () => {
    expect(
      validateImportFiles(
        [new File(["a"], "subscribers.exe", { type: "text/csv" })],
        CSV_POLICY,
      ),
    ).toMatchObject({ ok: false, code: "invalid_type" });
    expect(
      validateImportFiles([new File([], "empty.csv")], CSV_POLICY),
    ).toMatchObject({ ok: false, code: "empty_file" });
    expect(
      validateImportFiles(
        [new File([new Uint8Array(1025)], "large.csv")],
        CSV_POLICY,
      ),
    ).toMatchObject({ ok: false, code: "file_too_large" });
    expect(
      validateImportFiles([new File(["x"], "report\u202Egpj.csv")], CSV_POLICY),
    ).toMatchObject({ ok: false, code: "invalid_name" });
  });

  it("uses one browser download path and redacts confidential history", async () => {
    const result = await saveFile({
      data: "email\na@example.test",
      suggestedName: "/private/acme-subscribers.csv",
      label: "Acme subscribers export",
      privacy: "confidential",
      mimeType: "text/csv",
    });

    expect(result).toMatchObject({ ok: true, status: "download_started" });
    expect(mocks.anchorClick).toHaveBeenCalledTimes(1);
    expect(mocks.createObjectUrl).toHaveBeenCalledTimes(1);
    expect(document.querySelector("a[download]")).toBeNull();
    const record = getTransferHistory()[0];
    expect(record?.status).toBe("completed");
    expect(record?.fileName).toContain("Confidential file");
    expect(JSON.stringify(record)).not.toContain("acme-subscribers");
    expect(JSON.stringify(record)).not.toContain("Acme");
    expect(JSON.stringify(record)).not.toContain("/private");
  });

  it("removes the temporary anchor and revokes its object URL", async () => {
    vi.useFakeTimers();
    try {
      await saveFile({
        data: "email\na@example.test",
        suggestedName: "subscribers.csv",
        label: "Subscribers export",
        privacy: "personal",
        mimeType: "text/csv",
      });

      expect(document.querySelector("a[download]")).toBeNull();
      expect(mocks.revokeObjectUrl).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(mocks.revokeObjectUrl).toHaveBeenCalledTimes(1);
      expect(mocks.revokeObjectUrl).toHaveBeenCalledWith(
        "blob:postwave-transfer",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears transfer history at a private identity boundary", async () => {
    await saveFile({
      data: "public report",
      suggestedName: "report.txt",
      label: "Public report",
      privacy: "public",
    });

    expect(getTransferHistory()).toHaveLength(1);
    expect(transferHistoryKeys()).toHaveLength(1);
    expect(transferHistoryKeys()[0]).not.toContain("user-a");
    expect(transferHistoryKeys()[0]).not.toContain("tenant-a");

    purgePrivateSessionState();

    expect(getTransferHistory()).toEqual([]);
    expect(transferHistoryKeys()).toEqual([]);
  });

  it("restores only the matching identity and purges foreign or legacy history", async () => {
    localStorage.setItem(
      "postwave.desktop.transfer-history.v1",
      JSON.stringify([{ fileName: "legacy-customer.csv" }]),
    );
    await saveFile({
      data: "public report",
      suggestedName: "report.txt",
      label: "Public report",
      privacy: "public",
    });
    const firstKey = transferHistoryKeys()[0];
    expect(firstKey).toBeDefined();

    configureTransferHistoryIdentity(null, null);
    expect(getTransferHistory()).toEqual([]);
    expect(transferHistoryKeys()).toEqual([firstKey]);

    configureTransferHistoryIdentity("user-a", "tenant-a");
    expect(getTransferHistory()).toHaveLength(1);
    expect(getTransferHistory()[0]?.fileName).toBe("report.txt");
    expect(
      localStorage.getItem("postwave.desktop.transfer-history.v1"),
    ).toBeNull();

    configureTransferHistoryIdentity("user-b", "tenant-a");
    expect(getTransferHistory()).toEqual([]);
    expect(transferHistoryKeys()).toEqual([]);
  });

  it("removes oversized persisted history before parsing it", async () => {
    await saveFile({
      data: "public report",
      suggestedName: "report.txt",
      label: "Public report",
      privacy: "public",
    });
    const key = transferHistoryKeys()[0];
    expect(key).toBeDefined();
    configureTransferHistoryIdentity(null, null);
    localStorage.setItem(key!, `[` + "x".repeat(129 * 1024));

    configureTransferHistoryIdentity("user-a", "tenant-a");

    expect(getTransferHistory()).toEqual([]);
    expect(localStorage.getItem(key!)).toBeNull();
  });

  it("isolates transfer-history subscribers from one another", async () => {
    const healthySubscriber = vi.fn();
    const removeFaulty = subscribeTransferHistory(() => {
      throw new Error("detached transfer center");
    });
    const removeHealthy = subscribeTransferHistory(healthySubscriber);

    await expect(
      saveFile({
        data: "public report",
        suggestedName: "report.txt",
        label: "Public report",
        privacy: "public",
      }),
    ).resolves.toMatchObject({ ok: true });
    expect(healthySubscriber).toHaveBeenCalled();

    removeFaulty();
    removeHealthy();
  });

  it("streams bounded chunks to a picker-granted native atomic save", async () => {
    const reportPath = `${MACOS_TEST_HOME}/report.csv`;
    mocks.isTauri.mockReturnValue(true);
    mocks.saveDialog.mockResolvedValue(reportPath);
    let written = 0;
    mocks.invoke.mockImplementation(
      (command: string, args: Record<string, unknown>) => {
        if (command === "transfer_begin_save") {
          expect(args).toEqual({
            request: {
              targetPath: reportPath,
              expectedBytes: 700_000,
            },
          });
          return Promise.resolve({ transferId: "native-1", collision: true });
        }
        if (command === "transfer_write_chunk") {
          const chunk = args.chunk as number[];
          expect(chunk.length).toBeLessThanOrEqual(256 * 1024);
          expect(args.offset).toBe(written);
          written += chunk.length;
          return Promise.resolve({
            writtenBytes: written,
            expectedBytes: 700_000,
          });
        }
        return Promise.resolve(undefined);
      },
    );

    const result = await saveFile({
      data: new Uint8Array(700_000),
      suggestedName: "report.csv",
      label: "Large report",
      privacy: "public",
    });

    expect(result).toMatchObject({
      ok: true,
      status: "saved",
      collision: true,
    });
    expect(written).toBe(700_000);
    expect(mocks.invoke).toHaveBeenCalledWith("transfer_finish_save", {
      transferId: "native-1",
    });
    expect(JSON.stringify(getTransferHistory())).not.toContain(MACOS_TEST_HOME);
  });

  it("uses exact native picker scope for read/stat and never retains the path", async () => {
    const listPath = `${MACOS_TEST_HOME}/private/list.csv`;
    mocks.isTauri.mockReturnValue(true);
    mocks.openDialog.mockResolvedValue(listPath);
    mocks.stat.mockResolvedValue({ size: 4 });
    mocks.readFile.mockResolvedValue(new Uint8Array([97, 44, 98, 10]));

    const picked = await pickImportFiles(CSV_POLICY);

    expect(picked.ok && picked.files[0]?.name).toBe("list.csv");
    expect(mocks.stat).toHaveBeenCalledWith(listPath);
    expect(mocks.readFile).toHaveBeenCalledWith(listPath);
    expect(mocks.invoke).toHaveBeenCalledWith("transfer_revoke_picker_path", {
      path: listPath,
    });
    expect(JSON.stringify(getTransferHistory())).not.toContain(MACOS_TEST_HOME);
  });

  it("can inspect picker metadata without reading file bytes", async () => {
    const archivePath = `${MACOS_TEST_HOME}/archive.zip`;
    mocks.isTauri.mockReturnValue(true);
    mocks.openDialog.mockResolvedValue(archivePath);
    mocks.stat.mockResolvedValue({ size: 42_000 });
    const result = await pickFileMetadata({
      label: "attachment metadata",
      privacy: "confidential",
      extensions: [],
      maxBytes: 100_000,
    });
    expect(result).toMatchObject({
      ok: true,
      file: { name: "archive.zip", size: 42_000 },
    });
    expect(mocks.readFile).not.toHaveBeenCalled();
    expect(mocks.invoke).toHaveBeenCalledWith("transfer_revoke_picker_path", {
      path: archivePath,
    });
  });

  it("downloads with no referrer, tracks progress, and then saves", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(new Uint8Array([1, 2, 3, 4]), {
        status: 200,
        headers: {
          "content-length": "4",
          "content-type": "application/zip",
          "content-disposition": "attachment; filename=workspace.zip",
          "x-postwave-export-limit": "10000",
          "x-postwave-truncated": "true",
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const progress = vi.fn(() => {
      throw new TypeError("broken progress observer");
    });

    const result = await downloadUrlToFile({
      url: "https://api.example.test/export?token=secret",
      suggestedName: "fallback.zip",
      label: "Workspace export",
      privacy: "confidential",
      onProgress: progress,
      captureResponseHeaders: [
        "X-Postwave-Truncated",
        "x-postwave-export-limit",
        "invalid header name",
      ],
    });

    expect(result.ok).toBe(true);
    expect(result.responseHeaders).toEqual({
      "x-postwave-export-limit": "10000",
      "x-postwave-truncated": "true",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.example.test/export?token=secret",
      expect.objectContaining({
        credentials: "omit",
        cache: "no-store",
        referrerPolicy: "no-referrer",
      }),
    );
    expect(progress).toHaveBeenCalled();
    expect(mocks.openUrl).not.toHaveBeenCalled();
    expect(JSON.stringify(getTransferHistory())).not.toContain("token=secret");
  });
});
