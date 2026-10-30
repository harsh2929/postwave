// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom

import { act, createElement, useRef, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  QueryClient,
  QueryClientProvider,
  type QueryKey,
} from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ExpiryDialog,
  HistoryDialog,
  suppressionExpiryError,
  suppressionExpiryMinDate,
} from "@/app/(dashboard)/app/suppressions/page-client";
import type * as SuppressionsApi from "@/lib/suppressions-admin-api";
import type { SuppressionEntry } from "@/lib/suppressions-admin-api";

const mocks = vi.hoisted(() => ({
  listSuppressionAudit: vi.fn(),
  patchSuppressionExpiry: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("@/lib/suppressions-admin-api", async (importOriginal) => {
  const actual = await importOriginal<typeof SuppressionsApi>();
  return {
    ...actual,
    listSuppressionAudit: mocks.listSuppressionAudit,
    patchSuppressionExpiry: mocks.patchSuppressionExpiry,
  };
});

vi.mock("sonner", () => ({
  toast: {
    error: mocks.toastError,
    success: mocks.toastSuccess,
    warning: vi.fn(),
  },
}));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const entry: SuppressionEntry = {
  id: "suppression_1",
  email: "very.long.blocked.address@example.test",
  reason: "list_manual",
  source: "operator",
  created_at: "2026-08-20T00:00:00.000Z",
  expires_at: "2030-01-01T00:00:00.000Z",
};

function render(ui: ReactNode): {
  client: QueryClient;
  container: HTMLDivElement;
  root: Root;
} {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => {
    root.render(createElement(QueryClientProvider, { client }, ui));
  });
  return { client, container, root };
}

function button(text: string): HTMLButtonElement {
  const result = Array.from(document.querySelectorAll("button")).find(
    (candidate): candidate is HTMLButtonElement =>
      candidate instanceof HTMLButtonElement &&
      candidate.textContent?.trim() === text,
  );
  if (!result) throw new Error(`Button not found: ${text}`);
  return result;
}

function dateInput(): HTMLInputElement {
  const result = document.querySelector<HTMLInputElement>("#expiry-date");
  if (!result) throw new Error("Expiry date input not found");
  return result;
}

function changeInput(input: HTMLInputElement, value: string): void {
  const setValue = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )?.set;
  setValue?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

async function settleDialogFocus(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
  await act(async () => {
    await new Promise((resolvePromise) => window.setTimeout(resolvePromise, 0));
    await new Promise((resolvePromise) =>
      window.requestAnimationFrame(resolvePromise),
    );
  });
}

function HistoryFocusHarness({ onClose }: { onClose: () => void }) {
  const returnFocusRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(true);
  return (
    <>
      <button ref={returnFocusRef} type="button">
        Open history
      </button>
      {open ? (
        <HistoryDialog
          entry={entry}
          queryKeyBase={["suppressions", "focus-history"]}
          returnFocusRef={returnFocusRef}
          onClose={() => {
            onClose();
            setOpen(false);
          }}
        />
      ) : null}
    </>
  );
}

function ExpiryFocusHarness({
  onClose,
  onDone,
}: {
  onClose: () => void;
  onDone: () => void;
}) {
  const returnFocusRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(true);
  return (
    <>
      <button ref={returnFocusRef} type="button">
        Open expiry
      </button>
      {open ? (
        <ExpiryDialog
          entry={entry}
          returnFocusRef={returnFocusRef}
          onClose={() => {
            onClose();
            setOpen(false);
          }}
          onDone={() => {
            onDone();
            setOpen(false);
          }}
        />
      ) : null}
    </>
  );
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
        await new Promise((resolvePromise) =>
          window.setTimeout(resolvePromise, 0),
        );
      });
    }
  }
  throw lastError;
}

afterEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = "";
});

describe("suppression expiry validation", () => {
  it("uses the local next calendar day and rejects malformed, impossible, and non-future dates", () => {
    const now = new Date(2026, 11, 31, 23, 59, 0);
    expect(suppressionExpiryMinDate(now)).toBe("2027-01-01");
    expect(suppressionExpiryError("", now)).toBeNull();
    expect(suppressionExpiryError("2027-02-30", now)).toMatch(/valid/i);
    expect(suppressionExpiryError("2026-12-31", now)).toMatch(/future/i);
    expect(suppressionExpiryError("2027-01-01", now)).toBeNull();
  });
});

