// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setOnlineStatusForTest } from "@/lib/online-manager";

import type { MeResponse } from "@/lib/auth-api";

const mocks = vi.hoisted(() => ({
  add: vi.fn(),
  bulkImport: vi.fn(),
  bulkRemove: vi.fn(),
  list: vi.fn(),
  remove: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  whoami: vi.fn(),
  online: "online" as "online" | "connecting" | "offline",
}));

vi.mock("@/lib/push-suppressions-api", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/push-suppressions-api")>();
  return {
    ...actual,
    addPushSuppression: mocks.add,
    bulkImportPushSuppressions: mocks.bulkImport,
    bulkRemovePushSuppressions: mocks.bulkRemove,
    listPushSuppressions: mocks.list,
    removePushSuppression: mocks.remove,
  };
});
vi.mock("@/lib/auth-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth-api")>();
  return { ...actual, whoami: mocks.whoami };
});
vi.mock("@/lib/use-online", () => ({ useOnline: () => mocks.online }));
vi.mock("sonner", () => ({
  toast: { error: mocks.toastError, success: mocks.toastSuccess },
}));
vi.mock("@/components/relative-time", () => ({
  RelativeTime: ({ iso }: { iso: string }) => <time>{iso}</time>,
}));

import { PushSuppressionsManager } from "@/app/(dashboard)/app/consent-evidence/push-suppressions-manager";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const TENANT = "11111111-1111-4111-8111-111111111111";
const USER = "admin-user";
const ID = "33333333-3333-4333-8333-333333333333";
const TOKEN = "apns-token-1234567890abcdef";
const roots: Root[] = [];

function me(over: Partial<MeResponse> = {}): MeResponse {
  return {
    user_id: USER,
    tenant_id: TENANT,
    email: "admin@example.test",
    role: "admin",
    effective_role: "admin",
    viewer_mode: false,
    auth_provider: "password",
    email_verified: true,
    workspace_name: "Workspace",
    workspace_slug: "workspace",
    ...over,
  };
}

function manualRow(over: Record<string, unknown> = {}) {
  return {
    id: ID,
    tenantId: TENANT,
    fingerprint: "0123456789abcdef",
    platform: "apns" as const,
    reason: "manual" as const,
    source: "dashboard" as const,
    createdAt: "2026-08-29T09:00:00Z",
    updatedAt: "2026-08-29T09:00:00Z",
    version: 3,
    reversible: true,
    ...over,
  };
}

function page(items = [manualRow()]) {
  return {
    tenantId: TENANT,
    items,
    total: items.length,
    snapshotAt: "2026-08-29T10:00:00Z",
  };
}

async function eventually(assertion: () => void): Promise<void> {
  let last: unknown;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      last = error;
      await act(async () => {
        await Promise.resolve();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
  }
  throw last;
}

function button(label: string): HTMLButtonElement | undefined {
  return Array.from(document.querySelectorAll("button")).find(
    (candidate): candidate is HTMLButtonElement =>
      candidate instanceof HTMLButtonElement &&
      candidate.textContent?.trim() === label,
  );
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

function setSelect(select: HTMLSelectElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLSelectElement.prototype,
    "value",
  )?.set;
  setter?.call(select, value);
  select.dispatchEvent(new Event("change", { bubbles: true }));
}

async function typeConfirmation(token: string): Promise<void> {
  const label = Array.from(document.querySelectorAll("label[for]")).find(
    (candidate) => candidate.textContent?.includes(token),
  ) as HTMLLabelElement | undefined;
  expect(label).toBeDefined();
  const input = document.getElementById(label!.htmlFor) as HTMLInputElement;
  await act(async () => setInput(input, token));
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

async function renderManager(currentMe: MeResponse = me()) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, networkMode: "always" },
      mutations: { retry: false },
    },
  });
  const render = async (nextMe: MeResponse) => {
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <PushSuppressionsManager
            me={nextMe}
            authPending={false}
            authError={false}
            authFetching={false}
            onRetryAuth={vi.fn()}
          />
        </QueryClientProvider>,
      );
    });
  };
  await render(currentMe);
  return { client, container, render };
}

