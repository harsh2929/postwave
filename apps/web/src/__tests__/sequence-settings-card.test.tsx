// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// Sequence goal / exit criteria / stuck threshold (desktop parity row
// automation-77). Each test drives a real render and asserts the CONSEQUENCE:
// the PATCH's method + path + body + If-Match, the bumped version handed back
// to the page, what the card then renders — or, for a withheld verb, that no
// request was made and the reason shown is the one the operator can act on.

import { act, createElement, type ReactNode } from "react";
import type { Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { trackRoot, unmountRoots } from "./_roots";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
  whoami: vi.fn(),
  whoamiFresh: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: mocks };
});
vi.mock("@/lib/auth-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth-api")>();
  return {
    ...actual,
    whoami: mocks.whoami,
    whoamiFresh: mocks.whoamiFresh,
  };
});
vi.mock("sonner", () => ({
  toast: { success: mocks.toastSuccess, error: mocks.toastError },
}));

import { ApiError } from "@/lib/api";
import {
  SEQUENCE_SETTINGS_READ_ONLY_MESSAGE,
  SequenceSettingsCard,
} from "@/app/(dashboard)/app/sequences/[id]/sequence-settings-card";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const PATH = "/api/v1/voice/sequences/seq_1";

function me(role: "admin" | "viewer" = "admin") {
  return {
    user_id: "usr_1",
    tenant_id: "tnt_1",
    email: "operator@example.com",
    role,
    effective_role: role,
    viewer_mode: false,
    auth_provider: "password",
    email_verified: true,
    workspace_name: "Acme",
    workspace_slug: "acme",
  };
}

function storedRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "seq_1",
    version: 4,
    name: "Welcome",
    status: "draft",
    goal: null,
    stuck_after_days: 0,
    steps: [],
    ...overrides,
  };
}

function render(ui: ReactNode): Root {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = trackRoot(container);
  act(() => {
    root.render(
      createElement(QueryClientProvider, { client: queryClient }, ui),
    );
  });
  return root;
}

async function flush(): Promise<void> {
  await new Promise((r) => window.requestAnimationFrame(r));
  await new Promise((r) => window.setTimeout(r, 0));
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
        await flush();
      });
    }
  }
  throw lastError;
}

function button(text: string): HTMLButtonElement {
  const found = Array.from(document.querySelectorAll("button")).find(
    (b): b is HTMLButtonElement =>
      b instanceof HTMLButtonElement && b.textContent?.includes(text) === true,
  );
  if (!found) throw new Error(`Button "${text}" not found`);
  return found;
}

function section(): HTMLElement {
  const found = document.querySelector<HTMLElement>(
    'section[aria-label="Sequence goal and stuck settings"]',
  );
  if (!found) throw new Error("Settings section not found");
  return found;
}

function field<T extends Element>(selector: string): T {
  const found = section().querySelector<T>(selector);
  if (!found) throw new Error(`Field ${selector} not found`);
  return found;
}

async function set(
  control: HTMLInputElement | HTMLSelectElement,
  value: string,
): Promise<void> {
  const prototype =
    control instanceof HTMLSelectElement
      ? window.HTMLSelectElement.prototype
      : window.HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(
      control,
      value,
    );
    control.dispatchEvent(new Event("input", { bubbles: true }));
    control.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();
  });
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.click();
    await flush();
  });
}

function reasonFor(control: HTMLElement): string {
  const id = control.getAttribute("aria-describedby") ?? "";
  return document.getElementById(id)?.textContent ?? "";
}

function renderCard(overrides: Record<string, unknown> = {}) {
  const onSaved = vi.fn();
  const onSavingChange = vi.fn();
  render(
    createElement(SequenceSettingsCard, {
      sequenceId: "seq_1",
      version: 4,
      canEdit: true,
      editUnavailableReason: "",
      busy: false,
      onSaved,
      onSavingChange,
      ...overrides,
    }),
  );
  return { onSaved, onSavingChange };
}

