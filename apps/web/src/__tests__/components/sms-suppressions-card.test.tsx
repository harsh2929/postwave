// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { MeResponse } from "@/lib/auth-api";

const mocks = vi.hoisted(() => ({
  add: vi.fn(),
  list: vi.fn(),
  remove: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  whoami: vi.fn(),
}));

vi.mock("@/lib/sms-api", () => ({
  addSmsSuppression: mocks.add,
  listSmsSuppressions: mocks.list,
  removeSmsSuppression: mocks.remove,
}));
vi.mock("@/lib/auth-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth-api")>();
  return { ...actual, whoami: mocks.whoami };
});
vi.mock("sonner", () => ({
  toast: { error: mocks.toastError, success: mocks.toastSuccess },
}));
vi.mock("@/components/relative-time", () => ({
  RelativeTime: ({ iso }: { iso: string }) => <time>{iso}</time>,
}));

import { SmsSuppressionsCard } from "@/app/(dashboard)/app/sms/sms-suppressions-card";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const TENANT = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";
const roots: Root[] = [];

function me(overrides: Partial<MeResponse> = {}): MeResponse {
  return {
    user_id: USER,
    tenant_id: TENANT,
    email: "admin@example.test",
    role: "admin",
    effective_role: "admin",
    viewer_mode: false,
    auth_provider: "password",
    email_verified: true,
    workspace_name: "Test",
    workspace_slug: "test",
    ...overrides,
  };
}

async function eventually(assertion: () => void): Promise<void> {
  let error: unknown;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      assertion();
      return;
    } catch (next) {
      error = next;
      await act(async () => Promise.resolve());
    }
  }
  throw error;
}

function buttons(label: string): HTMLButtonElement[] {
  return Array.from(document.querySelectorAll("button")).filter(
    (button): button is HTMLButtonElement =>
      button instanceof HTMLButtonElement &&
      button.textContent?.trim() === label,
  );
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function renderCard() {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <SmsSuppressionsCard
          baseKey={["sms", TENANT, "admin", USER]}
          enabled
          tenantId={TENANT}
          userId={USER}
        />
      </QueryClientProvider>,
    );
  });
  await eventually(() => expect(mocks.list).toHaveBeenCalledTimes(1));
  await eventually(() => {
    expect(container.textContent).toContain("+12025550101");
    expect(buttons("Remove manual hold")[0]?.disabled).toBe(false);
  });
  return { client, container };
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

async function submitAdd(container: HTMLElement, phone: string): Promise<void> {
  const input = container.querySelector<HTMLInputElement>("#suppress_phone");
  const form = input?.closest("form");
  expect(input).toBeInstanceOf(HTMLInputElement);
  expect(form).toBeInstanceOf(HTMLFormElement);
  await act(async () => {
    setInput(input!, phone);
    form!.dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true }),
    );
    await Promise.resolve();
  });
}

async function openRemoveAndConfirm(phone: string): Promise<void> {
  act(() => buttons("Remove manual hold")[0]?.click());
  await eventually(() => expect(buttons("Remove manual hold")).toHaveLength(2));
  const confirmationLabel = Array.from(
    document.querySelectorAll<HTMLLabelElement>("label[for]"),
  ).find((label) => label.textContent?.includes(phone));
  expect(confirmationLabel).toBeDefined();
  const input = document.getElementById(
    confirmationLabel!.htmlFor,
  ) as HTMLInputElement;
  act(() => setInput(input, phone));
  await eventually(() =>
    expect(buttons("Remove manual hold").at(-1)?.disabled).toBe(false),
  );
  await act(async () => {
    buttons("Remove manual hold").at(-1)?.click();
    await Promise.resolve();
  });
}

