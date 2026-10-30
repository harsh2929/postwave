// @vitest-environment happy-dom

import axe from "axe-core";
import { act, type ReactElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { DateRangePopover } from "../../components/suppressions/DateRangePopover";
import { anchoredPopoverPosition } from "../../lib/anchored-popover-position";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    callback(0);
    return 1;
  });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    bottom: 140,
    height: 32,
    left: 40,
    right: 180,
    top: 108,
    width: 140,
    x: 40,
    y: 108,
    toJSON: () => ({}),
  });
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

function Harness(): ReactElement {
  const [range, setRange] = useState({ from: "", to: "" });
  return <DateRangePopover {...range} onChange={setRange} />;
}

function render(): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(<Harness />));
}

function button(label: string): HTMLButtonElement {
  const found = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!found) throw new Error(`Missing button ${label}`);
  return found;
}

function date(label: string): HTMLInputElement {
  const owner = Array.from(document.querySelectorAll("label")).find(
    (candidate) => candidate.querySelector("span")?.textContent === label,
  );
  const input = owner?.querySelector<HTMLInputElement>('input[type="date"]');
  if (!input) throw new Error(`Missing date ${label}`);
  return input;
}

function setDate(label: string, value: string): void {
  const input = date(label);
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
      input,
      value,
    );
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function flush(): Promise<void> {
  await act(async () => Promise.resolve());
}

describe("suppressions date-range popover", () => {
  it("portals a named dialog, enters it, and has no serious axe violations", async () => {
    render();
    const trigger = button("Added: Any time");
    act(() => trigger.click());
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(container?.contains(dialog)).toBe(false);
    expect(trigger.getAttribute("aria-controls")).toBe(dialog?.id);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(date("From"));
    const result = await axe.run(dialog!);
    expect(
      result.violations.filter((violation) =>
        ["serious", "critical"].includes(violation.impact ?? ""),
      ),
    ).toEqual([]);
  });

  it("keeps IME Escape inert and restores the trigger on real Escape", async () => {
    render();
    const trigger = button("Added: Any time");
    act(() => trigger.click());
    act(() => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", isComposing: true }),
      );
    });
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    await flush();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("validates ordering, applies explicitly, and restores focus", async () => {
    render();
    const trigger = button("Added: Any time");
    act(() => trigger.click());
    setDate("From", "2026-07-20");
    setDate("To", "2026-07-10");
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "on or after",
    );
    expect(button("Apply").disabled).toBe(true);
    setDate("To", "2026-07-25");
    act(() => button("Apply").click());
    await flush();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(trigger.textContent).toContain("Jul 20");
    expect(document.activeElement).toBe(trigger);
  });

  it("closes on outside pointer without mutating an uncommitted draft", () => {
    render();
    const trigger = button("Added: Any time");
    act(() => trigger.click());
    setDate("From", "2026-07-20");
    act(() => {
      document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(trigger.textContent).toBe("Added: Any time");
  });
});

describe("anchoredPopoverPosition", () => {
  it("clamps horizontally and flips above a short lower viewport", () => {
    expect(
      anchoredPopoverPosition(
        { left: 420, right: 460, top: 250, bottom: 280 },
        440,
        300,
        { preferredWidth: 300, minimumHeight: 200 },
      ),
    ).toMatchObject({ bottom: 56, left: 132, maxHeight: 236, width: 300 });
  });

  it("never invents viewport height when the window is shorter than the minimum", () => {
    const position = anchoredPopoverPosition(
      { left: 110, right: 126, top: 84, bottom: 100 },
      120,
      120,
      { preferredWidth: 280, minimumHeight: 160 },
    );
    expect(position).toMatchObject({ bottom: 42, left: 8, maxHeight: 70, width: 104 });
    expect((position.bottom ?? 0) + position.maxHeight).toBeLessThanOrEqual(112);
  });
});