async function expand(): Promise<void> {
  await waitFor(() =>
    expect(mocks.get).toHaveBeenCalledWith(
      PATH,
      expect.objectContaining({
        cache: "no-store",
        requireOnline: true,
        maxAttempts: 1,
        signal: expect.any(AbortSignal),
      }),
    ),
  );
  await click(button("Goal & exit criteria"));
  await waitFor(() => {
    expect(section().querySelector("select")).not.toBeNull();
  });
}

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.whoami.mockResolvedValue(me());
  mocks.whoamiFresh.mockResolvedValue(me());
  mocks.get.mockResolvedValue(storedRow());
});

afterEach(() => {
  unmountRoots();
  document.body.innerHTML = "";
});

describe("SequenceSettingsCard — goal, exit criteria, stuck threshold (automation-77)", () => {
  it("saves goal + exit + stuck under the page's If-Match version and hands the bumped version back", async () => {
    mocks.patch.mockResolvedValue(
      storedRow({
        version: 5,
        goal: { kind: "click", exit_on_goal: true },
        stuck_after_days: 14,
      }),
    );
    const { onSaved, onSavingChange } = renderCard();
    await expand();
    expect(section().textContent).toContain("Goal: none · Stuck after: off");

    await set(field<HTMLSelectElement>("select"), "click");
    await click(field<HTMLInputElement>('input[type="checkbox"]'));
    await set(field<HTMLInputElement>('input[type="number"]'), "14");
    expect(mocks.patch).not.toHaveBeenCalled();

    await click(button("Save settings"));
    await waitFor(() => expect(mocks.patch).toHaveBeenCalledTimes(1));
    expect(mocks.patch).toHaveBeenCalledWith(
      PATH,
      { goal: { kind: "click", exit_on_goal: true }, stuck_after_days: 14 },
      expect.objectContaining({
        headers: { "If-Match": '"4"' },
        requireOnline: true,
        cache: "no-store",
        maxAttempts: 1,
        signal: expect.any(AbortSignal),
        idempotencyKey: expect.any(String),
      }),
    );
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(onSaved).toHaveBeenCalledWith(
      expect.objectContaining({
        version: 5,
        goal: { kind: "click", exit_on_goal: true },
        stuckAfterDays: 14,
      }),
    );
    expect(mocks.toastSuccess).toHaveBeenCalledWith("Sequence settings saved.");
    expect(onSavingChange).toHaveBeenCalledWith(true);
    expect(onSavingChange).toHaveBeenLastCalledWith(false);
    await waitFor(() => {
      expect(section().textContent).toContain(
        "Goal: Clicked a link in this sequence · Stuck after: 14 days",
      );
    });
    expect(section().querySelector('[role="alert"]')).toBeNull();
  });

  it("clears a stored goal by sending goal: null and keeps the stored stuck threshold", async () => {
    mocks.get.mockResolvedValue(
      storedRow({
        goal: { kind: "open", exit_on_goal: false },
        stuck_after_days: 7,
      }),
    );
    mocks.patch.mockResolvedValue(
      storedRow({ version: 5, goal: null, stuck_after_days: 7 }),
    );
    renderCard();
    await expand();
    expect(section().textContent).toContain(
      "Goal: Opened an email in this sequence · Stuck after: 7 days",
    );
    expect(field<HTMLSelectElement>("select").value).toBe("open");
    expect(field<HTMLInputElement>('input[type="number"]').value).toBe("7");

    await set(field<HTMLSelectElement>("select"), "");
    await click(button("Save settings"));
    await waitFor(() => expect(mocks.patch).toHaveBeenCalledTimes(1));
    expect(mocks.patch.mock.calls[0]?.[1]).toEqual({
      goal: null,
      stuck_after_days: 7,
    });
  });

  it("withholds the save from a viewer with the reason and sends nothing", async () => {
    mocks.whoami.mockResolvedValue(me("viewer"));
    renderCard();
    await expand();
    const save = button("Save settings");
    expect(save.disabled).toBe(true);
    expect(reasonFor(save)).toBe(SEQUENCE_SETTINGS_READ_ONLY_MESSAGE);
    expect(field<HTMLSelectElement>("select").disabled).toBe(true);
    expect(field<HTMLInputElement>('input[type="number"]').disabled).toBe(true);
    expect(mocks.patch).not.toHaveBeenCalled();
  });

  it("locks the controls with the page's own reason when the draft is not editable", async () => {
    const reason =
      "Stored as archived and read-only in the web draft designer. Only confirmed drafts can be edited.";
    renderCard({ canEdit: false, editUnavailableReason: reason });
    await expand();
    const save = button("Save settings");
    expect(save.disabled).toBe(true);
    expect(reasonFor(save)).toBe(reason);
    expect(mocks.patch).not.toHaveBeenCalled();
  });

  it("refuses an out-of-range stuck threshold before any request", async () => {
    renderCard();
    await expand();
    await set(field<HTMLInputElement>('input[type="number"]'), "400");
    const save = button("Save settings");
    expect(save.disabled).toBe(true);
    expect(section().querySelector('[role="alert"]')?.textContent).toMatch(
      /between 0 \(off\) and 365/,
    );
    await click(save);
    expect(mocks.patch).not.toHaveBeenCalled();
  });

  it("renders the server's 412 sentence verbatim and hands nothing back to the page", async () => {
    const sentence = "Sequence version conflict. Reload the latest draft.";
    mocks.patch.mockRejectedValue(new ApiError(sentence, 412));
    const { onSaved } = renderCard();
    await expand();
    await set(field<HTMLInputElement>('input[type="number"]'), "3");
    await click(button("Save settings"));
    await waitFor(() => expect(mocks.patch).toHaveBeenCalledTimes(1));
    await waitFor(() => {
      expect(section().querySelector('[role="alert"]')?.textContent).toBe(
        sentence,
      );
    });
    expect(onSaved).not.toHaveBeenCalled();
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
  });

  it("waits for the page's own email save before allowing a settings save", async () => {
    renderCard({ busy: true });
    await expand();
    const save = button("Save settings");
    expect(save.disabled).toBe(true);
    expect(reasonFor(save)).toBe(
      "Wait for the current save to finish before changing settings.",
    );
  });

  it("never requests protected settings when identity resolution fails", async () => {
    mocks.whoami.mockRejectedValue(new Error("identity offline"));
    renderCard();
    await click(button("Goal & exit criteria"));
    await waitFor(() =>
      expect(section().textContent).toContain(
        "Workspace identity could not be verified",
      ),
    );
    expect(mocks.get).not.toHaveBeenCalled();
    expect(mocks.patch).not.toHaveBeenCalled();
  });

  it("rechecks exact write authority immediately before PATCH", async () => {
    mocks.whoamiFresh.mockResolvedValue(me("viewer"));
    renderCard();
    await expand();
    await set(field<HTMLInputElement>('input[type="number"]'), "2");
    await click(button("Save settings"));
    await waitFor(() => expect(mocks.whoamiFresh).toHaveBeenCalledTimes(1));
    expect(mocks.patch).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(section().textContent).toContain(
        "campaign write authority changed",
      ),
    );
  });

  it("dedupes a same-tick save and preserves one operation idempotency key", async () => {
    let releaseFresh: ((identity: ReturnType<typeof me>) => void) | undefined;
    mocks.whoamiFresh.mockImplementation(
      () =>
        new Promise<ReturnType<typeof me>>((resolve) => {
          releaseFresh = resolve;
        }),
    );
    mocks.patch.mockResolvedValue(
      storedRow({ version: 5, goal: null, stuck_after_days: 2 }),
    );
    renderCard();
    await expand();
    await set(field<HTMLInputElement>('input[type="number"]'), "2");
    const save = button("Save settings");
    act(() => {
      save.click();
      save.click();
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(mocks.whoamiFresh).toHaveBeenCalledTimes(1);
    expect(mocks.patch).not.toHaveBeenCalled();

    await act(async () => {
      releaseFresh?.(me());
      await flush();
    });
    await waitFor(() => expect(mocks.patch).toHaveBeenCalledTimes(1));
    expect(mocks.patch.mock.calls[0]?.[2]?.idempotencyKey).toEqual(
      expect.any(String),
    );
  });
});
