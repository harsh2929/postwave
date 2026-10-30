// @vitest-environment happy-dom

import axe from "axe-core";
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
  send: vi.fn(),
  error: vi.fn(),
  success: vi.fn(),
}));

vi.mock("../../lib/api-client", () => ({
  api: { sendProductEvent: mocks.send },
}));

vi.mock("../../components/Toast", () => ({
  toast: { error: mocks.error, success: mocks.success },
}));

import { EventComposer } from "../../components/track/EventComposer";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

function render(element: ReactElement = <EventComposer canSend />): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(element));
}

function rerender(element: ReactElement): void {
  act(() => root?.render(element));
}

function button(label: string): HTMLButtonElement {
  const found = Array.from(
    document.querySelectorAll<HTMLButtonElement>("button"),
  ).find((candidate) => candidate.textContent?.trim() === label);
  if (!found) throw new Error(`Missing button ${label}`);
  return found;
}

function control(label: string): HTMLInputElement | HTMLTextAreaElement {
  const owner = Array.from(document.querySelectorAll("label")).find(
    (candidate) => candidate.textContent?.includes(label),
  );
  const found = owner?.querySelector<HTMLInputElement | HTMLTextAreaElement>(
    "input, textarea",
  );
  if (!found) throw new Error(`Missing control ${label}`);
  return found;
}

function setValue(
  target: HTMLInputElement | HTMLTextAreaElement,
  value: string,
): void {
  const prototype =
    target instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  act(() => {
    Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(
      target,
      value,
    );
    target.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function settle(): Promise<void> {
  await act(async () => Promise.resolve());
}

describe("EventComposer", () => {
  it("explains the authority boundary without opening a live-write form", () => {
    render(<EventComposer canSend={false} />);
    const trigger = button("Live event unavailable");
    expect(trigger.getAttribute("aria-disabled")).toBe("true");
    act(() => trigger.click());
    expect(document.querySelector('[role="region"]')).toBeNull();
    expect(document.body.textContent).toContain("Admin only");
  });

  it("uses a named inline disclosure and keeps composing Escape inert", async () => {
    render();
    const trigger = button("Send live event");
    act(() => trigger.click());
    await settle();
    const region = document.querySelector<HTMLElement>('[role="region"]');
    expect(region).not.toBeNull();
    expect(trigger.getAttribute("aria-controls")).toBe(region?.id);
    expect(region?.getAttribute("aria-labelledby")).toBe(trigger.id);
    const identity = control("Subscriber");
    expect(document.activeElement).toBe(identity);
    act(() => identity.focus());
    act(() => {
      identity.dispatchEvent(
        new KeyboardEvent("keydown", {
          bubbles: true,
          key: "Escape",
          isComposing: true,
        }),
      );
    });
    expect(document.querySelector('[role="region"]')).not.toBeNull();
    act(() => {
      identity.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, key: "Escape" }),
      );
    });
    await settle();
    expect(document.querySelector('[role="region"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    act(() => trigger.click());
    const result = await axe.run(container!, {
      rules: { region: { enabled: false } },
    });
    expect(
      result.violations.filter((violation) =>
        ["serious", "critical"].includes(violation.impact ?? ""),
      ),
    ).toEqual([]);
  });

  it("connects validation feedback to the exact invalid control", () => {
    render();
    act(() => button("Send live event").click());
    const name = control("Event name");
    setValue(name, "Not valid");
    act(() => {
      name.focus();
      name.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    });
    expect(name.getAttribute("aria-invalid")).toBe("true");
    const errorId = name.getAttribute("aria-describedby");
    expect(document.getElementById(errorId ?? "")?.textContent).toContain(
      "snake_case",
    );
    const properties = control("Properties");
    setValue(properties, "[]");
    expect(properties.getAttribute("aria-invalid")).toBe("true");
    expect(
      document.getElementById(properties.getAttribute("aria-describedby") ?? "")
        ?.textContent,
    ).toContain("JSON object");
  });

  it("owns same-tick submission and recovers from a thrown request", async () => {
    mocks.send
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValueOnce({ data: { id: 901 } });
    render(<EventComposer canSend initialEventName="checkout_completed" />);
    act(() => button("Send live event").click());
    setValue(control("Subscriber"), "alice@example.test");
    setValue(control("Properties"), '{"plan":"pro","amount":49}');
    act(() => control("I reviewed").click());
    const send = button("Send live event");
    act(() => {
      send.click();
      send.click();
    });
    await settle();
    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(mocks.error).toHaveBeenCalledWith(
      expect.stringContaining("couldn't confirm whether the live event"),
    );
    expect(button("Retry same live event").disabled).toBe(false);
    const retainedKey = mocks.send.mock.calls[0]?.[1]?.idempotencyKey;
    expect(retainedKey).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    const retainedBody = structuredClone(mocks.send.mock.calls[0]?.[0]);
    rerender(<EventComposer canSend initialEventName="purchase_refunded" />);
    await settle();
    expect(control("Event name").getAttribute("disabled")).not.toBeNull();
    expect(control("Event name").value).toBe("checkout_completed");
    act(() => button("Retry same live event").click());
    await settle();
    expect(mocks.send).toHaveBeenCalledTimes(2);
    expect(mocks.send.mock.calls[1]?.[1]?.idempotencyKey).toBe(retainedKey);
    expect(mocks.send.mock.calls[1]?.[0]).toEqual(retainedBody);
  });

  it("closes and disables an open live-write surface after a role downgrade", async () => {
    render(<EventComposer canSend />);
    const trigger = button("Send live event");
    act(() => trigger.click());
    await settle();
    expect(document.querySelector('[role="region"]')).not.toBeNull();

    rerender(<EventComposer canSend={false} />);
    await settle();

    expect(document.querySelector('[role="region"]')).toBeNull();
    const unavailable = button("Live event unavailable");
    expect(unavailable.getAttribute("aria-disabled")).toBe("true");
    expect(document.activeElement).toBe(unavailable);
  });

  it("requires explicit impact acknowledgement and rotates the key after a known rejection", async () => {
    mocks.send
      .mockResolvedValueOnce({
        error: {
          status: 422,
          code: "invalid_event_name",
          message: "known rejection",
        },
      })
      .mockResolvedValueOnce({ data: { id: 902 } });
    render(<EventComposer canSend />);
    act(() => button("Send live event").click());
    setValue(control("Subscriber"), "alice@example.test");
    setValue(control("Event name"), "checkout_completed");
    expect(button("Send live event").disabled).toBe(true);
    act(() => button("Send live event").click());
    expect(mocks.send).not.toHaveBeenCalled();

    act(() => control("I reviewed").click());
    act(() => button("Send live event").click());
    await settle();
    const rejectedKey = mocks.send.mock.calls[0]?.[1]?.idempotencyKey;
    expect(rejectedKey).toEqual(expect.any(String));

    act(() => button("Send live event").click());
    await settle();
    expect(mocks.send).toHaveBeenCalledTimes(2);
    expect(mocks.send.mock.calls[1]?.[1]?.idempotencyKey).not.toBe(rejectedKey);
  });
});