describe("suppression expiry dialog", () => {
  it("validates inline, submits one exact ISO update, and locks every exit while pending", async () => {
    let resolvePatch: (() => void) | undefined;
    mocks.patchSuppressionExpiry.mockImplementationOnce(
      () =>
        new Promise((resolvePromise) => {
          resolvePatch = () => resolvePromise({ ...entry });
        }),
    );
    const onClose = vi.fn();
    const onDone = vi.fn();
    const { client, root } = render(
      createElement(ExpiryDialog, { entry, onClose, onDone }),
    );
    try {
      expect(button("Save expiry").disabled).toBe(true);
      await act(async () => changeInput(dateInput(), "2020-01-01"));
      expect(document.querySelector('[role="alert"]')?.textContent).toMatch(
        /future/i,
      );
      expect(button("Save expiry").disabled).toBe(true);

      await act(async () => changeInput(dateInput(), "2031-02-03"));
      const save = button("Save expiry");
      await act(async () => {
        save.click();
        save.click();
      });
      expect(mocks.patchSuppressionExpiry).toHaveBeenCalledTimes(1);
      expect(mocks.patchSuppressionExpiry).toHaveBeenCalledWith(
        "suppression_1",
        "2031-02-03T00:00:00.000Z",
      );
      expect(
        document.querySelector('[role="dialog"]')?.getAttribute("aria-busy"),
      ).toBe("true");
      expect(button("Cancel").disabled).toBe(true);
      expect(button("Make permanent").disabled).toBe(true);

      await act(async () => {
        document.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "Escape",
            bubbles: true,
            cancelable: true,
          }),
        );
      });
      expect(onClose).not.toHaveBeenCalled();

      await act(async () => resolvePatch?.());
      await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
      expect(mocks.toastSuccess).toHaveBeenCalledWith("Expiry updated.");
    } finally {
      act(() => root.unmount());
      client.clear();
    }
  });

  it("keeps a failed request open for retry and sends explicit null for a permanent hold", async () => {
    mocks.patchSuppressionExpiry
      .mockRejectedValueOnce(new Error("Expiry service unavailable"))
      .mockResolvedValueOnce({ ...entry, expires_at: null });
    const onDone = vi.fn();
    const { client, root } = render(
      createElement(ExpiryDialog, {
        entry,
        onClose: vi.fn(),
        onDone,
      }),
    );
    try {
      await act(async () => button("Make permanent").click());
      await waitFor(() => {
        expect(document.querySelector('[role="alert"]')?.textContent).toContain(
          "Expiry service unavailable",
        );
      });
      expect(document.querySelector('[role="dialog"]')).not.toBeNull();
      expect(onDone).not.toHaveBeenCalled();

      await act(async () => button("Make permanent").click());
      await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
      expect(mocks.patchSuppressionExpiry).toHaveBeenNthCalledWith(
        2,
        "suppression_1",
        null,
      );
    } finally {
      act(() => root.unmount());
      client.clear();
    }
  });

  it("does not offer a no-op permanent write for an already permanent row", () => {
    const { client, root } = render(
      createElement(ExpiryDialog, {
        entry: { ...entry, expires_at: null },
        onClose: vi.fn(),
        onDone: vi.fn(),
      }),
    );
    try {
      expect(button("Make permanent").disabled).toBe(true);
      expect(mocks.patchSuppressionExpiry).not.toHaveBeenCalled();
    } finally {
      act(() => root.unmount());
      client.clear();
    }
  });

  it("returns focus to the provided trigger when Cancel closes without a mutation", async () => {
    const onClose = vi.fn();
    const onDone = vi.fn();
    const { client, container, root } = render(
      <ExpiryFocusHarness onClose={onClose} onDone={onDone} />,
    );
    try {
      const trigger = button("Open expiry");
      const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
      expect(dialog?.contains(document.activeElement)).toBe(true);
      expect(document.activeElement).not.toBe(trigger);

      await act(async () => {
        button("Cancel").click();
        await Promise.resolve();
      });
      await settleDialogFocus();

      expect(document.querySelector('[role="dialog"]')).toBeNull();
      expect(document.activeElement).toBe(trigger);
      expect(container.contains(trigger)).toBe(true);
      expect(onClose).toHaveBeenCalledTimes(1);
      expect(onDone).not.toHaveBeenCalled();
      expect(mocks.patchSuppressionExpiry).not.toHaveBeenCalled();
    } finally {
      act(() => root.unmount());
      client.clear();
    }
  });

  it("returns focus after one successful expiry mutation even when Save is activated twice", async () => {
    mocks.patchSuppressionExpiry.mockResolvedValue({
      ...entry,
      expires_at: "2031-02-03T00:00:00.000Z",
    });
    const onClose = vi.fn();
    const onDone = vi.fn();
    const { client, container, root } = render(
      <ExpiryFocusHarness onClose={onClose} onDone={onDone} />,
    );
    try {
      const trigger = button("Open expiry");
      await act(async () => changeInput(dateInput(), "2031-02-03"));
      await act(async () => {
        const save = button("Save expiry");
        save.click();
        save.click();
        await Promise.resolve();
      });
      await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
      await settleDialogFocus();

      expect(document.querySelector('[role="dialog"]')).toBeNull();
      expect(document.activeElement).toBe(trigger);
      expect(container.contains(trigger)).toBe(true);
      expect(mocks.patchSuppressionExpiry).toHaveBeenCalledTimes(1);
      expect(mocks.patchSuppressionExpiry).toHaveBeenCalledWith(
        entry.id,
        "2031-02-03T00:00:00.000Z",
      );
      expect(onClose).not.toHaveBeenCalled();
    } finally {
      act(() => root.unmount());
      client.clear();
    }
  });
});

