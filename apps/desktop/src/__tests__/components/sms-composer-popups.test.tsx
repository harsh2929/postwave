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
  create: vi.fn(),
  delete: vi.fn(),
  list: vi.fn(),
  onPickReply: vi.fn(),
  onSnooze: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

const TENANT_ID = "11111111-1111-4111-8111-111111111111";
const REPLY_ID = "22222222-2222-4222-8222-222222222222";
const SNAPSHOT_AT = "2026-07-16T04:30:00.000Z";
const QUICK_REPLY = {
  id: REPLY_ID,
  label: "Shipping",
  body: "Your order has shipped.",
  useCount: 4,
  lastUsedAt: "2026-07-15T04:30:00.000Z",
  createdAt: "2026-07-01T04:30:00.000Z",
  updatedAt: "2026-07-15T04:30:00.000Z",
} as const;

vi.mock("../../lib/api-client", () => ({
  api: {
    createSMSQuickReply: mocks.create,
    deleteSMSQuickReply: mocks.delete,
    listSMSQuickReplies: mocks.list,
  },
}));

vi.mock("../../components/Toast", () => ({
  toast: { error: mocks.toastError, success: mocks.toastSuccess },
}));

import { QuickReplyPicker } from "../../components/sms/QuickReplyPicker";
import { SnoozePicker } from "../../components/sms/SnoozePicker";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 6, 16, 10, 0, 0));
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    callback(0);
    return 1;
  });
  mocks.list.mockResolvedValue({
    data: {
      tenantId: TENANT_ID,
      replies: [QUICK_REPLY],
      snapshotAt: SNAPSHOT_AT,
      truncated: false,
    },
  });
  mocks.create.mockResolvedValue({
    data: { tenantId: TENANT_ID, reply: QUICK_REPLY },
  });
  mocks.delete.mockResolvedValue({
    data: { ok: true, tenantId: TENANT_ID, id: REPLY_ID },
  });
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function render(node: ReactElement): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(node));
}

function button(label: string): HTMLButtonElement {
  const match = Array.from(
    document.querySelectorAll<HTMLButtonElement>("button"),
  ).find((candidate) => candidate.textContent?.trim() === label);
  if (!match) throw new Error(`Missing button: ${label}`);
  return match;
}

