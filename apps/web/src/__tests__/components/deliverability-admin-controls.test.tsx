// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom

import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  verifyAdmin: vi.fn(),
  listProviders: vi.fn(),
  saveProvider: vi.fn(),
  deleteProvider: vi.fn(),
  getBlocklist: vi.fn(),
  setBlocklist: vi.fn(),
  listCaps: vi.fn(),
  createCap: vi.fn(),
  updateCap: vi.fn(),
  deleteCap: vi.fn(),
  copy: vi.fn(),
  successToast: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: { success: mocks.successToast, error: vi.fn() },
}));

vi.mock("@/lib/admin-mutation-authority", () => ({
  verifyFreshAdminAuthority: mocks.verifyAdmin,
}));

vi.mock("@/lib/clipboard", () => ({ copyToClipboard: mocks.copy }));

vi.mock("@/lib/deliverability-admin-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/deliverability-admin-api")>()),
  listDeliverabilityProviders: mocks.listProviders,
  saveDeliverabilityProvider: mocks.saveProvider,
  deleteDeliverabilityProvider: mocks.deleteProvider,
  getBlocklistAutoSuppress: mocks.getBlocklist,
  setBlocklistAutoSuppress: mocks.setBlocklist,
  listFrequencyCapRules: mocks.listCaps,
  createFrequencyCapRule: mocks.createCap,
  updateFrequencyCapRule: mocks.updateCap,
  deleteFrequencyCapRule: mocks.deleteCap,
}));

import { BlocklistContainmentPanel } from "@/app/(dashboard)/app/deliverability/blocklist-containment-panel";
import { ProviderConfigPanel } from "@/app/(dashboard)/app/deliverability/provider-config-panel";
import { FrequencyCapsPanel } from "@/app/(dashboard)/app/list-hygiene/frequency-caps-panel";
import type { MeResponse } from "@/lib/auth-api";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const IDENTITY: MeResponse = {
  user_id: "11111111-1111-4111-8111-111111111111",
  tenant_id: "22222222-2222-4222-8222-222222222222",
  email: "owner@example.test",
  role: "owner",
  auth_provider: "password",
  email_verified: true,
  workspace_name: "Test",
  workspace_slug: "test",
};

const PROVIDER_ROW = {
  id: "33333333-3333-4333-8333-333333333333",
  tenant_id: IDENTITY.tenant_id,
  provider: "sendgrid" as const,
  display_name: "Production",
  config: { webhook_token_hash: "redacted" },
  active: true,
  created_at: "2026-08-30T10:00:00Z",
  updated_at: "2026-08-30T10:01:00Z",
};