describe("suppression history dialog", () => {
  it("uses a tenant-scoped key and exposes long successful history as a keyboard region", async () => {
    mocks.listSuppressionAudit.mockResolvedValue([
      {
        id: "audit_1",
        action: "expiry_updated",
        reason: "list_manual",
        source: "a-very-long-operator-source-that-must-wrap-without-overflow",
        actor: "operator.with.a.very.long.identifier@example.test",
        created_at: "2026-08-25T00:00:00.000Z",
      },
    ]);
    const queryKeyBase = ["suppressions", "tenant_1", "admin"] as const;
    const { client, root } = render(
      createElement(HistoryDialog, {
        entry,
        queryKeyBase,
        onClose: vi.fn(),
      }),
    );
    try {
      expect(document.querySelector('[role="status"]')).not.toBeNull();
      await waitFor(() => {
        expect(document.body.textContent).toContain("expiry updated");
      });
      expect(mocks.listSuppressionAudit).toHaveBeenCalledWith(entry.email);
      const expectedKey: QueryKey = [...queryKeyBase, "audit", entry.email];
      expect(client.getQueryState(expectedKey)?.status).toBe("success");
      const region = document.querySelector<HTMLElement>('[role="region"]');
      expect(region?.tabIndex).toBe(0);
      expect(region?.getAttribute("aria-label")).toContain(entry.email);
      expect(region?.querySelector(".break-words")).not.toBeNull();
    } finally {
      act(() => root.unmount());
      client.clear();
    }
  });

  it("distinguishes request failure from empty history and retries deterministically", async () => {
    mocks.listSuppressionAudit
      .mockRejectedValueOnce(new Error("audit unavailable"))
      .mockResolvedValueOnce([]);
    const { client, root } = render(
      createElement(HistoryDialog, {
        entry,
        queryKeyBase: ["suppressions", "tenant_2", "viewer"],
        onClose: vi.fn(),
      }),
    );
    try {
      await waitFor(() => {
        expect(document.querySelector('[role="alert"]')?.textContent).toContain(
          "not an empty audit trail",
        );
      });
      expect(document.body.textContent).not.toContain(
        "No audit events recorded",
      );

      await act(async () => button("Retry").click());
      await waitFor(() => {
        expect(document.body.textContent).toContain(
          "No audit events recorded for this address yet",
        );
      });
      expect(mocks.listSuppressionAudit).toHaveBeenCalledTimes(2);
    } finally {
      act(() => root.unmount());
      client.clear();
    }
  });

  it.each(["Close", "Escape"] as const)(
    "returns focus to the provided trigger after %s without duplicate close work",
    async (closeMethod) => {
      mocks.listSuppressionAudit.mockResolvedValue([]);
      const onClose = vi.fn();
      const { client, container, root } = render(
        <HistoryFocusHarness onClose={onClose} />,
      );
      try {
        const trigger = button("Open history");
        const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
        expect(dialog?.contains(document.activeElement)).toBe(true);
        expect(document.activeElement).not.toBe(trigger);

        await act(async () => {
          if (closeMethod === "Close") {
            button("Close").click();
          } else {
            document.dispatchEvent(
              new KeyboardEvent("keydown", {
                key: "Escape",
                bubbles: true,
                cancelable: true,
              }),
            );
          }
          await Promise.resolve();
        });
        await settleDialogFocus();

        expect(document.querySelector('[role="dialog"]')).toBeNull();
        expect(document.activeElement).toBe(trigger);
        expect(container.contains(trigger)).toBe(true);
        expect(onClose).toHaveBeenCalledTimes(1);
        expect(mocks.listSuppressionAudit).toHaveBeenCalledTimes(1);
        expect(mocks.patchSuppressionExpiry).not.toHaveBeenCalled();
      } finally {
        act(() => root.unmount());
        client.clear();
      }
    },
  );
});