beforeEach(() => {
  // Manual "load more" is refused unless the app is known to be online.
  setOnlineStatusForTest("online");
  mocks.online = "online";
  for (const value of Object.values(mocks)) {
    if (typeof value === "function" && "mockReset" in value) value.mockReset();
  }
  mocks.list.mockResolvedValue(page());
  mocks.whoami.mockResolvedValue(me());
  mocks.add.mockResolvedValue(manualRow());
  mocks.remove.mockResolvedValue({
    ok: true,
    tenantId: TENANT,
    id: ID,
    version: 4,
    stillSuppressed: false,
  });
  mocks.bulkImport.mockResolvedValue({
    ok: true,
    tenantId: TENANT,
    created: 1,
    existing: 0,
    items: [manualRow()],
  });
  mocks.bulkRemove.mockResolvedValue({
    ok: true,
    tenantId: TENANT,
    removed: 2,
    stillSuppressed: 0,
    items: [],
  });
});

afterEach(() => {
  setOnlineStatusForTest("connecting");
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.innerHTML = "";
});

describe("PushSuppressionsManager access and query truth", () => {
  it("never lists for a viewer and keeps the held-runtime disclosure visible", async () => {
    const { container } = await renderManager(
      me({ role: "viewer", effective_role: "viewer" }),
    );
    expect(container.textContent).toMatch(/delivery remains held/iu);
    expect(container.textContent).toMatch(/restricted to an active owner or admin/iu);
    expect(container.textContent).toMatch(/no zero total is inferred/iu);
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it("distinguishes a verified empty snapshot from loading", async () => {
    const pending = deferred<ReturnType<typeof page>>();
    mocks.list.mockReturnValueOnce(pending.promise);
    const { container } = await renderManager();
    expect(container.textContent).toMatch(/loading customer push registry/iu);
    await act(async () => pending.resolve(page([])));
    await eventually(() =>
      expect(container.textContent).toMatch(/verified registry snapshot contains no matching/iu),
    );

  });

  it("fails closed on a registry query error instead of claiming zero", async () => {
    mocks.list.mockRejectedValueOnce(new Error("malformed response"));
    const { container } = await renderManager();
    await eventually(() =>
      expect(container.textContent).toMatch(/registry total is unknown/iu),
    );
    expect(container.textContent).not.toMatch(/verified registry snapshot contains no/iu);
  });

  it("marks rows orientation-only and locks writes during a refresh", async () => {
    const { client, container } = await renderManager();
    await eventually(() =>
      expect(button("Review manual hold")?.disabled).toBe(false),
    );
    const pending = deferred<ReturnType<typeof page>>();
    mocks.list.mockReturnValueOnce(pending.promise);
    await act(async () => {
      void client.invalidateQueries({
        queryKey: ["consent-evidence", "push-registry"],
      });
      await Promise.resolve();
    });
    await eventually(() =>
      expect(container.textContent).toMatch(/rows are orientation only/iu),
    );
    expect(button("Review manual hold")?.disabled).toBe(true);
    await act(async () => pending.resolve(page()));
  });

  it("surfaces offline status and disables every write entry point", async () => {
    mocks.online = "offline";
    const { container } = await renderManager();
    await eventually(() =>
      expect(container.textContent).toMatch(/writes unavailable while offline/iu),
    );
    await eventually(() => {
      expect(button("Review manual hold")?.disabled).toBe(true);
      expect(button("Choose CSV for review")?.disabled).toBe(true);
      expect(button("Remove")?.disabled).toBe(true);
    });
  });

  it("wires platform and fingerprint filters into a fresh tenant-bound list", async () => {
    const { container } = await renderManager();
    await eventually(() => expect(mocks.list).toHaveBeenCalledTimes(1));
    const platform = container.querySelector<HTMLSelectElement>(
      "#push-platform-filter",
    )!;
    await act(async () => setSelect(platform, "fcm"));
    await eventually(() =>
      expect(mocks.list).toHaveBeenLastCalledWith(
        expect.objectContaining({ tenantId: TENANT, platform: "fcm" }),
      ),
    );

    const hash = container.querySelector<HTMLInputElement>(
      "#push-fingerprint-filter",
    )!;
    await act(async () => {
      setInput(hash, "01234567");
      hash.closest("form")!.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
    });
    await eventually(() =>
      expect(mocks.list).toHaveBeenLastCalledWith(
        expect.objectContaining({
          tenantId: TENANT,
          platform: "fcm",
          hashPrefix: "01234567",
        }),
      ),
    );
  });

  it("loads the signed continuation chain through the load-more control", async () => {
    const secondId = "22222222-2222-4222-8222-222222222222";
    mocks.list.mockImplementation(
      (input: { cursor?: string }) =>
        input.cursor
          ? {
              ...page([
                manualRow({
                  id: secondId,
                  fingerprint: "fedcba9876543210",
                  createdAt: "2026-08-29T08:00:00Z",
                  updatedAt: "2026-08-29T08:00:00Z",
                }),
              ]),
              total: 2,
              requestCursor: "signed_cursor",
            }
          : { ...page(), total: 2, nextCursor: "signed_cursor" },
    );
    const { container } = await renderManager();
    await eventually(() => expect(button("Load more authorities")).toBeDefined());
    await act(async () => button("Load more authorities")?.click());
    await eventually(() =>
      expect(mocks.list).toHaveBeenLastCalledWith(
        expect.objectContaining({ cursor: "signed_cursor", tenantId: TENANT }),
      ),
    );
    await eventually(() =>
      expect(container.textContent).toContain("fedcba9876543210"),
    );
  });
});

describe("PushSuppressionsManager reviewed writes", () => {
  it("reauthorizes before and after an exact add and requires typed review", async () => {
    const { container } = await renderManager();
    await eventually(() =>
      expect(button("Review manual hold")?.disabled).toBe(false),
    );
    const input = container.querySelector<HTMLInputElement>("#push-device-token")!;
    await act(async () => {
      setInput(input, TOKEN);
      input.closest("form")!.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
    });
    await eventually(() => expect(button("Add manual hold")).toBeDefined());
    expect(button("Add manual hold")?.disabled).toBe(true);
    expect(document.body.textContent).not.toContain(TOKEN);
    await typeConfirmation("ADD MANUAL");
    await eventually(() => expect(button("Add manual hold")?.disabled).toBe(false));
    await act(async () => {
      button("Add manual hold")?.click();
      await Promise.resolve();
    });
    await eventually(() => expect(mocks.add).toHaveBeenCalledTimes(1));
    await eventually(() => expect(mocks.whoami).toHaveBeenCalledTimes(2));
    expect(mocks.add).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: TENANT, userId: USER }),
      { deviceToken: TOKEN, platform: "apns" },
      { signal: expect.any(AbortSignal) },
    );
    expect(mocks.toastSuccess).toHaveBeenCalledWith(
      "Manual push hold confirmed",
      {},
    );
  });

  it("fails closed, reloads, and never echoes token-bearing receipt errors", async () => {
    mocks.add.mockRejectedValueOnce(
      new Error(`malformed receipt accidentally contained ${TOKEN}`),
    );
    const { container } = await renderManager();
    await eventually(() =>
      expect(button("Review manual hold")?.disabled).toBe(false),
    );
    const input = container.querySelector<HTMLInputElement>("#push-device-token")!;
    await act(async () => {
      setInput(input, TOKEN);
      input.closest("form")!.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
    });
    await typeConfirmation("ADD MANUAL");
    await act(async () => {
      button("Add manual hold")?.click();
      await Promise.resolve();
    });
    await eventually(() => expect(mocks.toastError).toHaveBeenCalled());
    expect(JSON.stringify(mocks.toastError.mock.calls)).not.toContain(TOKEN);
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
    await eventually(() => expect(mocks.list.mock.calls.length).toBeGreaterThan(1));
  });

  it("removes only the reviewed id/version and reauthorizes both sides", async () => {
    await renderManager();
    await eventually(() => expect(button("Remove")?.disabled).toBe(false));
    await act(async () => button("Remove")?.click());
    await typeConfirmation("0123456789abcdef");
    await act(async () => {
      button("Remove manual hold")?.click();
      await Promise.resolve();
    });
    await eventually(() => expect(mocks.remove).toHaveBeenCalledTimes(1));
    expect(mocks.remove).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: TENANT, userId: USER }),
      { id: ID, expectedVersion: 3 },
      { signal: expect.any(AbortSignal) },
    );
    await eventually(() => expect(mocks.whoami).toHaveBeenCalledTimes(2));
  });

  it("parses and reviews bulk import without rendering raw tokens", async () => {
    const secondToken = "fcm-token-1234567890-zyxwv";
    const { container } = await renderManager();
    await eventually(() =>
      expect(button("Choose CSV for review")?.disabled).toBe(false),
    );
    const fileInput = container.querySelector<HTMLInputElement>(
      'input[type="file"]',
    )!;
    Object.defineProperty(fileInput, "files", {
      configurable: true,
      value: [
        {
          size: 128,
          text: async () =>
            `platform,device_token\napns,${TOKEN}\nfcm,${secondToken}`,
        },
      ],
    });
    await act(async () => {
      fileInput.dispatchEvent(new Event("change", { bubbles: true }));
      await Promise.resolve();
    });
    await eventually(() => expect(button("Import reviewed holds")).toBeDefined());
    expect(document.body.textContent).not.toContain(TOKEN);
    expect(document.body.textContent).not.toContain(secondToken);
    await typeConfirmation("IMPORT 2");
    await act(async () => {
      button("Import reviewed holds")?.click();
      await Promise.resolve();
    });
    await eventually(() => expect(mocks.bulkImport).toHaveBeenCalledTimes(1));
    expect(mocks.bulkImport).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: TENANT, userId: USER }),
      [
        { deviceToken: TOKEN, platform: "apns" },
        { deviceToken: secondToken, platform: "fcm" },
      ],
      { signal: expect.any(AbortSignal) },
    );
    await eventually(() => expect(mocks.whoami).toHaveBeenCalledTimes(2));
  });

  it("bulk-removes only the two selected reviewed versions", async () => {
    const secondId = "22222222-2222-4222-8222-222222222222";
    mocks.list.mockResolvedValueOnce(
      page([
        manualRow(),
        manualRow({
          id: secondId,
          fingerprint: "fedcba9876543210",
          createdAt: "2026-08-29T08:00:00Z",
          updatedAt: "2026-08-29T08:00:00Z",
          version: 7,
        }),
      ]),
    );
    await renderManager();
    await eventually(() =>
      expect(
        document.querySelectorAll(
          'input[type="checkbox"][aria-label^="Select manual hold"]',
        ),
      ).toHaveLength(2),
    );
    const selectAll = document.querySelector<HTMLInputElement>(
      'input[aria-label="Select all removable loaded rows"]',
    );
    expect(selectAll).toBeInstanceOf(HTMLInputElement);
    await act(async () => {
      selectAll!.click();
    });
    await eventually(() =>
      expect(button("Review removal (2)")?.disabled).toBe(false),
    );
    await act(async () => button("Review removal (2)")?.click());
    await typeConfirmation("REMOVE 2");
    await act(async () => {
      button("Remove reviewed holds")?.click();
      await Promise.resolve();
    });
    await eventually(() => expect(mocks.bulkRemove).toHaveBeenCalledTimes(1));
    expect(mocks.bulkRemove).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: TENANT, userId: USER }),
      [
        { id: ID, expectedVersion: 3 },
        { id: secondId, expectedVersion: 7 },
      ],
      { signal: expect.any(AbortSignal) },
    );
    await eventually(() => expect(mocks.whoami).toHaveBeenCalledTimes(2));
  });

  it("aborts an in-flight write and suppresses stale completion on identity change", async () => {
    let capturedSignal: AbortSignal | undefined;
    const pending = deferred<ReturnType<typeof manualRow>>();
    mocks.add.mockImplementationOnce(
      (_authority: unknown, _input: unknown, options: { signal: AbortSignal }) => {
        capturedSignal = options.signal;
        return pending.promise;
      },
    );
    const { container, render } = await renderManager();
    await eventually(() =>
      expect(button("Review manual hold")?.disabled).toBe(false),
    );
    const input = container.querySelector<HTMLInputElement>("#push-device-token")!;
    await act(async () => {
      setInput(input, TOKEN);
      input.closest("form")!.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
    });
    await typeConfirmation("ADD MANUAL");
    await act(async () => {
      button("Add manual hold")?.click();
      await Promise.resolve();
    });
    await eventually(() => expect(mocks.add).toHaveBeenCalledTimes(1));
    await render(me({ user_id: "next-admin" }));
    expect(capturedSignal?.aborted).toBe(true);
    pending.reject(new DOMException("retired", "AbortError"));
    await act(async () => Promise.resolve());
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
  });
});
