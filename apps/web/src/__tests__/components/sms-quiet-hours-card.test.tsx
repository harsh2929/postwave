// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  list: vi.fn(),
  remove: vi.fn(),
  update: vi.fn(),
  whoami: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("@/lib/auth-api", () => ({
  effectiveAuthRole: (profile: { effective_role?: string }) =>
    profile.effective_role,
  whoami: mocks.whoami,
}));
vi.mock("@/lib/sms-scheduling-api", () => ({
  createSmsQuietHours: mocks.create,
  deleteSmsQuietHours: mocks.remove,
  listSmsQuietHours: mocks.list,
  updateSmsQuietHours: mocks.update,
}));
vi.mock("sonner", () => ({
  toast: { error: mocks.toastError, success: mocks.toastSuccess },
}));

import { SmsQuietHoursCard } from "@/app/(dashboard)/app/sms/sms-quiet-hours-card";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const TENANT = "22222222-2222-4222-8222-222222222222";
const USER = "11111111-1111-4111-8111-111111111111";
const roots: Root[] = [];

function row(over: Record<string, unknown> = {}) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    tenant_id: TENANT,
    label: "Customer local night",
    country_code: "" as const,
    start_minute: 1260,
    end_minute: 540,
    start_local: "21:00",
    end_local: "09:00",
    days: [1, 2, 3, 4, 5],
    timezone: "America/New_York",
    enabled: true,
    created_at: "2026-08-21T09:00:00Z",
    updated_at: "2026-08-21T09:00:00Z",
    ...over,
  };
}

beforeEach(() => {
  mocks.create.mockReset().mockResolvedValue(
    row({
      id: "33333333-3333-4333-8333-333333333333",
      label: "",
      days: [0, 1, 2, 3, 4, 5, 6],
      timezone: "UTC",
    }),
  );
  mocks.list.mockReset().mockResolvedValue([
    row(),
    row({
      id: "44444444-4444-4444-8444-444444444444",
      label: "Historical scope",
      country_code: "US",
    }),
  ]);
  mocks.remove.mockReset().mockResolvedValue({
    ok: true,
    tenantId: TENANT,
    id: row().id,
  });
  mocks.update
    .mockReset()
    .mockImplementation(
      async (id: string, input: Record<string, unknown>, _version: string) =>
        row({
          id,
          ...input,
          start_local:
            input.start_minute === undefined
              ? "21:00"
              : `${String(Math.floor(Number(input.start_minute) / 60)).padStart(2, "0")}:${String(Number(input.start_minute) % 60).padStart(2, "0")}`,
          end_local:
            input.end_minute === undefined
              ? "09:00"
              : `${String(Math.floor(Number(input.end_minute) / 60)).padStart(2, "0")}:${String(Number(input.end_minute) % 60).padStart(2, "0")}`,
          updated_at: "2026-08-21T09:00:00.000001Z",
        }),
    );
  mocks.whoami.mockReset().mockResolvedValue({
    tenant_id: TENANT,
    user_id: USER,
    effective_role: "admin",
    viewer_mode: false,
  });
  mocks.toastError.mockReset();
  mocks.toastSuccess.mockReset();
});

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await act(async () => root.unmount());
  }
  document.body.innerHTML = "";
});

async function eventually(assertion: () => void): Promise<void> {
  let error: unknown;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      assertion();
      return;
    } catch (next) {
      error = next;
      await act(async () => {
        await Promise.resolve();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
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

async function renderCard() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <SmsQuietHoursCard
          baseKey={["sms", TENANT, "admin", USER]}
          enabled
          tenantId={TENANT}
          userId={USER}
        />
      </QueryClientProvider>,
    );
  });
  await eventually(() => expect(mocks.list).toHaveBeenCalledTimes(1));
  return { client, container };
}

