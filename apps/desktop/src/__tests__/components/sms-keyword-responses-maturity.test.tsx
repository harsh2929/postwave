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
  toastSuccess: vi.fn(),
}));

vi.mock("../../lib/store", () => ({
  useCanAdmin: () => mocks.canAdmin,
  useMe: () => mocks.me,
}));
vi.mock("../../lib/api/sms-keyword-responses", () => ({
  smsKeywordResponsesApi: {
    list: mocks.list,
    create: mocks.create,
    update: mocks.update,
    remove: mocks.remove,
  },
}));
vi.mock("../../components/Toast", () => ({
  toast: { success: mocks.toastSuccess },
}));

import { SmsKeywordResponsesCard } from "../../components/sms/SmsKeywordResponsesCard";

const row = {
  id: "11111111-1111-4111-8111-111111111111",
  tenant_id: "00000000-0000-0000-0000-000000000001",
  keyword: "PRICING",
  response_body:
    "Thanks for asking. Read the complete pricing guide at https://example.test/pricing and reply with questions.",
  response_text:
    "Thanks for asking. Read the complete pricing guide at https://example.test/pricing and reply with questions.",
  action: "reply_only" as const,
  enabled: true,
  autoReplyDispatchAvailable: false,
  autoReplyDispatchUnavailableReason:
    "sms_auto_reply_dispatch_release_held" as const,
  opt_in_count: 0,
  created_at: "2026-07-01T00:00:00Z",
  updated_at: "2026-07-01T00:00:00Z",
};

const optOutRow = {
  ...row,
  id: "22222222-2222-4222-8222-222222222222",
  keyword: "LEAVE",
  action: "opt_out" as const,
};
const UPDATED_AT = "2026-07-01T00:01:00Z";

function listData<T>(items: T[]) {
  return { tenantId: mocks.me.tenant, items };
}

const legacyOptInRow = {
  ...row,
  id: "33333333-3333-4333-8333-333333333333",
  keyword: "JOIN",
  action: "opt_in" as const,
  enabled: true,
};

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  mocks.canAdmin = true;
  mocks.me = {
    user: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    tenant: "00000000-0000-0000-0000-000000000001",
    role: "admin",
    effectiveRole: "admin",
  };
  vi.clearAllMocks();
  mocks.list.mockResolvedValue({ data: listData([row]) });
  mocks.create.mockResolvedValue({ data: row });
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
  act(() => root?.render(<SmsKeywordResponsesCard />));
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function waitFor(assertion: () => void): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await flush();
    }
  }
  throw lastError;
}

function button(label: string): HTMLButtonElement {
  const found = Array.from(document.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!(found instanceof HTMLButtonElement)) {
    throw new Error(`Missing button: ${label}`);
  }
  return found;
}

function dialogButton(label: string): HTMLButtonElement {
  const dialog = document.querySelector('[role="dialog"]');
  const found = Array.from(dialog?.querySelectorAll("button") ?? []).find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!(found instanceof HTMLButtonElement)) {
    throw new Error(`Missing dialog button: ${label}`);
  }
  return found;
}

