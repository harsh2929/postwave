// @vitest-environment happy-dom

import { act, type ReactNode } from "react";
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
  validate: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  getPreference: vi.fn(),
  putPreference: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("../../lib/api-client", () => ({
  zeroCopyTriggersApi: {
    validate: mocks.validate,
    create: mocks.create,
    update: mocks.update,
  },
  triggerDelayApi: {
    getPreference: mocks.getPreference,
    putPreference: mocks.putPreference,
  },
}));

vi.mock("../../components/Toast", () => ({
  toast: { error: mocks.toastError, success: mocks.toastSuccess },
}));

vi.mock("../../components/SectionHeader", () => ({
  SectionHeader: ({ title }: { title: string }) => <h2>{title}</h2>,
}));

vi.mock("../../components/Modal", () => ({
  Modal: ({
    children,
    title,
    onClose,
  }: {
    children: ReactNode;
    title: string;
    onClose: () => void;
  }) => (
    <div role="dialog" aria-label={title}>
      <button type="button" onClick={onClose}>
        Window close
      </button>
      <button type="button" onClick={onClose}>
        Escape close
      </button>
      <button type="button" onClick={onClose}>
        Backdrop close
      </button>
      {children}
    </div>
  ),
  ModalFooter: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock("../../components/ConfirmModal", () => ({
  ConfirmModal: ({
    open,
    title,
    confirmLabel,
    onConfirm,
    onClose,
  }: {
    open: boolean;
    title: string;
    confirmLabel: string;
    onConfirm: () => void;
    onClose: () => void;
  }) =>
    open ? (
      <div role="alertdialog" aria-label={title}>
        <button type="button" onClick={onConfirm}>
          {confirmLabel}
        </button>
        <button type="button" onClick={onClose}>
          Keep editing
        </button>
      </div>
    ) : null,
}));

import { TriggerDelayCard } from "../../components/automations/TriggerDelayCard";
import { TriggerEditorModal } from "../../components/automations/TriggerEditorModal";
import { resetLifecycleCoordinatorForTests } from "../../lib/lifecycle-coordinator";

const NOW = "2026-07-21T10:00:00.000Z";
const SUBSCRIBER_ID = "11111111-1111-4111-8111-111111111111";
const SAVED_TRIGGER = {
  id: "trigger-1",
  name: "Orders",
  status: "draft",
  provider: "snowflake",
  query: "SELECT email, created_at FROM orders WHERE created_at > :cursor",
  cursor_column: "created_at",
  profile_key_column: "email",
  polling_interval_seconds: 300,
  max_rows_per_tick: 500,
  consecutive_failures: 0,
  rows_fired_total: 0,
  runtime: {
    capability: "zero_copy_trigger_execution",
    runtime_status: "unavailable",
    execution_enabled: false,
    code: "zero_copy_runtime_unavailable",
    message: "Zero-copy execution is unavailable.",
    prerequisites: ["durable_execution_receipts"],
  },
};
let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.validate.mockResolvedValue({ data: { valid: true } });
  mocks.create.mockResolvedValue({ data: SAVED_TRIGGER });
  mocks.update.mockResolvedValue({ data: SAVED_TRIGGER });
  mocks.putPreference.mockImplementation((input: Record<string, unknown>) =>
    Promise.resolve({
      data: {
        subscriber_id: input.subscriber_id,
        event_name: input.event_name,
        optimal_delay_seconds: input.optimal_delay_seconds,
        sample_count: 0,
        confidence: 0,
        reason: input.reason,
        computed_at: NOW,
        updated_at: NOW,
      },
    }),
  );
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
  resetLifecycleCoordinatorForTests();
});

function render(node: ReactNode): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(node));
}

function button(label: string): HTMLButtonElement {
  const match = [
    ...document.querySelectorAll<HTMLButtonElement>("button"),
  ].find((candidate) => candidate.textContent?.trim() === label);
  if (!match) throw new Error(`Missing button: ${label}`);
  return match;
}

function control(
  selector: string,
): HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement {
  const match = document.querySelector<
    HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
  >(selector);
  if (!match) throw new Error(`Missing control: ${selector}`);
  return match;
}

