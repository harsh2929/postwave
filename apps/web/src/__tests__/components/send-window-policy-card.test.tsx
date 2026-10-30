// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// Parity row campaigns-33 — the send-window policy editor.
//
// Two things here are easy to get wrong and expensive when wrong:
//   1. The weekday bitmap is Go's `time.Weekday` numbering (bit 0 = Sunday).
//      An ISO 1..7 index would shift every window by a day and still look
//      plausible on screen, so the bit value in the PUT body is asserted.
//   2. Enforcement "off" and DELETE both leave sending unrestricted TODAY and
//      differ entirely in what survives. The confirm has to say which.
import { act, createElement } from "react";
import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  put: vi.fn(),
  del: vi.fn(),
  whoamiFresh: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  api: { get: mocks.get, put: mocks.put, delete: mocks.del },
  apiErrorMessage: (error: unknown, fallback = "Something went wrong") =>
    error instanceof Error && error.message ? error.message : fallback,
}));
vi.mock("@/lib/auth-api", () => ({
  whoami: vi.fn(),
  whoamiFresh: mocks.whoamiFresh,
  effectiveAuthRole: (me: { effective_role?: string; role: string }) =>
    me.effective_role ?? me.role,
}));
vi.mock("sonner", () => ({
  toast: {
    success: mocks.toastSuccess,
    error: mocks.toastError,
    info: vi.fn(),
    warning: vi.fn(),
  },
}));

import { SendWindowPolicyCard } from "@/app/(dashboard)/app/list-hygiene/send-window-policy-card";
import type { MeResponse } from "@/lib/auth-api";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const OWNER = {
  user_id: "11111111-1111-4111-8111-111111111111",
  tenant_id: "22222222-2222-4222-8222-222222222222",
  email: "ada@example.com",
  role: "owner",
  effective_role: "owner",
  viewer_mode: false,
} as unknown as MeResponse;
const EDITOR = {
  ...OWNER,
  role: "editor",
  effective_role: "editor",
} as unknown as MeResponse;

const KEY = ["list-hygiene", OWNER.tenant_id, "owner", "send-window"] as const;

const POLICY = {
  start_local: "09:00",
  end_local: "17:00",
  timezone: "Europe/Stockholm",
  weekday_bitmap: 126,
  weekdays: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
  enforcement: "warn",
  created_at: "2026-08-01T09:00:00Z",
  updated_at: "2026-08-02T09:00:00Z",
};

const roots: Root[] = [];

function render(ui: ReactNode): Root {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => {
    root.render(createElement(QueryClientProvider, { client }, ui));
  });
  roots.push(root);
  return root;
}

async function flush(): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

function mount(identity: MeResponse | null = OWNER) {
  return render(
    createElement(SendWindowPolicyCard, { identity, queryKey: KEY }),
  );
}

function button(label: string): HTMLButtonElement {
  const match = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!match) throw new Error(`Button not found: ${label}`);
  return match;
}

function dialogButton(label: string): HTMLButtonElement {
  const dialog = document.querySelector('[role="dialog"]');
  if (!dialog) throw new Error("No confirm dialog is open");
  const match = [...dialog.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!match) throw new Error(`Dialog button not found: ${label}`);
  return match;
}

function card(): HTMLElement {
  const element = document.querySelector<HTMLElement>(
    '[data-testid="send-window-policy"]',
  );
  if (!element) throw new Error("Send-window card not rendered");
  return element;
}

function setSelect(select: HTMLSelectElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLSelectElement.prototype,
    "value",
  )?.set;
  setter?.call(select, value);
  select.dispatchEvent(new Event("change", { bubbles: true }));
}

function setInput(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

function labelledInput(text: string): HTMLInputElement {
  const label = [...document.querySelectorAll("label")].find((candidate) =>
    candidate.textContent?.includes(text),
  );
  const id = label?.getAttribute("for") ?? "";
  const input = document.getElementById(id);
  if (!(input instanceof HTMLInputElement)) {
    throw new Error(`Input not found for label: ${text}`);
  }
  return input;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.whoamiFresh.mockResolvedValue(OWNER);
  mocks.get.mockResolvedValue({ policy: POLICY });
  mocks.put.mockImplementation(async (_path: string, body: unknown) => ({
    ...POLICY,
    ...(body as Record<string, unknown>),
    weekdays: ["Mon"],
  }));
  mocks.del.mockResolvedValue(undefined);
});