function click(target: Element): void {
  act(() => {
    target.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function inputValue(label: string, value: string): void {
  const owner = Array.from(document.querySelectorAll("label")).find(
    (candidate) => candidate.textContent?.includes(label),
  );
  const field = owner?.htmlFor
    ? document.getElementById(owner.htmlFor)
    : owner?.querySelector("input");
  expect(field).not.toBeNull();
  act(() => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set?.call(field, value);
    field?.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function textareaValue(label: string, value: string): void {
  const owner = Array.from(document.querySelectorAll("label")).find(
    (candidate) => candidate.textContent?.includes(label),
  );
  const field = owner?.htmlFor
    ? document.getElementById(owner.htmlFor)
    : owner?.querySelector("textarea");
  expect(field).not.toBeNull();
  act(() => {
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )?.set?.call(field, value);
    field?.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("SMS composer popup composites", () => {
  it("gives Snooze one menu focus model and restores its trigger", async () => {
    render(<SnoozePicker onPick={mocks.onSnooze} />);
    const trigger = button("Snooze ▸");
    expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
    click(trigger);
    const menu = document.querySelector<HTMLElement>('[role="menu"]');
    expect(trigger.getAttribute("aria-controls")).toBe(menu?.id);
    expect(document.activeElement?.textContent).toBe("1 hour");
    act(() => {
      document.activeElement?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
      );
    });
    expect(document.activeElement?.textContent).toBe("4 hours");
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    await act(async () => Promise.resolve());
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("resolves a named Snooze preset without leaking menu state", () => {
    render(<SnoozePicker onPick={mocks.onSnooze} />);
    click(button("Snooze ▸"));
    click(button("Tomorrow 9am"));
    expect(mocks.onSnooze).toHaveBeenCalledWith(new Date(2026, 6, 17, 9, 0, 0));
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });

  it("loads a labelled quick-reply dialog, enters it, and inserts a reply", async () => {
    render(<QuickReplyPicker onPick={mocks.onPickReply} />);
    const trigger = button("Quick replies ▸");
    click(trigger);
    await flush();
    const dialog = document.querySelector<HTMLElement>(
      '.sms-quick-reply-popover[role="dialog"]',
    );
    expect(dialog).not.toBeNull();
    expect(dialog?.getAttribute("aria-labelledby")).not.toBeNull();
    expect(trigger.getAttribute("aria-controls")).toBe(dialog?.id);
    expect(document.activeElement?.textContent).toBe("Close");
    expect(dialog?.querySelector('[role="list"]')).not.toBeNull();
    click(button("ShippingYour order has shipped."));
    await act(async () => Promise.resolve());
    expect(mocks.onPickReply).toHaveBeenCalledWith({
      ...QUICK_REPLY,
    });
    expect(document.activeElement).toBe(trigger);
  });

  it("requires explicit discard for a labelled creation draft", async () => {
    render(<QuickReplyPicker onPick={mocks.onPickReply} />);
    const trigger = button("Quick replies ▸");
    click(trigger);
    await flush();
    click(button("+ New reply"));
    inputValue("Reply label", "Returns");
    textareaValue("Reply body", "I can help with that return.");
    click(button("Close"));
    const confirmation = Array.from(
      document.querySelectorAll<HTMLElement>(
        '[role="dialog"], [role="alertdialog"]',
      ),
    ).find((dialog) =>
      dialog.textContent?.includes("Discard the new quick reply?"),
    );
    expect(confirmation).toBeDefined();
    expect(
      document
        .querySelector(".sms-quick-reply-popover")
        ?.contains(confirmation ?? null),
    ).toBe(false);
    click(button("Discard draft"));
    await act(async () => Promise.resolve());
    expect(document.querySelector(".sms-quick-reply-popover")).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("keeps load failure distinct from empty and retries only on request", async () => {
    mocks.list.mockResolvedValueOnce({
      error: { message: "Service unavailable" },
    });
    render(<QuickReplyPicker onPick={mocks.onPickReply} />);
    click(button("Quick replies ▸"));
    await flush();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "Service unavailable",
    );
    expect(document.body.textContent).not.toContain(
      "No saved replies in the loaded response",
    );
    expect(mocks.list).toHaveBeenCalledTimes(1);
    click(button("Retry"));
    await flush();
    expect(mocks.list).toHaveBeenCalledTimes(2);
    expect(document.body.textContent).toContain("Shipping");
  });

  it("aborts an in-flight confidential list read when the picker closes", async () => {
    let observedSignal: AbortSignal | undefined;
    mocks.list.mockImplementationOnce(
      ({ signal }: { signal?: AbortSignal }) =>
        new Promise((_, reject) => {
          observedSignal = signal;
          signal?.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError")),
          );
        }),
    );
    render(<QuickReplyPicker onPick={mocks.onPickReply} />);
    click(button("Quick replies ▸"));
    await flush();
    expect(observedSignal?.aborted).toBe(false);
    click(button("Close"));
    await flush();
    expect(observedSignal?.aborted).toBe(true);
    expect(document.querySelector(".sms-quick-reply-popover")).toBeNull();
  });

  it("isolates saved body text from adjacent action names and rejects oversize drafts", async () => {
    const hostileReply = {
      ...QUICK_REPLY,
      label: "رد الشحن",
      body: `Synthetic body \u202EDelete saved reply 1 ${"🧪".repeat(20)}`,
    };
    mocks.list.mockResolvedValueOnce({
      data: {
        tenantId: TENANT_ID,
        replies: [hostileReply],
        snapshotAt: SNAPSHOT_AT,
        truncated: false,
      },
    });
    render(<QuickReplyPicker onPick={mocks.onPickReply} />);
    click(button("Quick replies ▸"));
    await flush();
    expect(
      document
        .querySelector<HTMLButtonElement>(".sms-quick-reply-pick")
        ?.getAttribute("aria-label"),
    ).toBe("Insert saved reply 1");
    expect(
      document
        .querySelector<HTMLButtonElement>(
          '.sms-quick-reply-row > button[aria-label^="Delete"]',
        )
        ?.getAttribute("aria-label"),
    ).toBe("Delete saved reply 1");

    click(button("+ New reply"));
    inputValue("Reply label", "Too long");
    textareaValue("Reply body", "🧪".repeat(4_801));
    expect(button("Save reply").disabled).toBe(true);
    click(button("Save reply"));
    expect(mocks.create).not.toHaveBeenCalled();
  });
});