function setValue(
  element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
  value: string,
): void {
  act(() => {
    const prototype =
      element instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : element instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(
      element,
      value,
    );
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function preference(eventName = "cart.abandoned") {
  return {
    subscriber_id: SUBSCRIBER_ID,
    event_name: eventName,
    optimal_delay_seconds: 120,
    sample_count: 2,
    confidence: 0.5,
    reason: "Manual review",
    computed_at: NOW,
    updated_at: NOW,
  };
}

describe("warehouse trigger draft lifecycle", () => {
  it("routes X, Escape, backdrop, and Cancel through explicit discard confirmation", () => {
    const onClose = vi.fn();
    render(
      <TriggerEditorModal mode="create" onClose={onClose} onSaved={vi.fn()} />,
    );
    setValue(
      control('input[placeholder="e.g. New high-LTV orders"]'),
      "Orders",
    );

    for (const closeLabel of [
      "Window close",
      "Escape close",
      "Backdrop close",
      "Cancel",
    ]) {
      act(() => button(closeLabel).click());
      expect(onClose).not.toHaveBeenCalled();
      expect(
        document
          .querySelector('[role="alertdialog"]')
          ?.getAttribute("aria-label"),
      ).toBe("Discard unsaved trigger changes?");
      act(() => button("Keep editing").click());
    }

    act(() => button("Cancel").click());
    act(() => button("Discard changes").click());
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("refuses modal close synchronously while the save request is active", async () => {
    let resolveCreate!: (value: unknown) => void;
    mocks.create.mockReturnValue(
      new Promise((resolve) => {
        resolveCreate = resolve;
      }),
    );
    const onClose = vi.fn();
    render(
      <TriggerEditorModal mode="create" onClose={onClose} onSaved={vi.fn()} />,
    );
    setValue(
      control('input[placeholder="e.g. New high-LTV orders"]'),
      "Orders",
    );
    setValue(control("select"), "snowflake");
    setValue(
      control('textarea[placeholder^="SELECT"]'),
      "SELECT email, created_at FROM orders WHERE created_at > :cursor",
    );
    setValue(control('input[placeholder="created_at"]'), "created_at");
    setValue(control('input[placeholder="email"]'), "email");

    act(() => button("Create draft").click());
    const name = control('input[placeholder="e.g. New high-LTV orders"]');
    expect(name.disabled).toBe(true);
    expect(control("select").disabled).toBe(true);
    setValue(name, "Changed after request started");
    expect(name.value).toBe("Orders");
    act(() => button("Window close").click());
    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();

    await act(async () => {
      resolveCreate({ data: SAVED_TRIGGER });
      await Promise.resolve();
    });
  });

  it.each([
    ["structurally malformed", { id: "trigger-1" }],
    ["mismatched", { ...SAVED_TRIGGER, name: "Different definition" }],
  ])(
    "keeps the editor open when a successful response is %s",
    async (_caseName, responseData) => {
      mocks.create.mockResolvedValueOnce({ data: responseData });
      const onClose = vi.fn();
      const onSaved = vi.fn();
      render(
        <TriggerEditorModal
          mode="create"
          onClose={onClose}
          onSaved={onSaved}
        />,
      );
      setValue(
        control('input[placeholder="e.g. New high-LTV orders"]'),
        "Orders",
      );
      setValue(control("select"), "snowflake");
      setValue(control('textarea[placeholder^="SELECT"]'), SAVED_TRIGGER.query);
      setValue(control('input[placeholder="created_at"]'), "created_at");
      setValue(control('input[placeholder="email"]'), "email");

      act(() => button("Create draft").click());
      await flush();

      expect(onSaved).not.toHaveBeenCalled();
      expect(onClose).not.toHaveBeenCalled();
      expect(document.querySelector('[role="dialog"]')).not.toBeNull();
      expect(mocks.toastSuccess).not.toHaveBeenCalled();
      expect(mocks.toastError).toHaveBeenCalledWith(
        expect.objectContaining({
          message: "Saved response could not be verified",
        }),
      );
    },
  );
});

describe("manual timing override lifecycle", () => {
  it("requires confirmation before a new lookup discards an unsaved override", async () => {
    mocks.getPreference
      .mockResolvedValueOnce({ data: preference() })
      .mockResolvedValueOnce({ error: { status: 404, message: "missing" } });
    render(<TriggerDelayCard canAdmin />);
    const subscriber = control(
      'input[placeholder="00000000-0000-0000-0000-000000000000"]',
    );
    const event = control('input[placeholder="cart.abandoned"]');
    setValue(subscriber, SUBSCRIBER_ID);
    setValue(event, "cart.abandoned");
    act(() => button("Look up pair").click());
    await flush();

    const delay = control('input[type="number"]');
    setValue(delay, "240");
    setValue(event, "checkout.started");
    act(() => button("Look up pair").click());
    expect(mocks.getPreference).toHaveBeenCalledTimes(1);
    expect(
      document
        .querySelector('[role="alertdialog"]')
        ?.getAttribute("aria-label"),
    ).toBe("Discard the unsaved timing override?");

    act(() => button("Keep editing").click());
    expect(mocks.getPreference).toHaveBeenCalledTimes(1);
    act(() => button("Look up pair").click());
    act(() => button("Discard and look up").click());
    await flush();
    expect(mocks.getPreference).toHaveBeenLastCalledWith({
      subscriberId: SUBSCRIBER_ID,
      eventName: "checkout.started",
    });
  });

  it("binds save to the resolved pair and rejects mismatched response identity", async () => {
    mocks.getPreference.mockResolvedValueOnce({
      data: { ...preference(), subscriber_id: "another-subscriber" },
    });
    render(<TriggerDelayCard canAdmin />);
    setValue(
      control('input[placeholder="00000000-0000-0000-0000-000000000000"]'),
      SUBSCRIBER_ID,
    );
    setValue(control('input[placeholder="cart.abandoned"]'), "cart.abandoned");
    act(() => button("Look up pair").click());
    await flush();
    expect(document.body.textContent).toContain(
      "malformed timing override identity",
    );
    expect(document.body.textContent).not.toContain("override stored");
    expect(mocks.putPreference).not.toHaveBeenCalled();
  });

  it("rejects an oversized UTF-8 operator reason before the write request", async () => {
    mocks.getPreference.mockResolvedValueOnce({ data: preference() });
    render(<TriggerDelayCard canAdmin />);
    setValue(
      control('input[placeholder="00000000-0000-0000-0000-000000000000"]'),
      SUBSCRIBER_ID,
    );
    setValue(control('input[placeholder="cart.abandoned"]'), "cart.abandoned");
    act(() => button("Look up pair").click());
    await flush();

    setValue(
      control('input[placeholder="Manual override — VIP cadence"]'),
      "é".repeat(251),
    );
    act(() => button("Save manual override").click());

    expect(document.body.textContent).toContain(
      "Operator reason must be 500 bytes or fewer",
    );
    expect(mocks.putPreference).not.toHaveBeenCalled();
  });

  it("freezes pair and override inputs while a save snapshot is in flight", async () => {
    let resolvePut!: (value: unknown) => void;
    mocks.getPreference.mockResolvedValueOnce({ data: preference() });
    mocks.putPreference.mockReturnValue(
      new Promise((resolve) => {
        resolvePut = resolve;
      }),
    );
    render(<TriggerDelayCard canAdmin />);
    const subscriber = control(
      'input[placeholder="00000000-0000-0000-0000-000000000000"]',
    );
    const event = control('input[placeholder="cart.abandoned"]');
    setValue(subscriber, SUBSCRIBER_ID);
    setValue(event, "cart.abandoned");
    act(() => button("Look up pair").click());
    await flush();

    const delay = control('input[type="number"]');
    const reason = control(
      'input[placeholder="Manual override — VIP cadence"]',
    );
    setValue(delay, "240");
    setValue(reason, "Reviewed by operations");
    act(() => button("Save manual override").click());

    expect(subscriber.disabled).toBe(true);
    expect(event.disabled).toBe(true);
    expect(delay.disabled).toBe(true);
    expect(reason.disabled).toBe(true);
    setValue(event, "checkout.started");
    setValue(delay, "360");
    setValue(reason, "Changed after request started");
    expect(event.value).toBe("cart.abandoned");
    expect(delay.value).toBe("240");
    expect(reason.value).toBe("Reviewed by operations");
    expect(mocks.putPreference).toHaveBeenCalledWith({
      subscriber_id: SUBSCRIBER_ID,
      event_name: "cart.abandoned",
      optimal_delay_seconds: 240,
      reason: "Reviewed by operations",
    });

    await act(async () => {
      resolvePut({
        data: {
          ...preference(),
          optimal_delay_seconds: 240,
          reason: "Reviewed by operations",
        },
      });
      await Promise.resolve();
    });
  });

  it("freezes lookup inputs and keeps retained override fields locked after a mismatched response", async () => {
    let resolveLookup!: (value: unknown) => void;
    mocks.getPreference
      .mockResolvedValueOnce({ data: preference() })
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveLookup = resolve;
        }),
      );
    render(<TriggerDelayCard canAdmin />);
    const subscriber = control(
      'input[placeholder="00000000-0000-0000-0000-000000000000"]',
    );
    const event = control('input[placeholder="cart.abandoned"]');
    setValue(subscriber, SUBSCRIBER_ID);
    setValue(event, "cart.abandoned");
    act(() => button("Look up pair").click());
    await flush();

    const delay = control('input[type="number"]');
    const reason = control(
      'input[placeholder="Manual override — VIP cadence"]',
    );
    setValue(event, "checkout.started");
    act(() => button("Look up pair").click());

    expect(subscriber.disabled).toBe(true);
    expect(event.disabled).toBe(true);
    expect(delay.disabled).toBe(true);
    expect(reason.disabled).toBe(true);
    setValue(event, "changed.during.lookup");
    setValue(delay, "999");
    expect(event.value).toBe("checkout.started");
    expect(delay.value).toBe("120");

    await act(async () => {
      resolveLookup({ data: preference("different.event") });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(document.body.textContent).toContain(
      "malformed timing override identity",
    );
    expect(delay.disabled).toBe(true);
    expect(reason.disabled).toBe(true);
    expect(button("Save manual override").disabled).toBe(true);
  });
});