afterEach(() => {
  act(() => {
    for (const root of roots.splice(0)) root.unmount();
  });
  document.body.innerHTML = "";
});

describe("send window policy editor", () => {
  it("shows the whole configured policy, not just that one exists", async () => {
    mount();
    await flush();

    expect(mocks.get).toHaveBeenCalledWith("/api/v1/send-window");
    expect(card().dataset.state).toBe("configured");
    expect(card().textContent).toContain(
      "09:00–17:00 Europe/Stockholm on Mon, Tue, Wed, Thu, Fri, Sat; enforcement warn.",
    );
  });

  it("saves the edited window with Go weekday bits in the PUT body", async () => {
    mount();
    await flush();

    // Turn Sunday ON (bit 0) — 126 becomes 127.
    act(() => button("Sun").click());
    act(() =>
      setSelect(
        document.querySelector<HTMLSelectElement>("select")!,
        "block",
      ),
    );
    act(() => setInput(labelledInput("Window closes"), "18:30"));
    act(() => button("Save send window").click());
    await flush();

    expect(mocks.put).toHaveBeenCalledWith("/api/v1/send-window", {
      start_local: "09:00",
      end_local: "18:30",
      timezone: "Europe/Stockholm",
      weekday_bitmap: 127,
      enforcement: "block",
    });
    // Admin authority is re-read against the live session before the write.
    expect(mocks.whoamiFresh).toHaveBeenCalled();
    expect(mocks.toastSuccess).toHaveBeenCalled();
  });

  it("refuses a window that ends before it starts, before spending a request", async () => {
    mount();
    await flush();

    act(() => setInput(labelledInput("Window closes"), "08:00"));
    expect(button("Save send window").disabled).toBe(true);
    expect(card().textContent).toContain("End time must be after start time.");
    expect(mocks.put).not.toHaveBeenCalled();
  });

  it("refuses a window with no days selected", async () => {
    mount();
    await flush();

    for (const day of ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]) {
      act(() => button(day).click());
    }
    expect(button("Save send window").disabled).toBe(true);
    expect(card().textContent).toContain("Pick at least one weekday.");
  });

  it("deletes the policy only behind a confirm that separates removal from 'off'", async () => {
    mount();
    await flush();

    act(() => button("Remove send window").click());
    await flush();

    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain(
      "sending stops being restricted by time of day for this whole workspace",
    );
    expect(dialog?.textContent).toContain("set enforcement to Off and save");
    expect(mocks.del).not.toHaveBeenCalled();

    act(() => dialogButton("Remove send window").click());
    await flush();

    expect(mocks.del).toHaveBeenCalledWith("/api/v1/send-window");
    expect(card().dataset.state).toBe("none");
    expect(card().textContent).toContain(
      "No send window configured — sending is not restricted by time of day.",
    );
  });

  it("offers creation, not removal, when the workspace has no window", async () => {
    mocks.get.mockResolvedValue({ policy: null });
    mount();
    await flush();

    expect(card().dataset.state).toBe("none");
    expect(button("Create send window").disabled).toBe(false);
    expect(button("Remove send window").disabled).toBe(true);
  });

  it("withholds both writes from a non-admin with the admin reason", async () => {
    mount(EDITOR);
    await flush();

    expect(button("Save send window").disabled).toBe(true);
    expect(button("Remove send window").disabled).toBe(true);
    expect(card().textContent).toContain(
      "Changing the send window needs owner or admin access outside viewer mode.",
    );
  });

  it("reports a failed read as a failed request, not as an absent policy", async () => {
    mocks.get.mockRejectedValue(new Error("send-window read failed"));
    mount();
    await flush();

    expect(card().textContent).toContain(
      "failed request, not an absent policy",
    );
  });
});