async function escapeDialogAndExpectFocus(
  trigger: HTMLButtonElement,
): Promise<void> {
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
  expect(dialog).not.toBeNull();
  expect(dialog?.contains(document.activeElement)).toBe(true);
  expect(document.activeElement).not.toBe(trigger);

  await act(async () => {
    document.dispatchEvent(
      new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "Escape",
      }),
    );
    await Promise.resolve();
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => requestAnimationFrame(resolve));
  });

  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(document.activeElement).toBe(trigger);
}

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.list.mockResolvedValue({
    tenantId: TENANT,
    items: [
      {
        id: "33333333-3333-4333-8333-333333333333",
        phone_e164: "+12025550101",
        reason: "manual",
        source: "manual",
        created_at: "2026-08-21T09:00:00Z",
        reversible: true,
      },
      {
        id: "22222222-2222-4222-8222-222222222222",
        phone_e164: "+12025550102",
        reason: "stop_keyword",
        source: "twilio",
        created_at: "2026-08-21T08:00:00Z",
        reversible: false,
        locked_reason: "carrier_or_system_authority",
      },
    ],
    total: 2,
    snapshotAt: "2026-08-21T10:00:00Z",
  });
  mocks.whoami.mockResolvedValue(me());
  mocks.add.mockResolvedValue({
    id: "44444444-4444-4444-8444-444444444444",
    phone_e164: "+12025550103",
    reason: "manual",
    source: "manual",
    created_at: "2026-08-21T10:01:00Z",
    reversible: true,
  });
  mocks.remove.mockResolvedValue({
    ok: true,
    tenantId: TENANT,
    id: "33333333-3333-4333-8333-333333333333",
  });
});

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("SmsSuppressionsCard authority", () => {
  it("reports a typed 4xx add as a known no-commit refusal", async () => {
    mocks.add.mockRejectedValueOnce(
      Object.assign(new Error("unsafe conflict detail"), { status: 409 }),
    );
    const { container } = await renderCard();
    await submitAdd(container, "+12025550103");
    await eventually(() =>
      expect(mocks.toastError).toHaveBeenCalledWith(
        "Could not add suppression",
        expect.objectContaining({
          description: expect.stringMatching(/no change was committed/iu),
        }),
      ),
    );
    expect(JSON.stringify(mocks.toastError.mock.calls)).not.toContain(
      "unsafe conflict detail",
    );
    expect(JSON.stringify(mocks.toastError.mock.calls)).not.toContain(
      "outcome is unknown",
    );
  });

  it("reports an untyped add failure as outcome unknown and reloads", async () => {
    mocks.add.mockRejectedValueOnce(new Error("unsafe proxy detail"));
    const { container } = await renderCard();
    await submitAdd(container, "+12025550103");
    await eventually(() =>
      expect(mocks.toastError).toHaveBeenCalledWith(
        "Could not add suppression",
        expect.objectContaining({
          description: expect.stringMatching(/outcome is unknown/iu),
        }),
      ),
    );
    await eventually(() =>
      expect(mocks.list.mock.calls.length).toBeGreaterThan(1),
    );
    expect(JSON.stringify(mocks.toastError.mock.calls)).not.toContain(
      "unsafe proxy detail",
    );
  });

  it("reports a typed 4xx removal as a known no-commit refusal", async () => {
    mocks.remove.mockRejectedValueOnce(
      Object.assign(new Error("unsafe validation detail"), { status: 422 }),
    );
    await renderCard();
    await openRemoveAndConfirm("+12025550101");
    await eventually(() =>
      expect(mocks.toastError).toHaveBeenCalledWith(
        "Could not remove suppression",
        expect.objectContaining({
          description: expect.stringMatching(/no change was committed/iu),
        }),
      ),
    );
    expect(mocks.remove).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(mocks.toastError.mock.calls)).not.toContain(
      "unsafe validation detail",
    );
  });

  it("keeps stale rows orientation-only when a current roster refresh fails", async () => {
    const { client, container } = await renderCard();
    mocks.list.mockRejectedValueOnce(new Error("refresh failed"));
    await act(async () => {
      await client.refetchQueries({
        queryKey: ["sms", TENANT, "admin", USER, "suppressions"],
        exact: true,
      });
    });
    await eventually(() =>
      expect(container.textContent).toContain(
        "Suppressions failed tenant, response-cutoff, pagination, timestamp, phone, or authority checks.",
      ),
    );

    expect(container.textContent).toContain("+12025550101");
    expect(
      container.querySelector<HTMLInputElement>("#suppress_phone")?.disabled,
    ).toBe(true);
    expect(buttons("Add manual hold")[0]?.disabled).toBe(true);
    expect(buttons("Remove manual hold")[0]?.disabled).toBe(true);
    await submitAdd(container, "+12025550103");
    buttons("Remove manual hold")[0]?.click();
    expect(mocks.add).not.toHaveBeenCalled();
    expect(mocks.remove).not.toHaveBeenCalled();
  });

  it("removes its protected phone cache on tab exit", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <SmsSuppressionsCard
            baseKey={["sms", TENANT, "admin", USER]}
            enabled
            tenantId={TENANT}
            userId={USER}
          />
        </QueryClientProvider>,
      );
    });
    await eventually(() => expect(mocks.list).toHaveBeenCalledTimes(1));
    expect(client.getQueryCache().getAll()).toHaveLength(1);

    await act(async () => root.unmount());
    expect(client.getQueryCache().getAll()).toHaveLength(0);
  });

  it("offers deletion only for an exact reversible manual row", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => {
      root.render(
        <QueryClientProvider
          client={
            new QueryClient({
              defaultOptions: { queries: { retry: false } },
            })
          }
        >
          <SmsSuppressionsCard
            baseKey={["sms", TENANT, "admin", USER]}
            enabled
            tenantId={TENANT}
            userId={USER}
          />
        </QueryClientProvider>,
      );
    });
    await eventually(() =>
      expect(container.textContent).toContain("stop keyword"),
    );

    expect(buttons("Remove manual hold")).toHaveLength(1);
    expect(container.textContent).toContain(
      "locked: carrier or system authority",
    );
    expect(container.textContent).not.toContain(
      "re-enables SMS to a number that opted out",
    );
  });

  it("returns focus to the exact manual-hold trigger when Escape closes deletion", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => {
      root.render(
        <QueryClientProvider
          client={
            new QueryClient({
              defaultOptions: { queries: { retry: false } },
            })
          }
        >
          <SmsSuppressionsCard
            baseKey={["sms", TENANT, "admin", USER]}
            enabled
            tenantId={TENANT}
            userId={USER}
          />
        </QueryClientProvider>,
      );
    });
    await eventually(() =>
      expect(buttons("Remove manual hold")).toHaveLength(1),
    );

    const trigger = buttons("Remove manual hold")[0]!;
    trigger.focus();
    expect(document.activeElement).toBe(trigger);
    await act(async () => {
      trigger.click();
      await Promise.resolve();
    });

    await escapeDialogAndExpectFocus(trigger);
    expect(mocks.remove).not.toHaveBeenCalled();
    expect(mocks.whoami).not.toHaveBeenCalled();
  });

  it("reauthorizes and makes zero DELETE when effective authority changed", async () => {
    mocks.whoami.mockResolvedValue(me({ effective_role: "viewer" }));
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => {
      root.render(
        <QueryClientProvider
          client={
            new QueryClient({
              defaultOptions: { queries: { retry: false } },
            })
          }
        >
          <SmsSuppressionsCard
            baseKey={["sms", TENANT, "admin", USER]}
            enabled
            tenantId={TENANT}
            userId={USER}
          />
        </QueryClientProvider>,
      );
    });
    await eventually(() =>
      expect(buttons("Remove manual hold")).toHaveLength(1),
    );
    act(() => buttons("Remove manual hold")[0]!.click());
    await eventually(() =>
      expect(buttons("Remove manual hold")).toHaveLength(2),
    );
    const confirmationLabel = Array.from(
      document.querySelectorAll<HTMLLabelElement>("label[for]"),
    ).find((label) => label.textContent?.includes("+12025550101"));
    expect(confirmationLabel).toBeDefined();
    const input = document.getElementById(
      confirmationLabel!.htmlFor,
    ) as HTMLInputElement | null;
    expect(input).toBeInstanceOf(HTMLInputElement);
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      )?.set;
      setter?.call(input!, "+12025550101");
      input!.dispatchEvent(new Event("input", { bubbles: true }));
      input!.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await eventually(() =>
      expect(buttons("Remove manual hold").at(-1)?.disabled).toBe(false),
    );
    await act(async () => buttons("Remove manual hold").at(-1)!.click());
    await eventually(() => expect(mocks.whoami).toHaveBeenCalledTimes(1));

    expect(mocks.remove).not.toHaveBeenCalled();
    expect(mocks.toastError).toHaveBeenCalled();
  });

  it("rejects Unicode-trim, tab, and bidi phone aliases before reauthorization", async () => {
    const { container } = await renderCard();
    for (const phone of [
      "\u00a0+12025550103",
      "\t+12025550103",
      "+12025550103\u202e",
    ]) {
      await submitAdd(container, phone);
    }
    expect(mocks.whoami).not.toHaveBeenCalled();
    expect(mocks.add).not.toHaveBeenCalled();
    expect(mocks.toastError).toHaveBeenCalledTimes(3);
  });

  it("holds one global suppression write lock across add and remove controls", async () => {
    const pending = deferred<unknown>();
    mocks.add.mockReturnValueOnce(pending.promise);
    const { container } = await renderCard();

    await submitAdd(container, "+12025550103");
    await eventually(() => expect(mocks.add).toHaveBeenCalledTimes(1));
    expect(buttons("Remove manual hold")[0]?.disabled).toBe(true);
    expect(buttons("Add manual hold")[0]?.disabled).toBe(true);

    await submitAdd(container, "+12025550103");
    buttons("Remove manual hold")[0]?.click();
    expect(mocks.add).toHaveBeenCalledTimes(1);
    expect(mocks.remove).not.toHaveBeenCalled();

    await act(async () => {
      pending.resolve({
        id: "44444444-4444-4444-8444-444444444444",
        phone_e164: "+12025550103",
        reason: "manual",
        source: "manual",
        created_at: "2026-08-21T10:01:00Z",
        reversible: true,
      });
      await pending.promise;
      await Promise.resolve();
      await Promise.resolve();
    });
    await eventually(() => expect(mocks.whoami).toHaveBeenCalledTimes(2));
  });

  it("reports a confirmed add when identity changes after the server receipt", async () => {
    mocks.whoami
      .mockReset()
      .mockResolvedValueOnce(me())
      .mockResolvedValueOnce(
        me({ tenant_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }),
      );
    const { container } = await renderCard();
    await submitAdd(container, "+12025550103");
    await eventually(() =>
      expect(mocks.toastError).toHaveBeenCalledWith(
        "Manual hold was added before your identity changed",
        expect.objectContaining({
          description: expect.stringMatching(/server receipt confirmed/u),
        }),
      ),
    );
    expect(mocks.add).toHaveBeenCalledTimes(1);
    expect(mocks.toastError).not.toHaveBeenCalledWith(
      "Could not add suppression",
      expect.anything(),
    );
  });

  it("reports a confirmed removal when identity changes after the server receipt", async () => {
    mocks.whoami
      .mockReset()
      .mockResolvedValueOnce(me())
      .mockResolvedValueOnce(
        me({ user_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }),
      );
    await renderCard();
    await eventually(() =>
      expect(buttons("Remove manual hold")).toHaveLength(1),
    );
    await openRemoveAndConfirm("+12025550101");
    await eventually(() =>
      expect(mocks.toastError).toHaveBeenCalledWith(
        "Manual hold was removed before your identity changed",
        expect.objectContaining({
          description: expect.stringMatching(/server receipt confirmed/u),
        }),
      ),
    );
    expect(mocks.remove).toHaveBeenCalledTimes(1);
    expect(mocks.toastError).not.toHaveBeenCalledWith(
      "Could not remove suppression",
      expect.anything(),
    );
  });
});
