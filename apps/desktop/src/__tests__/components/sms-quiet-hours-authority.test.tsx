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
  canAdmin: true,
  me: {
    user: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    tenant: "00000000-0000-0000-0000-000000000001",
    role: "admin",
    effectiveRole: "admin",
  },
  list: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("../../lib/store", () => ({
  useCanAdmin: () => mocks.canAdmin,
  useMe: () => mocks.me,
}));

vi.mock("../../lib/api-client", () => ({
  SENDING_TIMEZONES: [{ value: "Etc/UTC", label: "UTC" }],
  smsQuietHoursApi: {
    list: mocks.list,
    create: mocks.create,
    update: mocks.update,
    remove: mocks.remove,
  },
}));

vi.mock("../../components/Toast", () => ({
  toast: { error: mocks.toastError, success: mocks.toastSuccess },
}));

import { SmsQuietHoursCard } from "../../components/sms/SmsQuietHoursCard";

const row = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  tenant_id: "00000000-0000-0000-0000-000000000001",
  label: "Synthetic overnight gate",
  country_code: "",
  start_minute: 1260,
  end_minute: 540,
  start_local: "21:00",
  end_local: "09:00",
  days: [0, 1, 2, 3, 4, 5, 6],
  timezone: "Etc/UTC",
  enabled: true,
  created_at: "2026-08-20T12:00:00Z",
  updated_at: "2026-08-20T12:00:00Z",
};
const UPDATED_AT = "2026-08-20T12:01:00Z";

function listData<T>(items: T[]) {
  return { tenantId: mocks.me.tenant, items };
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.canAdmin = true;
  mocks.me = {
    user: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    tenant: "00000000-0000-0000-0000-000000000001",
    role: "admin",
    effectiveRole: "admin",
  };
  mocks.list.mockResolvedValue({ data: listData([row]) });
  mocks.update.mockResolvedValue({
    data: { ...row, enabled: false, updated_at: UPDATED_AT },
  });
  mocks.remove.mockResolvedValue({
    data: { ok: true, tenantId: mocks.me.tenant, id: row.id },
  });
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
});

