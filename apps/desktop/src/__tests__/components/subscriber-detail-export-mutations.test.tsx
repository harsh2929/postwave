// @vitest-environment happy-dom

import { act, type ReactElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  downloadData: vi.fn(),
  downloadConsent: vi.fn(),
  reconfirmJurisdiction: vi.fn(),
  saveFile: vi.fn(),
  onChange: vi.fn(),
  reloadDetail: vi.fn(),
  toastError: vi.fn(),
  toastInfo: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("../../lib/api-client", () => ({
  api: {
    downloadSubscriberDataExport: mocks.downloadData,
    downloadSubscriberConsentReceipt: mocks.downloadConsent,
    reconfirmSubscriberJurisdiction: mocks.reconfirmJurisdiction,
  },
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
  useSubscriberDetailMutations,
  type SubscriberDetailMutationController,
} from "../../components/subscribers/useSubscriberDetailMutations";
import type { SubscriberDetail } from "../../lib/api-client";

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let controller: SubscriberDetailMutationController | null = null;

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function Probe(): ReactElement {
  const [detail, setDetail] = useState<SubscriberDetail>({
    id: "subscriber-7",
    version: '"subscriber:subscriber-7:v1"',
    email: "private@example.test",
    status: "enabled",
  });
  controller = useSubscriberDetailMutations({
    id: detail.id,
    detail,
    setDetail,
    onClose: vi.fn(),
    onChange: mocks.onChange,
    canMutate: true,
    canAdmin: true,
    reloadDetail: mocks.reloadDetail,
  });
  return <span>{controller.dsarBusy ? "busy" : "idle"}</span>;
}

function renderHook(): SubscriberDetailMutationController {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(<Probe />));
  if (!controller) throw new Error("mutation hook did not render");
  return controller;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.downloadData.mockResolvedValue({
    data: {
      blob: new Blob(["data-export"], { type: "application/zip" }),
      filename: "subscriber-data.zip",
    },
  });
  mocks.downloadConsent.mockResolvedValue({
    data: {
      blob: new Blob(["consent-receipt"], { type: "application/zip" }),
      filename: "consent-receipt.zip",
      consentReceiptId: "receipt-one",
    },
  });
  mocks.saveFile.mockResolvedValue({
    ok: true,
    status: "saved",
    transferId: "transfer-one",
    collision: false,
  });
  mocks.reconfirmJurisdiction.mockResolvedValue({
    data: {
      id: "subscriber-7",
      email: "private@example.test",
      status: "enabled",
      version: '"subscriber:subscriber-7:v2"',
      jurisdiction_reconfirm_required: false,
    },
  });
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  controller = null;
});

describe("subscriber detail confidential exports", () => {
  it("drops a late export result after the detail owner unmounts", async () => {
    const download = deferred<{
      data: { blob: Blob; filename: string };
    }>();
    mocks.downloadData.mockReturnValueOnce(download.promise);
    const current = renderHook();
    let operation: Promise<void> | undefined;
    await act(async () => {
      operation = current.exportDsar();
      await Promise.resolve();
    });

    act(() => root?.unmount());
    root = null;
    download.resolve({
      data: {
        blob: new Blob(["late"]),
        filename: "late-export.zip",
      },
    });
    await operation;

    expect(mocks.saveFile).not.toHaveBeenCalled();
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
    expect(mocks.toastInfo).not.toHaveBeenCalled();
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it("keeps busy through native persistence and treats cancellation as neutral", async () => {
    let resolveSave: ((value: unknown) => void) | null = null;
    mocks.saveFile.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSave = resolve;
        }),
    );
    const initial = renderHook();
    let operation: Promise<void> | undefined;
    await act(async () => {
      operation = initial.exportDsar();
      await Promise.resolve();
    });

    expect(container?.textContent).toBe("busy");
    expect(mocks.downloadData).toHaveBeenCalledWith("subscriber-7");
    expect(mocks.saveFile).toHaveBeenCalledWith({
      data: expect.any(Blob),
      suggestedName: "subscriber-data.zip",
      label: "Subscriber data export",
      privacy: "confidential",
      mimeType: "application/zip",
    });

    await act(async () => {
      resolveSave?.({
        ok: true,
        status: "cancelled",
        transferId: "cancelled-one",
      });
      await operation;
    });
    expect(container?.textContent).toBe("idle");
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it("does not expose the release-held portable consent receipt transport", () => {
    const current = renderHook();

    expect("exportConsentReceipt" in current).toBe(false);
    expect(mocks.downloadConsent).not.toHaveBeenCalled();
  });

  it("describes browser handoff as started rather than saved", async () => {
    mocks.saveFile.mockResolvedValue({
      ok: true,
      status: "download_started",
      transferId: "browser-one",
      collision: false,
    });
    renderHook();
    await act(async () => controller?.exportDsar());

    expect(mocks.toastSuccess).not.toHaveBeenCalled();
    expect(mocks.toastInfo).toHaveBeenCalledWith(
      "Subscriber data export download started. Check your browser's downloads for completion.",
    );
  });

  it("reports generation and write failures without false success", async () => {
    mocks.downloadData.mockResolvedValueOnce({
      error: { kind: "http", status: 503, message: "private backend detail" },
    });
    renderHook();
    await act(async () => controller?.exportDsar());
    expect(mocks.saveFile).not.toHaveBeenCalled();
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
    expect(mocks.toastError).toHaveBeenCalledWith(
      "Couldn't prepare the subscriber data export. Try again.",
    );
    expect(JSON.stringify(mocks.toastError.mock.calls)).not.toContain(
      "private backend detail",
    );

    mocks.toastError.mockClear();
    mocks.saveFile.mockResolvedValueOnce({
      ok: false,
      transferId: "failed-one",
      code: "write_failed",
      message: "Moosewave could not save the file.",
    });
    await act(async () => controller?.exportDsar());
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
    expect(mocks.toastError).toHaveBeenCalledWith(
      "Moosewave could not save the file.",
    );
  });
});

describe("subscriber jurisdiction evidence mutations", () => {
  it("adopts the authoritative subscriber and fresh revision after evidence commits", async () => {
    const current = renderHook();
    const evidence = {
      decision: "declined" as const,
      regime: "gdpr" as const,
      privacy_policy_version: "privacy-2026-07-19",
      captured_text: "I decline marketing email.",
      expected_jurisdiction_changed_at: "2026-07-19T12:34:56.123456Z",
      expected_subscriber_version: '"subscriber:subscriber-7:v1"',
    };

    await act(async () => current.reconfirmJurisdiction(evidence));

    expect(mocks.reconfirmJurisdiction).toHaveBeenCalledWith(
      "subscriber-7",
      evidence,
    );
    expect(mocks.onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "subscriber-7",
        version: '"subscriber:subscriber-7:v2"',
        jurisdiction_reconfirm_required: false,
      }),
    );
    expect(mocks.toastSuccess).toHaveBeenCalledWith(
      "Subject decline recorded and email consent removed.",
    );
  });

  it("serializes same-tick submissions and reloads authoritative state on conflict", async () => {
    let resolveRequest:
      | ((value: {
          error: { kind: "http"; status: number; message: string };
        }) => void)
      | null = null;
    mocks.reconfirmJurisdiction.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRequest = resolve;
        }),
    );
    const current = renderHook();
    const evidence = {
      decision: "accepted" as const,
      regime: "law25" as const,
      privacy_policy_version: "privacy-2026-07-19",
      captured_text: "I agree to receive marketing email.",
      expected_jurisdiction_changed_at: "2026-07-19T12:34:56.123456Z",
      expected_subscriber_version: '"subscriber:subscriber-7:v1"',
    };

    let first: Promise<void> | undefined;
    let second: Promise<void> | undefined;
    await act(async () => {
      first = current.reconfirmJurisdiction(evidence);
      second = current.reconfirmJurisdiction(evidence);
      await Promise.resolve();
    });

    expect(mocks.reconfirmJurisdiction).toHaveBeenCalledTimes(1);
    expect(mocks.reconfirmJurisdiction).toHaveBeenCalledWith(
      "subscriber-7",
      evidence,
    );

    await act(async () => {
      resolveRequest?.({
        error: {
          kind: "http",
          status: 409,
          message:
            "The jurisdiction decision changed. Review the latest record.",
        },
      });
      await Promise.all([first, second]);
    });

    expect(mocks.reloadDetail).toHaveBeenCalledTimes(1);
    expect(mocks.onChange).not.toHaveBeenCalled();
    expect(mocks.toastError).toHaveBeenCalledWith(
      "Couldn't record decision: The jurisdiction decision changed. Review the latest record.",
    );
  });
});