const CREATED_CAP = {
  id: "44444444-4444-4444-8444-444444444444",
  label: "Marketing",
  max_sends: 3,
  window_hours: 24,
  active: true,
  channels: ["email" as const],
  created_at: "2026-08-30T10:00:00Z",
  updated_at: "2026-08-30T10:01:00Z",
};

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  window.localStorage.clear();
  installTestWebLocks();
  mocks.verifyAdmin.mockResolvedValue(IDENTITY);
  mocks.copy.mockResolvedValue("copied");
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("deliverability admin controls", () => {
  it("generates, acknowledges, saves, and freshly confirms a write-only provider token", async () => {
    mocks.listProviders.mockResolvedValue([PROVIDER_ROW]);
    mocks.saveProvider.mockResolvedValue({
      ...PROVIDER_ROW,
      updated_at: "2026-08-30T10:02:00Z",
    });
    const root = render(
      createElement(ProviderConfigPanel, { identity: IDENTITY }),
    );
    try {
      await flush();
      await click(button("Generate 256-bit token"));
      const token = document.querySelector<HTMLInputElement>(
        "#deliverability-provider-webhook-token",
      );
      expect(token?.value).toMatch(/^[a-f0-9]{64}$/u);
      const acknowledgement = [...document.querySelectorAll("label")].find(
        (label) => label.textContent?.includes("I stored this generated token"),
      );
      const checkbox = acknowledgement?.querySelector<HTMLInputElement>(
        'input[type="checkbox"]',
      );
      expect(checkbox).toBeTruthy();
      await clickInput(checkbox as HTMLInputElement);
      await click(button("Save provider"));
      await flush(8);

      expect(mocks.verifyAdmin).toHaveBeenCalledWith(
        IDENTITY,
        expect.any(AbortSignal),
      );
      expect(mocks.saveProvider).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: "sendgrid",
          config: { webhook_token: expect.stringMatching(/^[a-f0-9]{64}$/u) },
        }),
        expect.objectContaining({
          id: PROVIDER_ROW.id,
          signal: expect.any(AbortSignal),
        }),
      );
      expect(document.body.textContent).toContain(
        "saved and confirmed by a fresh server read",
      );
      expect(
        document.querySelector<HTMLInputElement>(
          "#deliverability-provider-webhook-token",
        )?.value,
      ).toBe("");
    } finally {
      act(() => root.unmount());
    }
  });

  it("requires typed consequence confirmation before enabling blocklist containment", async () => {
    const off = {
      auto_suppress: false,
      eligible_now: 4,
      active_suppressions: 2,
      observed_at: "2026-08-30T10:00:00Z",
    };
    const on = { ...off, auto_suppress: true };
    mocks.getBlocklist
      .mockResolvedValueOnce(off)
      .mockResolvedValueOnce(off)
      .mockResolvedValueOnce(on);
    mocks.setBlocklist.mockResolvedValue(on);
    const root = render(
      createElement(BlocklistContainmentPanel, { identity: IDENTITY }),
    );
    try {
      await flush();
      await click(button("Enable containment"));
      const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
      expect(dialog).toBeTruthy();
      const confirmation = dialog?.querySelector<HTMLInputElement>("input");
      await setInput(confirmation as HTMLInputElement, "ENABLE CONTAINMENT");
      await click(button("Enable containment", dialog as HTMLElement));
      await flush(8);

      expect(mocks.verifyAdmin).toHaveBeenCalledWith(IDENTITY);
      expect(mocks.setBlocklist).toHaveBeenCalledWith(true);
      expect(document.body.textContent).toContain("Configured on");
    } finally {
      act(() => root.unmount());
    }
  });

  it("creates a cap only through the canonical enforced path and confirms it", async () => {
    mocks.listCaps
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([CREATED_CAP]);
    mocks.createCap.mockResolvedValue(CREATED_CAP);
    const root = render(
      createElement(FrequencyCapsPanel, { identity: IDENTITY }),
    );
    try {
      await flush();
      await click(button("Add cap"));
      await setInput(
        document.querySelector<HTMLInputElement>(
          "#frequency-cap-label",
        ) as HTMLInputElement,
        "Marketing",
      );
      await click(button("Create cap"));
      await flush(8);

      expect(mocks.verifyAdmin).toHaveBeenCalledWith(IDENTITY);
      expect(mocks.createCap).toHaveBeenCalledWith(
        {
          label: "Marketing",
          max_sends: 3,
          window_hours: 24,
          active: true,
          channels: ["email"],
        },
        { idempotencyKey: expect.any(String) },
      );
      expect(document.body.textContent).toContain(
        "Frequency cap saved and confirmed",
      );
    } finally {
      act(() => root.unmount());
    }
  });

  it("retains and reuses one create key after an ambiguous response", async () => {
    mocks.listCaps
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new TypeError("connection lost"))
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([CREATED_CAP]);
    mocks.createCap
      .mockRejectedValueOnce(new TypeError("connection lost"))
      .mockResolvedValueOnce(CREATED_CAP);
    const root = render(
      createElement(FrequencyCapsPanel, { identity: IDENTITY }),
    );
    try {
      await flush();
      await click(button("Add cap"));
      await setInput(
        document.querySelector<HTMLInputElement>(
          "#frequency-cap-label",
        ) as HTMLInputElement,
        "Marketing",
      );
      await click(button("Create cap"));
      await flush(8);

      expect(document.body.textContent).toContain(
        "Durable original request retained",
      );
      expect(
        document.querySelector<HTMLInputElement>("#frequency-cap-label")
          ?.disabled,
      ).toBe(true);
      expect(button("Add cap").disabled).toBe(true);
      const firstKey = mocks.createCap.mock.calls[0]?.[1]?.idempotencyKey;
      expect(firstKey).toEqual(expect.any(String));

      expect(
        [...document.querySelectorAll("button")].some(
          (candidate) =>
            candidate.textContent?.trim() === "Retry original request",
        ),
      ).toBe(false);
      await click(button("Verify outcome"));
      await flush(6);
      await click(button("Retry original request"));
      await flush(10);

      expect(mocks.createCap).toHaveBeenCalledTimes(2);
      expect(mocks.createCap.mock.calls[1]?.[1]?.idempotencyKey).toBe(firstKey);
      expect(document.body.textContent).toContain(
        "Frequency cap saved and confirmed",
      );
      expect(document.body.textContent).not.toContain(
        "Durable original request retained",
      );
    } finally {
      act(() => root.unmount());
    }
  });

  it.each(["removed", "replaced"] as const)(
    "does not replay when another tab has %s the retained durable slot",
    async (change) => {
      mocks.listCaps
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockRejectedValueOnce(new TypeError("connection lost"))
        .mockResolvedValue([]);
      mocks.createCap.mockRejectedValue(new TypeError("connection lost"));
      const root = render(
        createElement(FrequencyCapsPanel, { identity: IDENTITY }),
      );
      try {
        await flush();
        await click(button("Add cap"));
        await setInput(
          document.querySelector<HTMLInputElement>(
            "#frequency-cap-label",
          ) as HTMLInputElement,
          "Marketing",
        );
        await click(button("Create cap"));
        await flush(8);
        await click(button("Verify outcome"));
        await flush(6);

        const storageKey = Object.keys(window.localStorage).find((key) =>
          key.startsWith("postwave:frequency-cap-mutation:v1:"),
        );
        expect(storageKey).toEqual(expect.any(String));
        let expectedStored: string | null = null;
        if (change === "removed") {
          window.localStorage.removeItem(storageKey as string);
        } else {
          const receipt = JSON.parse(
            window.localStorage.getItem(storageKey as string) as string,
          ) as Record<string, unknown>;
          expectedStored = JSON.stringify({
            ...receipt,
            idempotencyKey: "99999999-9999-4999-8999-999999999999",
          });
          window.localStorage.setItem(storageKey as string, expectedStored);
        }

        await click(button("Retry original request"));
        await flush(8);

        expect(mocks.createCap).toHaveBeenCalledTimes(1);
        expect(window.localStorage.getItem(storageKey as string)).toBe(
          expectedStored,
        );
        expect(document.body.textContent).toContain(
          change === "removed"
            ? "was removed by another tab. It was not replayed"
            : "was replaced or changed by another tab. It was not replayed",
        );
        expect(document.body.textContent).toContain(
          "Durable recovery storage unavailable",
        );
      } finally {
        act(() => root.unmount());
      }
    },
  );

  it("restores a durable create receipt after remount and reuses its exact key", async () => {
    let listCalls = 0;
    mocks.listCaps.mockImplementation(async () => {
      listCalls += 1;
      if (listCalls === 3) throw new TypeError("connection lost");
      return mocks.createCap.mock.calls.length >= 2 ? [CREATED_CAP] : [];
    });
    mocks.createCap
      .mockRejectedValueOnce(new TypeError("connection lost"))
      .mockResolvedValueOnce(CREATED_CAP);
    let firstRoot: Root | null = render(
      createElement(FrequencyCapsPanel, { identity: IDENTITY }),
    );
    let restoredRoot: Root | null = null;
    try {
      await flush();
      await click(button("Add cap"));
      await setInput(
        document.querySelector<HTMLInputElement>(
          "#frequency-cap-label",
        ) as HTMLInputElement,
        "Marketing",
      );
      await click(button("Create cap"));
      await flush(8);

      const originalKey = mocks.createCap.mock.calls[0]?.[1]?.idempotencyKey;
      expect(originalKey).toEqual(expect.any(String));
      expect(
        Object.keys(window.localStorage).some((key) =>
          key.startsWith("postwave:frequency-cap-mutation:v1:"),
        ),
      ).toBe(true);

      act(() => firstRoot?.unmount());
      firstRoot = null;
      document.body.innerHTML = "";
      restoredRoot = render(
        createElement(FrequencyCapsPanel, { identity: IDENTITY }),
      );
      await flush(10);

      expect(document.body.textContent).toContain(
        "Durable original request retained",
      );
      await click(button("Retry original request"));
      await flush(10);

      expect(mocks.createCap).toHaveBeenCalledTimes(2);
      expect(mocks.createCap.mock.calls[1]?.[1]?.idempotencyKey).toBe(
        originalKey,
      );
      expect(document.body.textContent).toContain(
        "Frequency cap saved and confirmed",
      );
      expect(
        Object.keys(window.localStorage).some((key) =>
          key.startsWith("postwave:frequency-cap-mutation:v1:"),
        ),
      ).toBe(false);
    } finally {
      if (firstRoot) act(() => firstRoot?.unmount());
      if (restoredRoot) act(() => restoredRoot?.unmount());
    }
  });

  it("fails closed before dispatch when durable receipt storage fails", async () => {
    mocks.listCaps.mockResolvedValue([]);
    const storageWrite = vi
      .spyOn(window.localStorage, "setItem")
      .mockImplementation(() => {
        throw new Error("quota denied");
      });
    const root = render(
      createElement(FrequencyCapsPanel, { identity: IDENTITY }),
    );
    try {
      await flush();
      await click(button("Add cap"));
      await setInput(
        document.querySelector<HTMLInputElement>(
          "#frequency-cap-label",
        ) as HTMLInputElement,
        "Marketing",
      );
      await click(button("Create cap"));
      await flush(8);

      expect(mocks.createCap).not.toHaveBeenCalled();
      expect(document.body.textContent).toContain(
        "Durable recovery storage unavailable",
      );
      expect(button("Add cap").disabled).toBe(true);
    } finally {
      storageWrite.mockRestore();
      act(() => root.unmount());
    }
  });

  it("does not let a stale second tab overwrite or dispatch past another receipt", async () => {
    mocks.listCaps.mockResolvedValue([]);
    mocks.createCap.mockRejectedValue(new TypeError("connection lost"));
    const first = renderWithHost(
      createElement(FrequencyCapsPanel, { identity: IDENTITY }),
    );
    const staleSecond = renderWithHost(
      createElement(FrequencyCapsPanel, { identity: IDENTITY }),
    );
    try {
      await flush();
      await click(button("Add cap", first.host));
      await setInput(
        first.host.querySelector<HTMLInputElement>(
          "#frequency-cap-label",
        ) as HTMLInputElement,
        "First tab",
      );
      await click(button("Add cap", staleSecond.host));
      await setInput(
        staleSecond.host.querySelector<HTMLInputElement>(
          "#frequency-cap-label",
        ) as HTMLInputElement,
        "Stale second tab",
      );

      await click(button("Create cap", first.host));
      await flush(8);
      expect(mocks.createCap).toHaveBeenCalledTimes(1);
      const storageKey = Object.keys(window.localStorage).find((key) =>
        key.startsWith("postwave:frequency-cap-mutation:v1:"),
      );
      expect(storageKey).toEqual(expect.any(String));
      const firstReceipt = window.localStorage.getItem(storageKey as string);
      expect(firstReceipt).toContain('"label":"First tab"');

      await click(button("Create cap", staleSecond.host));
      await flush(8);

      expect(mocks.createCap).toHaveBeenCalledTimes(1);
      expect(window.localStorage.getItem(storageKey as string)).toBe(
        firstReceipt,
      );
      expect(staleSecond.host.textContent).toContain(
        "Another tab already owns a different durable frequency-cap request",
      );
      expect(staleSecond.host.textContent).toContain(
        "Durable recovery storage unavailable",
      );
    } finally {
      act(() => first.root.unmount());
      act(() => staleSecond.root.unmount());
    }
  });

  it("fails closed before mutation dispatch when Web Locks are unavailable", async () => {
    Object.defineProperty(navigator, "locks", {
      configurable: true,
      value: undefined,
    });
    mocks.listCaps.mockResolvedValue([]);
    const root = render(
      createElement(FrequencyCapsPanel, { identity: IDENTITY }),
    );
    try {
      await flush();
      await click(button("Add cap"));
      await setInput(
        document.querySelector<HTMLInputElement>(
          "#frequency-cap-label",
        ) as HTMLInputElement,
        "Marketing",
      );
      await click(button("Create cap"));
      await flush(8);

      expect(mocks.createCap).not.toHaveBeenCalled();
      expect(document.body.textContent).toContain(
        "Cross-tab durable-receipt coordination is unavailable",
      );
    } finally {
      act(() => root.unmount());
    }
  });

  it("blocks replay when an uncertain update has a divergent revision", async () => {
    const divergent = {
      ...CREATED_CAP,
      label: "Changed elsewhere",
      updated_at: "2026-08-30T10:02:00Z",
    };
    mocks.listCaps
      .mockResolvedValueOnce([CREATED_CAP])
      .mockResolvedValueOnce([CREATED_CAP])
      .mockResolvedValueOnce([divergent])
      .mockResolvedValueOnce([divergent]);
    mocks.updateCap.mockRejectedValueOnce(new TypeError("connection lost"));
    const root = render(
      createElement(FrequencyCapsPanel, { identity: IDENTITY }),
    );
    try {
      await flush();
      await click(button("Edit"));
      await setInput(
        document.querySelector<HTMLInputElement>(
          "#frequency-cap-label",
        ) as HTMLInputElement,
        "Transactional",
      );
      await click(button("Save cap"));
      await flush(8);

      expect(document.body.textContent).toContain(
        "automatic replay is blocked",
      );
      expect(
        [...document.querySelectorAll("button")].some(
          (candidate) =>
            candidate.textContent?.trim() === "Retry original request",
        ),
      ).toBe(false);
      await click(button("Verify outcome"));
      await flush(8);

      expect(mocks.updateCap).toHaveBeenCalledTimes(1);
      expect(document.body.textContent).toContain(
        "automatic replay is blocked",
      );
      await click(button("Use refreshed state"));
      expect(document.body.textContent).toContain(
        "Refreshed server state accepted",
      );
    } finally {
      act(() => root.unmount());
    }
  });

  it("reconciles an ambiguous removal from the canonical list", async () => {
    mocks.listCaps
      .mockResolvedValueOnce([CREATED_CAP])
      .mockResolvedValueOnce([CREATED_CAP])
      .mockResolvedValueOnce([]);
    mocks.deleteCap.mockRejectedValueOnce(new TypeError("connection lost"));
    const root = render(
      createElement(FrequencyCapsPanel, { identity: IDENTITY }),
    );
    try {
      await flush();
      await click(button("Remove"));
      const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
      const confirmation = dialog?.querySelector<HTMLInputElement>("input");
      await setInput(confirmation as HTMLInputElement, "REMOVE CAP");
      await click(button("Remove cap", dialog as HTMLElement));
      await flush(8);

      expect(mocks.deleteCap).toHaveBeenCalledTimes(1);
      expect(document.body.textContent).toContain(
        "Frequency cap removed and confirmed",
      );
      expect(document.body.textContent).not.toContain(
        "Durable original request retained",
      );
    } finally {
      act(() => root.unmount());
    }
  });

  it("updates and removes caps with the freshly verified server revision", async () => {
    const updated = {
      ...CREATED_CAP,
      label: "Transactional",
      updated_at: "2026-08-30T10:02:00Z",
    };
    mocks.listCaps
      .mockResolvedValueOnce([CREATED_CAP])
      .mockResolvedValueOnce([CREATED_CAP])
      .mockResolvedValueOnce([updated])
      .mockResolvedValueOnce([updated])
      .mockResolvedValueOnce([]);
    mocks.updateCap.mockResolvedValue(updated);
    mocks.deleteCap.mockResolvedValue(undefined);
    const root = render(
      createElement(FrequencyCapsPanel, { identity: IDENTITY }),
    );
    try {
      await flush();
      await click(button("Edit"));
      await setInput(
        document.querySelector<HTMLInputElement>(
          "#frequency-cap-label",
        ) as HTMLInputElement,
        "Transactional",
      );
      await click(button("Save cap"));
      await flush(8);

      expect(mocks.updateCap).toHaveBeenCalledWith(
        CREATED_CAP.id,
        {
          label: "Transactional",
          max_sends: 3,
          window_hours: 24,
          active: true,
        },
        CREATED_CAP.updated_at,
        { idempotencyKey: expect.any(String) },
      );

      await click(button("Remove"));
      const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
      expect(dialog).toBeTruthy();
      const confirmation = dialog?.querySelector<HTMLInputElement>("input");
      await setInput(confirmation as HTMLInputElement, "REMOVE CAP");
      await click(button("Remove cap", dialog as HTMLElement));
      await flush(8);

      expect(mocks.deleteCap).toHaveBeenCalledWith(
        CREATED_CAP.id,
        updated.updated_at,
        { idempotencyKey: expect.any(String) },
      );
      expect(document.body.textContent).toContain(
        "Frequency cap removed and confirmed",
      );
    } finally {
      act(() => root.unmount());
    }
  });

  it("does not request or render admin-only cap policy in viewer mode", async () => {
    const root = render(
      createElement(FrequencyCapsPanel, {
        identity: { ...IDENTITY, viewer_mode: true },
      }),
    );
    try {
      await flush();
      expect(mocks.listCaps).not.toHaveBeenCalled();
      expect(document.body.textContent).not.toContain("Loading frequency caps");
      expect(document.body.textContent).toContain(
        "Owner or admin access is required",
      );
    } finally {
      act(() => root.unmount());
    }
  });
});