describe("SmsQuietHoursCard", () => {
  it("renders window semantics and atomically retires a historical scope", async () => {
    const { container } = await renderCard();
    await eventually(() => {
      expect(container.textContent).toContain("21:00–09:00 · overnight");
      expect(container.textContent).toContain("Weekdays");
      expect(container.textContent).toContain("Legacy US scope · fail closed");
      expect(buttons("Retire legacy scope")[0]?.disabled).toBe(false);
    });

    await act(async () => buttons("Retire legacy scope")[0]?.click());
    await eventually(() =>
      expect(buttons("Clear scope and disable")).toHaveLength(1),
    );
    await act(async () => {
      buttons("Clear scope and disable")[0]?.click();
      await Promise.resolve();
    });
    await eventually(() => expect(mocks.update).toHaveBeenCalledTimes(1));
    expect(mocks.update).toHaveBeenCalledWith(
      "44444444-4444-4444-8444-444444444444",
      expect.objectContaining({ country_code: "", enabled: false }),
      "2026-08-21T09:00:00Z",
      TENANT,
      expect.any(AbortSignal),
    );
    expect(mocks.whoami).toHaveBeenCalledTimes(2);
  });

  it("creates the default tenant-wide policy only after reauthorization", async () => {
    await renderCard();
    await eventually(() =>
      expect(buttons("Add window")[0]?.disabled).toBe(false),
    );
    await act(async () => buttons("Add window")[0]?.click());
    await eventually(() => expect(buttons("Add window")).toHaveLength(2));
    await act(async () => {
      buttons("Add window").at(-1)?.click();
      await Promise.resolve();
    });
    await eventually(() => expect(mocks.create).toHaveBeenCalledTimes(1));
    expect(mocks.create).toHaveBeenCalledWith(
      {
        label: "",
        country_code: "",
        start_minute: 1260,
        end_minute: 540,
        days: [0, 1, 2, 3, 4, 5, 6],
        timezone: "UTC",
        enabled: true,
      },
      TENANT,
      expect.any(AbortSignal),
    );
    expect(mocks.whoami).toHaveBeenCalledTimes(2);
  });

  it("fails closed on an unverified inventory and never exposes create", async () => {
    mocks.list.mockRejectedValueOnce(new Error("unsafe proxy detail"));
    const { container } = await renderCard();
    await eventually(() => {
      expect(container.textContent).toContain(
        "complete SMS quiet-hours inventory could not be verified",
      );
      expect(buttons("Add window")[0]?.disabled).toBe(true);
    });
    expect(container.textContent).not.toContain(
      "No stored quiet-hours windows",
    );
    expect(container.textContent).not.toContain("unsafe proxy detail");
  });

  it("treats a CAS refusal as a known no-commit outcome and refreshes", async () => {
    mocks.update.mockRejectedValueOnce(
      Object.assign(new Error("unsafe conflict detail"), { status: 409 }),
    );
    const { container } = await renderCard();
    let toggle: HTMLInputElement | null = null;
    await eventually(() => {
      toggle = container.querySelector<HTMLInputElement>(
        'input[aria-label="Disable Customer local night"]',
      );
      expect(toggle?.disabled).toBe(false);
    });
    await act(async () => toggle?.click());
    await eventually(() => expect(buttons("Disable gate")).toHaveLength(1));
    await act(async () => {
      buttons("Disable gate")[0]?.click();
      await Promise.resolve();
    });
    await eventually(() =>
      expect(mocks.toastError).toHaveBeenCalledWith(
        "Could not update quiet-hours policy",
        expect.objectContaining({
          description: expect.stringContaining("no change was committed"),
        }),
      ),
    );
    await eventually(() =>
      expect(mocks.list.mock.calls.length).toBeGreaterThan(1),
    );
    expect(JSON.stringify(mocks.toastError.mock.calls)).not.toContain(
      "unsafe conflict detail",
    );
  });

  it("does not send a write when authority changed before confirmation", async () => {
    mocks.whoami.mockResolvedValueOnce({
      tenant_id: TENANT,
      user_id: USER,
      effective_role: "viewer",
      viewer_mode: true,
    });
    await renderCard();
    await eventually(() =>
      expect(buttons("Add window")[0]?.disabled).toBe(false),
    );
    await act(async () => buttons("Add window")[0]?.click());
    await eventually(() => expect(buttons("Add window")).toHaveLength(2));
    await act(async () => {
      buttons("Add window").at(-1)?.click();
      await Promise.resolve();
    });
    await eventually(() =>
      expect(document.body.textContent).toContain(
        "Reauthorization failed before the write request",
      ),
    );
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("edits a stored window and sends the full draft with the row revision", async () => {
    await renderCard();
    const edit = () =>
      document.querySelector<HTMLButtonElement>(
        'button[aria-label="Edit Customer local night"]',
      );
    await eventually(() => expect(edit()?.disabled).toBe(false));
    await act(async () => edit()?.click());
    await eventually(() => expect(buttons("Save changes")).toHaveLength(1));

    const start = document.querySelector<HTMLInputElement>("#sms-quiet-start")!;
    expect(start.value).toBe("21:00");
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      )?.set;
      setter?.call(start, "22:30");
      start.dispatchEvent(new Event("input", { bubbles: true }));
      start.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => {
      buttons("Save changes")[0]?.click();
      await Promise.resolve();
    });
    await eventually(() => expect(mocks.update).toHaveBeenCalledTimes(1));
    expect(mocks.update).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      {
        label: "Customer local night",
        country_code: "",
        start_minute: 1350,
        end_minute: 540,
        days: [1, 2, 3, 4, 5],
        timezone: "America/New_York",
        enabled: true,
      },
      "2026-08-21T09:00:00Z",
      TENANT,
      expect.any(AbortSignal),
    );
    await eventually(() =>
      expect(mocks.toastSuccess).toHaveBeenCalledWith(
        "Quiet-hours window updated",
      ),
    );
    await eventually(() => expect(buttons("Save changes")).toHaveLength(0));
    expect(mocks.whoami).toHaveBeenCalledTimes(2);
  });

  it("deletes a window only after a confirm that names the stored-policy consequence", async () => {
    await renderCard();
    const trigger = () =>
      document.querySelector<HTMLButtonElement>(
        'button[aria-label="Delete Customer local night"]',
      );
    await eventually(() => expect(trigger()?.disabled).toBe(false));
    await act(async () => trigger()?.click());
    await eventually(() => expect(buttons("Delete window")).toHaveLength(1));
    const dialog = document.querySelector('[role="alertdialog"], [role="dialog"]');
    expect(dialog?.textContent).toContain(
      "Delete “Customer local night” (21:00–09:00 · overnight America/New_York)?",
    );
    expect(dialog?.textContent).toContain(
      "deletes a stored gate policy only and makes no claim about live dispatch or delivery",
    );
    expect(mocks.remove).not.toHaveBeenCalled();

    await act(async () => {
      buttons("Delete window")[0]?.click();
      await Promise.resolve();
    });
    await eventually(() => expect(mocks.remove).toHaveBeenCalledTimes(1));
    expect(mocks.remove).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      "2026-08-21T09:00:00Z",
      TENANT,
      expect.any(AbortSignal),
    );
    await eventually(() =>
      expect(mocks.toastSuccess).toHaveBeenCalledWith(
        "Quiet-hours window deleted",
      ),
    );
    await eventually(() =>
      expect(mocks.list.mock.calls.length).toBeGreaterThan(1),
    );
  });
});
