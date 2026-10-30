// @vitest-environment happy-dom

import { act, type ReactElement } from "react";
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
  contextEpoch: "epoch-1",
  contextListeners: new Set<(epoch: string) => void>(),
  me: {
    user: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    tenant: "00000000-0000-0000-0000-000000000001",
    role: "admin",
    effectiveRole: "admin",
  },
  list: vi.fn(),
  add: vi.fn(),
  remove: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("../../lib/store", () => ({
  useCanAdmin: () => mocks.canAdmin,
  useMe: () => mocks.me,
}));

vi.mock("../../lib/context-epoch", () => ({
  readContextEpoch: () => mocks.contextEpoch,
  onContextEpochObserved: (listener: (epoch: string) => void) => {
    mocks.contextListeners.add(listener);
    return () => mocks.contextListeners.delete(listener);
  },
}));

vi.mock("../../lib/desktop-router", () => ({
  desktopRouteIdentityScope: (user?: string, tenant?: string) =>
    user && tenant ? `${user}:${tenant}` : null,
}));

vi.mock("../../lib/api-client", () => ({
  smsSuppressionsApi: {
    list: mocks.list,
    add: mocks.add,
    remove: mocks.remove,
  },
}));

vi.mock("../../components/Toast", () => ({
  toast: { error: mocks.toastError, success: mocks.toastSuccess },
}));

vi.mock("../../components/sms/SmsA2PRegistrationCard", () => ({
  SmsA2PRegistrationCard: () => null,
}));
vi.mock("../../components/sms/SmsQuietHoursCard", () => ({
  SmsQuietHoursCard: () => null,
}));
vi.mock("../../components/sms/SmsKeywordResponsesCard", () => ({
  SmsKeywordResponsesCard: () => null,
}));
vi.mock("../../components/sms/TapToTextBlockEditor", () => ({
  TapToTextBlockEditor: () => null,
}));

import { SmsSuppressions } from "../../pages/SmsSuppressions";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

const authoritativeRows = [
  {
    id: "11111111-1111-4111-8111-111111111111",
    phone_e164: "+12025550101",
    reason: "manual",
    source: "manual",
    reversible: true,
    created_at: "2026-08-20T12:00:00Z",
  },
  {
    id: "22222222-2222-4222-8222-222222222222",
    phone_e164: "+12025550102",
    reason: "stop_keyword",
    source: "twilio",
    reversible: false,
    locked_reason: "carrier_or_system_authority",
    created_at: "2026-08-20T12:01:00Z",
  },
  {
    id: "33333333-3333-4333-8333-333333333333",
    phone_e164: "+12025550103",
    reason: "carrier_block",
    source: "bandwidth",
    reversible: false,
    locked_reason: "carrier_or_system_authority",
    created_at: "2026-08-20T12:02:00Z",
  },
];

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  mocks.canAdmin = true;
  mocks.contextEpoch = "epoch-1";
  mocks.contextListeners.clear();
  mocks.me = {
    user: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    tenant: "00000000-0000-0000-0000-000000000001",
    role: "admin",
    effectiveRole: "admin",
  };
  vi.useRealTimers();
  vi.clearAllMocks();
  mocks.list.mockResolvedValue({
    data: {
      items: authoritativeRows,
      total: authoritativeRows.length,
      snapshotAt: "2026-08-21T12:00:00Z",
    },
  });
  mocks.add.mockResolvedValue({
    data: {
      id: "44444444-4444-4444-8444-444444444444",
      phone_e164: "+12025550118",
      reason: "manual",
      source: "manual",
      reversible: true,
      created_at: "2026-08-21T12:00:00Z",
    },
  });
  mocks.remove.mockResolvedValue({
    data: {
      ok: true,
      tenantId: mocks.me.tenant,
      id: "11111111-1111-4111-8111-111111111111",
    },
  });
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
});