function render(node: ReactNode): Root {
  return renderWithHost(node).root;
}

function renderWithHost(node: ReactNode): { root: Root; host: HTMLElement } {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  act(() => {
    root.render(createElement(QueryClientProvider, { client }, node));
  });
  return { root, host };
}

function installTestWebLocks(): void {
  const tails = new Map<string, Promise<void>>();
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: {
      request: vi.fn(
        async (
          name: string,
          _options: LockOptions,
          callback: (lock: Lock) => unknown,
        ) => {
          const previous = tails.get(name) ?? Promise.resolve();
          let release = (): void => undefined;
          const current = new Promise<void>((resolve) => {
            release = resolve;
          });
          tails.set(
            name,
            previous.then(() => current),
          );
          await previous;
          try {
            return await callback({ name, mode: "exclusive" });
          } finally {
            release();
          }
        },
      ),
    },
  });
}

async function flush(times = 4): Promise<void> {
  await act(async () => {
    for (let index = 0; index < times; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  });
}

function button(label: string, root: ParentNode = document): HTMLButtonElement {
  const found = [...root.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
}

async function click(target: HTMLButtonElement): Promise<void> {
  await act(async () => {
    target.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function clickInput(target: HTMLInputElement): Promise<void> {
  await act(async () => {
    target.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function setInput(
  target: HTMLInputElement,
  value: string,
): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )?.set;
  await act(async () => {
    setter?.call(target, value);
    target.dispatchEvent(new Event("input", { bubbles: true }));
    target.dispatchEvent(new Event("change", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}
