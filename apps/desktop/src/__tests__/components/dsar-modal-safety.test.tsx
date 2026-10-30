// @vitest-environment happy-dom

import { act, type ReactElement, StrictMode } from "react";
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
  createSarRequest: vi.fn(),
  getDsarExport: vi.fn(),
  listDsarStoreResponses: vi.fn(),
  saveFile: vi.fn(),
  toastError: vi.fn(),
  toastInfo: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("../../lib/api-client", () => ({
  api: {
    createSarRequest: mocks.createSarRequest,
    getDsarExport: mocks.getDsarExport,
    listDsarStoreResponses: mocks.listDsarStoreResponses,
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

import { DSARModal } from "../../components/subscribers/DSARModal";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
  document.body.style.overflow = "";
});

function render(node: ReactElement): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(<StrictMode>{node}</StrictMode>));
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function button(label: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
}

describe("DSARModal safety contract", () => {
  it("creates one explicit read-only access request under StrictMode", async () => {
    mocks.createSarRequest.mockResolvedValue({
      data: {
        id: "sar-access-1",
        kind: "access",
        subscriber_email: "ada@example.com",
        status: "ready",
        event_count: 4,
        consent_count: 2,
        bundle_bytes: 512,
        download_url: "/api/v1/sar/requests/sar-access-1.zip",
        store_responses: [
          {
            provider: "shopify",
            status: "returned",
            action_taken: "return_only",
            customer_id: "customer-1",
          },
        ],
      },
    });

    render(
      <DSARModal
        open
        operation="access"
        subscriberId="subscriber-1"
        email="ada@example.com"
        onClose={vi.fn()}
      />,
    );

    expect(button("Processing…")?.disabled).toBe(true);
    expect(document.body.textContent).not.toContain("Run in background");
    await flush();

    expect(mocks.createSarRequest).toHaveBeenCalledTimes(1);
    expect(mocks.createSarRequest).toHaveBeenCalledWith({
      kind: "access",
      email: "ada@example.com",
      fanout_enabled: true,
    });
    expect(document.body.textContent).toContain(
      "This access request is read-only",
    );
    expect(document.body.textContent).toContain(
      "Legacy provider auto-delete policies are ignored",
    );
    expect(button("Download Moosewave access export (.zip)")).toBeDefined();

    mocks.getDsarExport.mockResolvedValue({
      data: {
        blob: new Blob(["access-export"], { type: "application/zip" }),
        filename: "access-export.zip",
      },
    });
    mocks.saveFile.mockResolvedValue({
      ok: true,
      status: "download_started",
      transferId: "browser-access-export",
      collision: false,
    });
    act(() => button("Download Moosewave access export (.zip)")?.click());
    await flush();
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
    expect(mocks.toastInfo).toHaveBeenCalledWith(
      "Access export download started. Check your browser's downloads for completion.",
    );
  });

  it("creates a Moosewave-only erasure with no provider, background, or ZIP claim", async () => {
    mocks.createSarRequest.mockResolvedValue({
      data: {
        id: "sar-erase-1",
        kind: "erase",
        scope: "postwave",
        status: "ready",
        rows_deleted: 7,
        placeholder: "erased+hash@erased.invalid",
        external_stores_affected: 0,
      },
    });

    render(
      <DSARModal
        open
        operation="erase"
        subscriberId="subscriber-1"
        email="ada@example.com"
        onClose={vi.fn()}
      />,
    );
    await flush();

    expect(mocks.createSarRequest).toHaveBeenCalledTimes(1);
    expect(mocks.createSarRequest).toHaveBeenCalledWith({
      kind: "erase",
      email: "ada@example.com",
      fanout_enabled: false,
    });
    expect(document.body.textContent).toContain("Moosewave erasure completed");
    expect(document.body.textContent).toContain(
      "Connected commerce stores were not changed",
    );
    expect(document.body.textContent).toContain(
      "No subject-access ZIP was created",
    );
    expect(document.body.textContent).not.toContain("all systems");
    expect(document.body.textContent).not.toContain("Run in background");
    expect(button("Refresh")).toBeUndefined();
    expect(button("Download Moosewave access export (.zip)")).toBeUndefined();
  });

  it("fails closed when an access response reports a destructive provider action", async () => {
    mocks.createSarRequest.mockResolvedValue({
      data: {
        id: "sar-access-bad",
        kind: "access",
        subscriber_email: "ada@example.com",
        status: "ready",
        event_count: 0,
        consent_count: 0,
        bundle_bytes: 20,
        download_url: "/api/v1/sar/requests/sar-access-bad.zip",
        store_responses: [
          {
            provider: "shopify",
            status: "deleted",
            action_taken: "auto_delete",
          },
        ],
      },
    });

    render(
      <DSARModal
        open
        operation="access"
        subscriberId="subscriber-1"
        email="ada@example.com"
        onClose={vi.fn()}
      />,
    );
    await flush();

    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "destructive provider action for a read-only access request",
    );
    expect(button("Download Moosewave access export (.zip)")).toBeUndefined();
  });
});