function setControl(
  control: HTMLInputElement | HTMLTextAreaElement,
  value: string,
): void {
  const prototype =
    control instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  act(() => {
    Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(
      control,
      value,
    );
    control.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("SmsKeywordResponsesCard maturity", () => {
  it("rejects legacy custom opt-in projections before rendering mutation controls", async () => {
    mocks.list.mockResolvedValue({ data: listData([legacyOptInRow]) });
    renderCard();
    await waitFor(() =>
      expect(document.body.textContent).toContain(
        "failed its private tenant and row contract",
      ),
    );

    expect(document.body.textContent).not.toContain("Legacy opt-in disabled");
    expect(document.querySelector('input[type="checkbox"]')).toBeNull();
    await flush();
    expect(mocks.update).not.toHaveBeenCalled();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("renders full provider truth and focusable viewer guards without title debt", async () => {
    mocks.canAdmin = false;
    renderCard();
    await waitFor(() =>
      expect(document.body.textContent).toContain(row.response_body),
    );

    expect(document.body.textContent).toContain(
      "sms_auto_reply_dispatch_release_held",
    );
    expect(document.body.textContent).toContain(row.response_body);
    expect(button("Add opt-out keyword").disabled).toBe(true);
    expect(button("Edit").disabled).toBe(true);
    expect(button("Edit").getAttribute("aria-disabled")).toBe("true");
    const checkbox = document.querySelector<HTMLInputElement>(
      'input[type="checkbox"]',
    );
    expect(checkbox?.disabled).toBe(true);
    expect(checkbox?.getAttribute("aria-disabled")).toBe("true");
    expect(document.querySelector("[title]")).toBeNull();

    act(() => {
      button("Add opt-out keyword").click();
      button("Edit").click();
      checkbox?.click();
    });
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
    expect(document.querySelector('[role="dialog"]')).toBeNull();

    const result = await axe.run(container ?? document.body, {
      rules: { region: { enabled: false } },
    });
    expect(
      result.violations.filter((violation) =>
        ["serious", "critical"].includes(violation.impact ?? ""),
      ),
    ).toEqual([]);
  });

  it("confirms safety-reducing status toggles, restores focus, and renders verified state", async () => {
    mocks.list.mockResolvedValue({ data: listData([optOutRow]) });
    let resolve!: (value: { data: typeof optOutRow }) => void;
    const pending = new Promise<{ data: typeof optOutRow }>((done) => {
      resolve = done;
    });
    mocks.update.mockReturnValue(pending);
    renderCard();
    await waitFor(() =>
      expect(
        document.querySelector<HTMLInputElement>('input[type="checkbox"]'),
      ).not.toBeNull(),
    );
    const checkbox = document.querySelector<HTMLInputElement>(
      'input[type="checkbox"]',
    );
    if (!checkbox) throw new Error("Missing keyword status checkbox");

    act(() => checkbox.focus());
    act(() => checkbox.click());
    await flush();
    expect(mocks.update).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain(
      "Disable keyword opt-out rule?",
    );
    expect(button("Add opt-out keyword").disabled).toBe(true);
    expect(button("Edit").disabled).toBe(true);
    expect(button("Delete").disabled).toBe(true);
    act(() => button("Cancel").click());
    await flush();
    expect(document.activeElement).toBe(checkbox);

    act(() => checkbox.click());
    await flush();
    act(() => button("Disable opt-out rule").click());
    await flush();
    expect(mocks.update).toHaveBeenCalledTimes(1);
    expect(mocks.update).toHaveBeenCalledWith(
      optOutRow.id,
      {
        action: "opt_out",
        enabled: false,
        expected_updated_at: optOutRow.updated_at,
      },
      { signal: expect.any(AbortSignal) },
    );
    expect(document.body.textContent).toContain("Updating status");

    await act(async () => {
      resolve({
        data: { ...optOutRow, enabled: false, updated_at: UPDATED_AT },
      });
      await pending;
    });
    expect(checkbox.checked).toBe(false);
    expect(document.body.textContent).toContain(
      "A verified provider event would not apply this disabled custom opt-out rule",
    );
  });

  it("creates only an opt-out state rule and single-flights the mutation", async () => {
    const createdRow = {
      ...optOutRow,
      id: "44444444-4444-4444-8444-444444444444",
      keyword: "LAUNCH",
      response_body:
        "You are unsubscribed from SMS marketing messages from this sender.",
      response_text:
        "You are unsubscribed from SMS marketing messages from this sender.",
      enabled: true,
    };
    let resolve!: (value: { data: typeof createdRow }) => void;
    const pending = new Promise<{ data: typeof createdRow }>((done) => {
      resolve = done;
    });
    mocks.create.mockReturnValue(pending);
    renderCard();
    await waitFor(() =>
      expect(button("Add opt-out keyword").disabled).toBe(false),
    );
    act(() => button("Add opt-out keyword").click());

    const keyword = document.querySelector<HTMLInputElement>("#kw-keyword");
    if (!keyword) throw new Error("Missing keyword editor field");
    expect(document.querySelector("#kw-response")).toBeNull();
    setControl(keyword, "launch");
    const submit = dialogButton("Add opt-out keyword");
    act(() => {
      submit.click();
      submit.click();
    });
    await flush();
    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(mocks.create).toHaveBeenCalledWith(
      {
        keyword: "LAUNCH",
        response_body:
          "You are unsubscribed from SMS marketing messages from this sender.",
        action: "opt_out",
        enabled: true,
      },
      { signal: expect.any(AbortSignal) },
    );

    await act(async () => {
      resolve({ data: createdRow });
      await pending;
    });
    expect(mocks.toastSuccess).toHaveBeenCalledWith(
      "LAUNCH opt-out rule added",
    );
  });

  it("does not expose an editor path that bypasses disable confirmation", async () => {
    mocks.list.mockResolvedValue({ data: listData([optOutRow]) });
    renderCard();
    await waitFor(() => expect(button("Edit").disabled).toBe(false));
    act(() => button("Edit").click());
    await flush();
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain("Status is unchanged in this editor");
    expect(
      dialog?.querySelector(
        'input[aria-label="Create keyword opt-out rule enabled"]',
      ),
    ).toBeNull();
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("treats create collisions as unchanged rows and refreshes for edit", async () => {
    mocks.list
      .mockResolvedValueOnce({ data: listData([]) })
      .mockResolvedValueOnce({ data: listData([optOutRow]) });
    mocks.create.mockResolvedValue({
      error: {
        status: 409,
        code: "keyword_response_exists",
        message: "SECRET duplicate detail",
      },
    });
    renderCard();
    await waitFor(() =>
      expect(button("Add opt-out keyword").disabled).toBe(false),
    );
    act(() => button("Add opt-out keyword").click());
    const keyword = document.querySelector<HTMLInputElement>("#kw-keyword");
    if (!keyword) throw new Error("Missing keyword editor field");
    setControl(keyword, "leave");
    act(() => dialogButton("Add opt-out keyword").click());
    await flush();

    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(mocks.list).toHaveBeenCalledTimes(2);
    expect(document.body.textContent).toContain("did not overwrite it");
    expect(document.body.textContent).not.toContain("SECRET duplicate detail");
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
  });

  it("sends the row CAS token and refreshes without overwriting on a stale toggle", async () => {
    mocks.list
      .mockResolvedValueOnce({ data: listData([optOutRow]) })
      .mockResolvedValueOnce({
        data: {
          tenantId: mocks.me.tenant,
          items: [{ ...optOutRow, keyword: "LEAVE2", updated_at: UPDATED_AT }],
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
    await waitFor(() =>
      expect(
        document.querySelector<HTMLInputElement>('input[type="checkbox"]'),
      ).not.toBeNull(),
    );
    act(() =>
      document
        .querySelector<HTMLInputElement>('input[type="checkbox"]')
        ?.click(),
    );
    await flush();
    act(() => button("Disable opt-out rule").click());
    await flush();

    expect(mocks.update.mock.calls[0]?.[1]).toEqual({
      action: "opt_out",
      enabled: false,
      expected_updated_at: optOutRow.updated_at,
    });
    expect(mocks.list).toHaveBeenCalledTimes(2);
    expect(document.body.textContent).toContain("LEAVE2");
    expect(document.body.textContent).not.toContain(
      "SECRET stale backend detail",
    );
  });

  it("treats a generic toggle failure as outcome unverified", async () => {
    mocks.list.mockResolvedValue({ data: listData([optOutRow]) });
    mocks.update.mockResolvedValueOnce({
      error: { status: 503, message: "SECRET proxy detail" },
    });
    renderCard();
    await waitFor(() =>
      expect(
        document.querySelector<HTMLInputElement>(
          'input[aria-describedby*="status"]',
        )?.disabled,
      ).toBe(false),
    );
    const toggle = document.querySelector<HTMLInputElement>(
      'input[aria-describedby*="status"]',
    );
    act(() => toggle?.click());
    await flush();
    act(() => button("Disable opt-out rule").click());
    await flush();

    expect(document.body.textContent).toContain(
      "keyword-policy change outcome is unverified",
    );
    expect(document.body.textContent).toContain("exact row");
    expect(document.body.textContent).toContain(
      "do not assume nothing changed",
    );
    expect(document.body.textContent).not.toContain("SECRET proxy detail");
  });

  it("tenant-binds typed deletion with the row CAS token and restores cancel focus", async () => {
    mocks.list.mockResolvedValue({ data: listData([optOutRow]) });
    mocks.remove.mockResolvedValue({
      data: {
        ok: true,
        tenantId: mocks.me.tenant,
        id: optOutRow.id,
      },
    });
    renderCard();
    await waitFor(() => expect(button("Delete").disabled).toBe(false));
    const trigger = button("Delete");
    act(() => trigger.focus());
    act(() => trigger.click());
    await flush();
    expect(button("Add opt-out keyword").disabled).toBe(true);
    expect(button("Edit").disabled).toBe(true);
    act(() => button("Cancel").click());
    await flush();
    expect(document.activeElement).toBe(trigger);

    act(() => trigger.click());
    await flush();
    const typed = document.querySelector<HTMLInputElement>(
      'input[placeholder="LEAVE"]',
    );
    if (!typed) throw new Error("Missing typed keyword confirmation");
    setControl(typed, "LEAVE");
    act(() => button("Delete keyword").click());
    await flush();
    expect(mocks.remove).toHaveBeenCalledWith(
      optOutRow.id,
      { expected_updated_at: optOutRow.updated_at },
      { signal: expect.any(AbortSignal) },
    );
  });

  it("reports an identity-retired policy mutation as outcome unknown", async () => {
    mocks.list.mockResolvedValue({ data: listData([optOutRow]) });
    mocks.update.mockResolvedValue({
      error: {
        code: "identity_changed",
        message: "SECRET response after possible commit",
      },
    });
    renderCard();
    await waitFor(() =>
      expect(
        document.querySelector<HTMLInputElement>('input[type="checkbox"]'),
      ).not.toBeNull(),
    );
    act(() =>
      document
        .querySelector<HTMLInputElement>('input[type="checkbox"]')
        ?.click(),
    );
    await flush();
    act(() => button("Disable opt-out rule").click());
    await flush();
    expect(document.body.textContent).toContain("server outcome is unknown");
    expect(document.body.textContent).toContain("original workspace");
    expect(document.body.textContent).not.toContain(
      "SECRET response after possible commit",
    );
  });

  it("recovers after a synchronous status failure with persistent context", async () => {
    mocks.list.mockResolvedValue({ data: listData([optOutRow]) });
    mocks.update.mockImplementationOnce(() => {
      throw new Error("carrier settings unavailable");
    });
    mocks.update.mockResolvedValueOnce({
      data: { ...optOutRow, enabled: false, updated_at: UPDATED_AT },
    });
    renderCard();
    await waitFor(() =>
      expect(
        document.querySelector<HTMLInputElement>('input[type="checkbox"]'),
      ).not.toBeNull(),
    );
    const checkbox = document.querySelector<HTMLInputElement>(
      'input[type="checkbox"]',
    );
    if (!checkbox) throw new Error("Missing keyword status checkbox");
    act(() => checkbox.click());
    await flush();
    act(() => button("Disable opt-out rule").click());
    await flush();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "outcome is unverified",
    );
    expect(document.body.textContent).not.toContain(
      "carrier settings unavailable",
    );
    expect(checkbox.disabled).toBe(true);
    expect(button("Disable opt-out rule").disabled).toBe(false);

    act(() => button("Disable opt-out rule").click());
    await flush();
    expect(mocks.update).toHaveBeenCalledTimes(2);
    expect(checkbox.checked).toBe(false);
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
    await flush();
    const listSignal = mocks.list.mock.calls[0]?.[0]?.signal as
      | AbortSignal
      | undefined;
    expect(listSignal).toBeInstanceOf(AbortSignal);
    act(() => root?.unmount());
    root = null;
    expect(listSignal?.aborted).toBe(true);
    resolveList({ data: listData([row]) });
    await flush();

    mocks.list.mockResolvedValue({ data: listData([optOutRow]) });
    let resolveUpdate!: (value: { data: typeof optOutRow }) => void;
    const pendingUpdate = new Promise<{ data: typeof optOutRow }>((resolve) => {
      resolveUpdate = resolve;
    });
    mocks.update.mockReturnValue(pendingUpdate);
    renderCard();
    await waitFor(() =>
      expect(
        document.querySelector<HTMLInputElement>('input[type="checkbox"]'),
      ).not.toBeNull(),
    );
    act(() =>
      document
        .querySelector<HTMLInputElement>('input[type="checkbox"]')
        ?.click(),
    );
    await flush();
    act(() => button("Disable opt-out rule").click());
    await flush();
    const mutationSignal = mocks.update.mock.calls[0]?.[2]?.signal as
      | AbortSignal
      | undefined;
    expect(mutationSignal).toBeInstanceOf(AbortSignal);
    act(() => root?.unmount());
    root = null;
    await flush();
    expect(mutationSignal?.aborted).toBe(true);
    resolveUpdate({
      data: { ...optOutRow, enabled: false, updated_at: UPDATED_AT },
    });
    await flush();
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
  });
});
