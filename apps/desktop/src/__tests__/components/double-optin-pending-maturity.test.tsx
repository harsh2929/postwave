// @vitest-environment happy-dom

import axe from "axe-core";
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

import { DoubleOptinPendingTable } from "../../components/privacy/DoubleOptinPendingTable";

const row = {
  id: "pending-confirmation-complete-id-123456789",
  email: "complete-pending-confirmation-address@example.test",
  sent_at: "2026-07-15T10:00:00.000Z",
  expires_at: "2026-09-13T10:00:00.000Z",
};

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listPending.mockResolvedValue({ data: { pending: [row] } });
  mocks.resend.mockResolvedValue({ data: {} });
  mocks.cancel.mockResolvedValue({ data: {} });
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
});

async function renderTable(): Promise<void> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(<DoubleOptinPendingTable />));
  await flush();
}

async function flush(): Promise<void> {
  await act(async () => {
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

describe("DoubleOptinPendingTable interaction maturity", () => {
  it("shows complete identifiers, absolute times, consequences, and no titles", async () => {
    await renderTable();
    expect(document.body.textContent).toContain(row.email);
    expect(document.body.textContent).toContain(row.id);
    expect(document.querySelectorAll("time")).toHaveLength(2);
    expect(document.body.textContent).toContain(
      "does not send another confirmation email",
    );
    expect(button("Extend 60 days").disabled).toBe(false);
    expect(container?.querySelector("[title]")).toBeNull();

    const result = await axe.run(container ?? document.body);
    expect(
      result.violations.filter(
        (violation) =>
          violation.impact === "critical" || violation.impact === "serious",
      ),
    ).toEqual([]);
  });

  it("single-flights extension and states that no email was sent", async () => {
    const pending = deferred<{ data: Record<string, never> }>();
    mocks.resend.mockReturnValue(pending.promise);
    await renderTable();
    const extend = button("Extend 60 days");
    act(() => {
      extend.click();
      extend.click();
    });
    expect(mocks.resend).toHaveBeenCalledTimes(1);
    expect(button("Extending…").disabled).toBe(false);
    expect(button("Extending…").getAttribute("aria-disabled")).toBe("true");
    expect(document.body.textContent).toContain("no email is being sent");

    await act(async () => {
      pending.resolve({ data: {} });
      await pending.promise;
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mocks.listPending).toHaveBeenCalledTimes(2);
    expect(mocks.toastSuccess).toHaveBeenCalledWith({
      message: `Extended ${row.email}'s confirmation deadline by 60 days.`,
      detail:
        "No confirmation email was sent. The existing pending token remains the confirmation path.",
    });
  });

  it("keeps failed cancellation open and discloses only safe diagnostics", async () => {
    mocks.cancel.mockResolvedValue({
      error: {
        kind: "network",
        code: "offline",
        requestId: "cancel-request-123",
        message: "private subscriber and database detail",
      },
    });
    await renderTable();
    act(() => button("Cancel").click());
    await act(async () => {
      button("Cancel confirmation").click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mocks.cancel).toHaveBeenCalledWith(row.id);
    expect(document.querySelector('[role="alertdialog"]')).not.toBeNull();
    expect(document.body.textContent).not.toContain("private subscriber");
    expect(mocks.toastError).toHaveBeenCalledWith({
      message: "The pending confirmation couldn't be cancelled.",
      detail:
        "The service could not be reached. Check the connection and retry. Reference: offline · cancel-request-123. No server change was confirmed.",
    });
  });

  it("single-flights same-tick refresh requests", async () => {
    const refresh = deferred<{ data: { pending: (typeof row)[] } }>();
    mocks.listPending.mockResolvedValueOnce({ data: { pending: [row] } });
    await renderTable();
    mocks.listPending.mockReturnValueOnce(refresh.promise);
    const refreshButton = button("Refresh");
    act(() => {
      refreshButton.click();
      refreshButton.click();
    });
    expect(mocks.listPending).toHaveBeenCalledTimes(2);
    await act(async () => {
      refresh.resolve({ data: { pending: [row] } });
      await refresh.promise;
    });
  });
});
