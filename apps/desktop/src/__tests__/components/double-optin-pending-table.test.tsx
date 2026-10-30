// @vitest-environment happy-dom

import { act } from "react";
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

import { DoubleOptinPendingTable } from "../../components/privacy/DoubleOptinPendingTable";

const mocks = vi.hoisted(() => ({
  listPending: vi.fn(),
  resend: vi.fn(),
  cancel: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("../../lib/api-client", () => ({
  api: {
    privacyPortal: {
      doubleOptin: {
        listPending: mocks.listPending,
        resend: mocks.resend,
        cancel: mocks.cancel,
      },
    },
  },
}));

vi.mock("../../components/Toast", () => ({
  toast: {
    error: mocks.toastError,
    success: mocks.toastSuccess,
  },
}));

vi.mock("../../components/ConfirmModal", () => ({
  ConfirmModal: () => null,
}));

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
  mocks.listPending.mockReset();
  mocks.resend.mockReset();
  mocks.cancel.mockReset();
  mocks.toastError.mockReset();
  mocks.toastSuccess.mockReset();
});

afterEach(() => {
  if (root) {
    const current = root;
    act(() => current.unmount());
  }
  root = null;
  container?.remove();
  container = null;
});

async function renderTable(): Promise<void> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(<DoubleOptinPendingTable />);
    await Promise.resolve();
    await Promise.resolve();
  });
}

const PENDING_ROW = {
  id: "doi-1",
  email: "reader@example.test",
  sent_at: "2026-07-15T10:00:00Z",
  expires_at: "2026-09-13T10:00:00Z",
};

describe("double opt-in pending table remote-state truth", () => {
  it("retains verified rows when a refresh fails and presents the failure separately", async () => {
    mocks.listPending
      .mockResolvedValueOnce({
        data: { pending: [PENDING_ROW] },
        error: null,
      })
      .mockResolvedValueOnce({
        data: null,
        error: { message: "Service unavailable" },
      });
    await renderTable();
    expect(document.body.textContent).toContain("reader@example.test");
    expect(document.querySelector("caption")?.textContent).toBe(
      "Double opt-in · pending",
    );

    const refresh = Array.from(document.querySelectorAll("button")).find(
      (button) => button.textContent === "Refresh",
    )!;
    await act(async () => {
      refresh.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "Showing last verified pending confirmations",
    );
    expect(document.body.textContent).not.toContain("Service unavailable");
    expect(document.body.textContent).toContain("reader@example.test");
    expect(document.body.textContent).not.toContain(
      "No pending confirmations.",
    );
  });

  it("does not convert a thrown initial request into a successful empty state", async () => {
    mocks.listPending.mockRejectedValueOnce(new Error("network down"));
    await renderTable();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "Couldn’t verify pending confirmations",
    );
    expect(document.body.textContent).toContain(
      "The service could not be reached. Check the connection and retry.",
    );
    expect(document.body.textContent).not.toContain("network down");
    expect(document.body.textContent).toContain(
      "Pending confirmations are unavailable. Retry to load them.",
    );
    expect(document.body.textContent).not.toContain(
      "No pending confirmations.",
    );
  });
});