function render(node: ReactElement): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(node));
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function button(label: string): HTMLButtonElement {
  const match = Array.from(document.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!(match instanceof HTMLButtonElement)) {
    throw new Error(`Missing button: ${label}`);
  }
  return match;
}

function changeInput(input: HTMLInputElement, value: string): void {
  act(() => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

describe("SMS suppression authority containment", () => {
  it("locks system suppressions and exposes only manual creation", async () => {
    render(<SmsSuppressions />);
    await settle();

    expect(document.body.textContent).toContain("STOP-classified · locked");
    expect(document.body.textContent).toContain(
      "Carrier-block-classified · locked",
    );
    expect(document.body.textContent).toContain(
      "not a repeatable database snapshot",
    );
    expect(document.body.textContent).toContain("late commits");
    expect(
      Array.from(document.querySelectorAll("button")).filter(
        (control) => control.textContent?.trim() === "Remove",
      ),
    ).toHaveLength(1);

    act(() => button("Add manual suppression").click());
    expect(document.body.textContent).toContain(
      "This creates a manual suppression",
    );
    expect(button("Add manual suppression").disabled).toBe(true);
    expect(button("Remove").disabled).toBe(true);
    expect(document.querySelector("#sms-supp-reason")).toBeNull();

    const phone = document.querySelector<HTMLInputElement>("#sms-supp-phone");
    expect(phone).not.toBeNull();
    changeInput(phone!, "(202) 555-0118");
    act(() => button("Suppress").click());
    await settle();

    expect(mocks.add).toHaveBeenCalledWith({
      phone: "+12025550118",
      reason: "manual",
    });
    expect(mocks.toastSuccess).toHaveBeenCalledWith(
      "+12025550118 manually suppressed",
    );
  });

  it("fails closed when the server reclassifies a row as authoritative", async () => {
    mocks.remove.mockResolvedValueOnce({
      error: {
        status: 409,
        code: "suppression_authoritative",
        message: "raw server detail must not be shown",
      },
    });
    render(<SmsSuppressions />);
    await settle();

    act(() => button("Remove").click());
    expect(document.body.textContent).toContain(
      "This does not prove the number is eligible",
    );
    const typed = document.querySelector<HTMLInputElement>(
      'input[placeholder="+12025550101"]',
    );
    expect(typed).not.toBeNull();
    expect(button("Remove manual suppression").disabled).toBe(true);
    changeInput(typed!, "+12025550101");
    expect(button("Remove manual suppression").disabled).toBe(false);
    act(() => button("Remove manual suppression").click());
    await settle();

    expect(mocks.remove).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
    );
    expect(mocks.toastError).toHaveBeenCalledWith({
      message: "Couldn't remove manual SMS suppression",
      detail:
        "The server identifies this as an authoritative system suppression. It remains locked.",
    });
    expect(document.body.textContent).not.toContain(
      "raw server detail must not be shown",
    );
  });

  it("reports an identity-retired add as outcome unknown instead of failed", async () => {
    mocks.add.mockResolvedValueOnce({
      error: {
        code: "identity_changed",
        message: "The request response was retired after a committed write.",
      },
    });
    render(<SmsSuppressions />);
    await settle();
    act(() => button("Add manual suppression").click());
    const phone = document.querySelector<HTMLInputElement>("#sms-supp-phone");
    if (!phone) throw new Error("Missing manual suppression phone field");
    changeInput(phone, "+12025550118");
    act(() => button("Suppress").click());
    await settle();

    expect(document.body.textContent).toContain("server outcome is unknown");
    expect(document.body.textContent).toContain("verify this exact phone");
    expect(document.body.textContent).not.toContain(
      "request response was retired",
    );
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
  });

  it("treats a generic add failure as an unverified outcome", async () => {
    mocks.add.mockResolvedValueOnce({
      error: {
        status: 503,
        message: "SECRET proxy detail that must not reach the operator",
      },
    });
    render(<SmsSuppressions />);
    await settle();
    act(() => button("Add manual suppression").click());
    const phone = document.querySelector<HTMLInputElement>("#sms-supp-phone");
    if (!phone) throw new Error("Missing manual suppression phone field");
    changeInput(phone, "+12025550118");
    act(() => button("Suppress").click());
    await settle();

    expect(document.body.textContent).toContain(
      "suppression outcome could not be verified",
    );
    expect(document.body.textContent).toContain("Refresh this exact phone");
    expect(document.body.textContent).toContain(
      "do not assume no row was created",
    );
    expect(document.body.textContent).not.toContain("SECRET proxy detail");
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
  });

  it("rejects unreviewed Unicode whitespace, tabs, and bidi input without reinterpreting a phone", async () => {
    render(<SmsSuppressions />);
    await settle();
    act(() => button("Add manual suppression").click());
    const phone = document.querySelector<HTMLInputElement>("#sms-supp-phone");
    if (!phone) throw new Error("Missing manual suppression phone field");

    for (const hostile of [
      "\u00a0+12025550118",
      "+1\t2025550118",
      "+1202\u202e5550118",
    ]) {
      changeInput(phone, hostile);
      act(() => button("Suppress").click());
      await settle();
    }

    expect(mocks.add).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain(
      "Enter a valid US/Canada number",
    );
  });

  it("does not authorize editor-level mutation controls", async () => {
    mocks.canAdmin = false;
    render(<SmsSuppressions />);
    await settle();

    expect(document.body.textContent).toContain(
      "Your current role cannot read or change this authority list",
    );
    expect(document.body.textContent).not.toContain("Add manual suppression");
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it("never requests an invalid or partial exact phone and never echoes it", async () => {
    render(<SmsSuppressions />);
    await settle();
    expect(mocks.list).toHaveBeenCalledTimes(1);

    const search = document.querySelector<HTMLInputElement>(
      'input[aria-label="Filter by exact US/Canada phone"]',
    );
    expect(search).not.toBeNull();
    changeInput(search!, "2\u202eRAW-PROXY-TEXT");
    await settle();

    expect(mocks.list).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).toContain(
      "Phone filtering is exact and US/Canada-only",
    );
    expect(document.body.textContent).not.toContain("RAW-PROXY-TEXT");
    expect(document.body.textContent).not.toContain("+1 (202) 555-0101");

    for (const nonPhone of ["\t", "\u00a0", "   "]) {
      changeInput(search!, nonPhone);
      await settle();
    }
    expect(mocks.list).toHaveBeenCalledTimes(1);
  });

  it("describes an exact miss without claiming the paginated registry is complete", async () => {
    vi.useFakeTimers();
    mocks.list.mockResolvedValueOnce({
      data: {
        items: authoritativeRows,
        total: authoritativeRows.length,
        snapshotAt: "2026-08-21T12:00:00Z",
      },
    });
    mocks.list.mockResolvedValueOnce({
      data: {
        items: [],
        total: 0,
        snapshotAt: "2026-08-21T12:00:00Z",
      },
    });
    render(<SmsSuppressions />);
    await settle();
    const search = document.querySelector<HTMLInputElement>(
      'input[aria-label="Filter by exact US/Canada phone"]',
    );
    if (!search) throw new Error("Missing exact-phone search");
    changeInput(search, "+12025550199");
    await act(async () => {
      vi.advanceTimersByTime(250);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(document.body.textContent).toContain(
      "return to the paginated registry",
    );
    expect(document.body.textContent).not.toContain("see all suppressions");
  });

  it("retires prior rows immediately when criteria changes and locks stale mutations", async () => {
    vi.useFakeTimers();
    mocks.list
      .mockResolvedValueOnce({
        data: {
          items: authoritativeRows,
          total: authoritativeRows.length,
          snapshotAt: "2026-08-21T12:00:00Z",
        },
      })
      .mockResolvedValueOnce({
        error: { status: 503, message: "untrusted upstream detail" },
      });
    render(<SmsSuppressions />);
    await settle();
    expect(document.body.textContent).toContain("+1 (202) 555-0101");

    const search = document.querySelector<HTMLInputElement>(
      'input[aria-label="Filter by exact US/Canada phone"]',
    );
    changeInput(search!, "+12025550199");
    expect(document.body.textContent).not.toContain("+1 (202) 555-0101");
    expect(button("Add manual suppression").disabled).toBe(true);
    await act(async () => {
      vi.advanceTimersByTime(250);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mocks.list).toHaveBeenCalledTimes(2);
    expect(document.body.textContent).not.toContain(
      "untrusted upstream detail",
    );
    expect(document.body.textContent).toContain(
      "authoritative SMS suppression list could not be loaded",
    );
  });

  it("requires the exact canonical phone and restores focus after manual removal", async () => {
    render(<SmsSuppressions />);
    await settle();
    const trigger = button("Remove");
    act(() => trigger.focus());
    act(() => trigger.click());
    act(() => button("Cancel").click());
    await settle();
    expect(document.activeElement).toBe(trigger);
    act(() => trigger.click());
    const confirm = button("Remove manual suppression");
    expect(confirm.disabled).toBe(true);
    const typed = document.querySelector<HTMLInputElement>(
      'input[placeholder="+12025550101"]',
    );
    changeInput(typed!, "+12025550101");
    expect(confirm.disabled).toBe(false);
    act(() => confirm.click());
    await settle();
    expect(mocks.remove).toHaveBeenCalledTimes(1);
  });

  it("remounts and retires private rows when the context epoch rotates", async () => {
    mocks.list
      .mockResolvedValueOnce({
        data: {
          items: authoritativeRows,
          total: authoritativeRows.length,
          snapshotAt: "2026-08-21T12:00:00Z",
        },
      })
      .mockResolvedValueOnce({
        data: {
          items: [
            {
              ...authoritativeRows[0],
              id: "55555555-5555-4555-8555-555555555555",
              phone_e164: "+12025550999",
            },
          ],
          total: 1,
          snapshotAt: "2026-08-22T12:00:00Z",
        },
      });
    render(<SmsSuppressions />);
    await settle();
    expect(document.body.textContent).toContain("+1 (202) 555-0101");

    act(() => {
      mocks.contextEpoch = "epoch-2";
      for (const listener of mocks.contextListeners) listener("epoch-2");
    });
    expect(document.body.textContent).not.toContain("+1 (202) 555-0101");
    await settle();
    expect(document.body.textContent).toContain("+1 (202) 555-0999");
    expect(mocks.list).toHaveBeenCalledTimes(2);
  });

  it("returns to a cached prior page without creating a fresh snapshot", async () => {
    const first = authoritativeRows[0]!;
    const second = {
      ...first,
      id: "66666666-6666-4666-8666-666666666666",
      phone_e164: "+12025550888",
    };
    mocks.list
      .mockResolvedValueOnce({
        data: {
          items: [first],
          total: 2,
          nextCursor: "v1.synthetic_page_2",
          snapshotAt: "2026-08-21T12:00:00Z",
        },
      })
      .mockResolvedValueOnce({
        data: {
          items: [second],
          total: 2,
          snapshotAt: "2026-08-21T12:00:00Z",
        },
      });
    render(<SmsSuppressions />);
    await settle();
    expect(document.body.textContent).toContain("+1 (202) 555-0101");

    act(() => button("Next").click());
    await settle();
    expect(document.body.textContent).toContain("+1 (202) 555-0888");
    expect(mocks.list).toHaveBeenCalledTimes(2);

    act(() => button("Prev").click());
    expect(document.body.textContent).toContain("+1 (202) 555-0101");
    expect(document.body.textContent).not.toContain("+1 (202) 555-0888");
    expect(mocks.list).toHaveBeenCalledTimes(2);
  });
});