function renderCard(): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(<SmsQuietHoursCard />));
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("SMS quiet-hours stored-policy authority", () => {
  it("labels hosted effects as held and renders a tenant-bound row accessibly", async () => {
    renderCard();
    await settle();

    expect(document.body.textContent).toContain(
      "this is not evidence of a scheduled, sent, or delivered message",
    );
    expect(document.body.textContent).toContain("Synthetic overnight gate");
    expect(document.body.textContent).not.toContain("sent automatically");
    expect(
      document.querySelector<HTMLButtonElement>("button.btn-primary")?.disabled,
    ).toBe(false);
    const result = await axe.run(container ?? document.body, {
      rules: { region: { enabled: false } },
    });
    expect(
      result.violations.filter((violation) =>
        ["serious", "critical"].includes(violation.impact ?? ""),
      ),
    ).toEqual([]);
  });

  it("rejects a cross-tenant 2xx page and never echoes proxy detail", async () => {
    mocks.list.mockResolvedValue({
      data: {
        tenantId: mocks.me.tenant,
        items: [
          {
            ...row,
            tenant_id: "00000000-0000-0000-0000-000000000002",
          },
        ],
      },
      error: undefined,
    });
    renderCard();
    await settle();

    expect(document.body.textContent).toContain(
      "failed its private tenant and row contract",
    );
    expect(document.body.textContent).not.toContain("Synthetic overnight gate");
    const add = document.querySelector<HTMLButtonElement>("button.btn-primary");
    expect(add?.disabled).toBe(false);
    expect(add?.getAttribute("aria-disabled")).toBe("true");
    act(() => add?.click());
    expect(document.querySelector('[role="dialog"]')).toBeNull();

    mocks.list.mockResolvedValueOnce({
      error: { status: 502, message: "SECRET provider/proxy detail" },
    });
    const retry = Array.from(document.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Retry",
    );
    act(() => retry?.click());
    await settle();
    expect(document.body.textContent).not.toContain(
      "SECRET provider/proxy detail",
    );
  });

  it("rejects a cross-tenant toggle receipt without changing verified state", async () => {
    mocks.update.mockResolvedValue({
      data: {
        ...row,
        tenant_id: "00000000-0000-0000-0000-000000000002",
        enabled: false,
        updated_at: UPDATED_AT,
      },
    });
    renderCard();
    await settle();
    const toggle = document.querySelector<HTMLInputElement>(
      'input[aria-label="Synthetic overnight gate enabled"]',
    );
    expect(toggle?.checked).toBe(true);
    act(() => toggle?.focus());
    act(() => toggle?.click());
    await settle();

    expect(mocks.update).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain(
      "Disable quiet-hours gate policy?",
    );
    const add = Array.from(document.querySelectorAll("button")).find(
      (candidate) => candidate.textContent?.trim() === "Add window",
    );
    expect(add?.disabled).toBe(false);
    expect(add?.getAttribute("aria-disabled")).toBe("true");
    act(() => add?.click());
    expect(document.body.textContent).toContain(
      "Disable quiet-hours gate policy?",
    );
    const cancel = Array.from(document.querySelectorAll("button")).find(
      (candidate) => candidate.textContent?.trim() === "Cancel",
    );
    act(() => cancel?.click());
    await settle();
    expect(document.activeElement).toBe(toggle);

    act(() => toggle?.click());
    await settle();
    const confirm = Array.from(document.querySelectorAll("button")).find(
      (candidate) => candidate.textContent?.trim() === "Disable gate policy",
    );
    act(() => confirm?.click());
    await settle();

    expect(mocks.update).toHaveBeenCalledTimes(1);
    expect(mocks.update.mock.calls[0]?.[1]).toEqual({
      enabled: false,
      expected_updated_at: row.updated_at,
    });
    expect(mocks.update.mock.calls[0]?.[2]?.signal).toBeInstanceOf(AbortSignal);
    expect(toggle?.checked).toBe(true);
    expect(mocks.toastError).toHaveBeenCalledWith({
      message: "Window update outcome unverified",
      detail:
        "The service returned an unverified policy receipt. Refresh this exact row before retrying; do not assume nothing changed.",
    });
  });

  it("treats a generic toggle failure as outcome unverified", async () => {
    mocks.update.mockResolvedValueOnce({
      error: { status: 503, message: "SECRET proxy detail" },
    });
    renderCard();
    await settle();
    const toggle = document.querySelector<HTMLInputElement>(
      'input[aria-label="Synthetic overnight gate enabled"]',
    );
    act(() => toggle?.click());
    await settle();
    const confirm = Array.from(document.querySelectorAll("button")).find(
      (candidate) => candidate.textContent?.trim() === "Disable gate policy",
    );
    act(() => confirm?.click());
    await settle();

    expect(mocks.toastError).toHaveBeenCalledWith({
      message: "Window update outcome unverified",
      detail:
        "The quiet-hours policy change outcome is unverified. Refresh the current policy list and exact row, if present, before retrying; do not assume nothing changed.",
    });
    expect(document.body.textContent).not.toContain("SECRET proxy detail");
  });

  it("keeps enabled-to-disabled changes behind the row confirmation when editing", async () => {
    renderCard();
    await settle();
    const edit = Array.from(document.querySelectorAll("button")).find(
      (candidate) => candidate.textContent?.trim() === "Edit",
    );
    act(() => edit?.click());
    await settle();
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain("Status is unchanged in this editor");
    expect(
      dialog?.querySelector(
        'input[aria-label="Create quiet-hours policy enabled"]',
      ),
    ).toBeNull();
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("requires the confirmed disable workflow before repairing an enabled legacy country scope", async () => {
    const scoped = { ...row, country_code: "US" };
    mocks.list.mockResolvedValue({ data: listData([scoped]) });
    mocks.update.mockResolvedValue({
      data: {
        ...scoped,
        country_code: "",
        enabled: false,
        updated_at: UPDATED_AT,
      },
    });
    renderCard();
    await settle();
    expect(document.body.textContent).toContain(
      "Legacy US metadata · gate-invalid/fail-closed",
    );

    const edit = Array.from(document.querySelectorAll("button")).find(
      (candidate) => candidate.textContent?.trim() === "Edit",
    );
    act(() => edit?.click());
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(mocks.toastError).toHaveBeenCalledWith({
      message: "Disable before repairing legacy scope",
      detail: expect.stringContaining("fail-closed"),
    });

    const toggle = document.querySelector<HTMLInputElement>(
      'input[aria-label="Synthetic overnight gate enabled"]',
    );
    act(() => toggle?.click());
    await settle();
    act(() =>
      Array.from(document.querySelectorAll("button"))
        .find((candidate) => candidate.textContent?.trim() === "Cancel")
        ?.click(),
    );
    await settle();
    expect(mocks.update).not.toHaveBeenCalled();

    act(() => toggle?.click());
    await settle();
    act(() =>
      Array.from(document.querySelectorAll("button"))
        .find(
          (candidate) =>
            candidate.textContent?.trim() === "Disable gate policy",
        )
        ?.click(),
    );
    await settle();
    expect(mocks.update.mock.calls[0]?.[1]).toEqual({
      enabled: false,
      country_code: "",
      expected_updated_at: scoped.updated_at,
    });
    expect(document.body.textContent).not.toContain("Legacy US metadata");
  });

  it("repairs only a disabled legacy country scope with an explicit CAS payload", async () => {
    const scoped = { ...row, country_code: "US", enabled: false };
    const repaired = {
      ...scoped,
      country_code: "",
      updated_at: UPDATED_AT,
    };
    mocks.list
      .mockResolvedValueOnce({ data: listData([scoped]) })
      .mockResolvedValueOnce({ data: listData([repaired]) });
    mocks.update.mockResolvedValue({ data: repaired });
    renderCard();
    await settle();
    expect(document.body.textContent).toContain(
      "Unsupported legacy US scope · repair before enabling",
    );
    const edit = Array.from(document.querySelectorAll("button")).find(
      (candidate) => candidate.textContent?.trim() === "Edit",
    );
    act(() => edit?.click());
    await settle();
    expect(document.body.textContent).toContain(
      "Saving clears that unsupported value before the tenant-wide rule can be enabled",
    );
    const save = Array.from(document.querySelectorAll("button")).find(
      (candidate) => candidate.textContent?.trim() === "Save changes",
    );
    act(() => save?.click());
    await settle();

    expect(mocks.update.mock.calls[0]?.[1]).toEqual({
      label: scoped.label,
      country_code: "",
      start_minute: scoped.start_minute,
      end_minute: scoped.end_minute,
      days: scoped.days,
      timezone: scoped.timezone,
      enabled: false,
      expected_updated_at: scoped.updated_at,
    });
  });

  it("sends the row CAS token and refreshes without overwriting on a stale toggle", async () => {
    mocks.list
      .mockResolvedValueOnce({ data: listData([row]) })
      .mockResolvedValueOnce({
        data: {
          tenantId: mocks.me.tenant,
          items: [
            {
              ...row,
              label: "Concurrent overnight gate",
              updated_at: UPDATED_AT,
            },
          ],
        },
      });
    mocks.update.mockResolvedValue({
      error: {
        status: 409,
        code: "policy_changed",
        message: "SECRET stale backend detail",
      },
    });
    renderCard();
    await settle();
    const toggle = document.querySelector<HTMLInputElement>(
      'input[aria-label="Synthetic overnight gate enabled"]',
    );
    act(() => toggle?.click());
    await settle();
    const confirm = Array.from(document.querySelectorAll("button")).find(
      (candidate) => candidate.textContent?.trim() === "Disable gate policy",
    );
    act(() => confirm?.click());
    await settle();

    expect(mocks.update.mock.calls[0]?.[1]).toEqual({
      enabled: false,
      expected_updated_at: row.updated_at,
    });
    expect(mocks.list).toHaveBeenCalledTimes(2);
    expect(document.body.textContent).toContain("Concurrent overnight gate");
    expect(document.body.textContent).not.toContain(
      "SECRET stale backend detail",
    );
  });

  it("tenant-binds delete with the row CAS token and restores cancel focus", async () => {
    renderCard();
    await settle();
    const trigger = Array.from(document.querySelectorAll("button")).find(
      (candidate) => candidate.textContent?.trim() === "Delete",
    );
    if (!trigger) throw new Error("Missing quiet-hours delete control");
    act(() => trigger.focus());
    act(() => trigger.click());
    await settle();
    const add = Array.from(document.querySelectorAll("button")).find(
      (candidate) => candidate.textContent?.trim() === "Add window",
    );
    expect(add?.disabled).toBe(false);
    expect(add?.getAttribute("aria-disabled")).toBe("true");
    act(() => add?.click());
    expect(document.body.textContent).toContain("Delete quiet-hours window?");
    act(() =>
      Array.from(document.querySelectorAll("button"))
        .find((candidate) => candidate.textContent?.trim() === "Cancel")
        ?.click(),
    );
    await settle();
    expect(document.activeElement).toBe(trigger);

    act(() => trigger.click());
    await settle();
    act(() =>
      Array.from(document.querySelectorAll("button"))
        .find((candidate) => candidate.textContent?.trim() === "Delete window")
        ?.click(),
    );
    await settle();
    expect(mocks.remove).toHaveBeenCalledWith(
      row.id,
      { expected_updated_at: row.updated_at },
      { signal: expect.any(AbortSignal) },
    );
  });

  it("reports an identity-retired policy mutation as outcome unknown", async () => {
    mocks.update.mockResolvedValue({
      error: {
        code: "identity_changed",
        message: "SECRET response after possible commit",
      },
    });
    renderCard();
    await settle();
    act(() =>
      document
        .querySelector<HTMLInputElement>(
          'input[aria-label="Synthetic overnight gate enabled"]',
        )
        ?.click(),
    );
    await settle();
    act(() =>
      Array.from(document.querySelectorAll("button"))
        .find(
          (candidate) =>
            candidate.textContent?.trim() === "Disable gate policy",
        )
        ?.click(),
    );
    await settle();
    expect(mocks.toastError).toHaveBeenCalledWith({
      message: "Window outcome unknown",
      detail: expect.stringContaining("original workspace"),
    });
    expect(document.body.textContent).not.toContain(
      "SECRET response after possible commit",
    );
  });

  it("aborts private list and mutation requests on identity teardown", async () => {
    let resolveList!: (value: {
      data: { tenantId: string; items: (typeof row)[] };
    }) => void;
    const pendingList = new Promise<{
      data: { tenantId: string; items: (typeof row)[] };
    }>((resolve) => {
      resolveList = resolve;
    });
    mocks.list.mockReturnValue(pendingList);
    renderCard();
    await settle();
    const listSignal = mocks.list.mock.calls[0]?.[0]?.signal as
      | AbortSignal
      | undefined;
    expect(listSignal).toBeInstanceOf(AbortSignal);
    act(() => root?.unmount());
    root = null;
    expect(listSignal?.aborted).toBe(true);
    resolveList({ data: listData([row]) });
    await settle();

    mocks.list.mockResolvedValue({ data: listData([row]) });
    let resolveUpdate!: (value: { data: typeof row }) => void;
    const pendingUpdate = new Promise<{ data: typeof row }>((resolve) => {
      resolveUpdate = resolve;
    });
    mocks.update.mockReturnValue(pendingUpdate);
    renderCard();
    await settle();
    const toggle = document.querySelector<HTMLInputElement>(
      'input[aria-label="Synthetic overnight gate enabled"]',
    );
    act(() => toggle?.click());
    await settle();
    const confirm = Array.from(document.querySelectorAll("button")).find(
      (candidate) => candidate.textContent?.trim() === "Disable gate policy",
    );
    act(() => confirm?.click());
    await settle();
    const mutationSignal = mocks.update.mock.calls[0]?.[2]?.signal as
      | AbortSignal
      | undefined;
    expect(mutationSignal).toBeInstanceOf(AbortSignal);
    act(() => root?.unmount());
    root = null;
    expect(mutationSignal?.aborted).toBe(true);
    resolveUpdate({
      data: { ...row, enabled: false, updated_at: UPDATED_AT },
    });
    await settle();
    expect(mocks.toastError).not.toHaveBeenCalled();
  });
});
