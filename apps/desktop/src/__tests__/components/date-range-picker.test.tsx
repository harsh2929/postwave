// @vitest-environment happy-dom

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

import { DateRangePicker } from "../../components/analytics/DateRangePicker";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 440 });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: 280 });
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    callback(0);
    return 1;
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

function renderPicker(onApply = vi.fn()): ReturnType<typeof vi.fn> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root?.render(
      <DateRangePicker
        value={{ from: "2026-07-10", to: "2026-07-15" }}
        active
        onApply={onApply}
      />,
    );
  });
  return onApply;
}

function trigger(): HTMLButtonElement {
  const button = container?.querySelector<HTMLButtonElement>(
    'button[aria-haspopup="dialog"]',
  );
  expect(button).not.toBeNull();
  button!.getBoundingClientRect = () =>
    ({
      bottom: 60,
      height: 28,
      left: 360,
      right: 420,
      top: 32,
      width: 60,
      x: 360,
      y: 32,
      toJSON: () => ({}),
    }) as DOMRect;
  return button!;
}

function click(element: Element | null): void {
  expect(element).not.toBeNull();
  act(() => {
    element?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function openPicker(): HTMLDivElement {
  click(trigger());
  const dialog = document.querySelector<HTMLDivElement>(
    '[role="dialog"][aria-label="Choose a date range"], [role="dialog"][aria-labelledby]',
  );
  expect(dialog).not.toBeNull();
  return dialog!;
}

describe("DateRangePicker composite", () => {
  it("portals and clamps a single roving calendar at the compact proxy", () => {
    renderPicker();
    const dialog = openPicker();
    expect(dialog.parentElement).toBe(document.body);
    expect(dialog.style.left).toBe("8px");
    expect(dialog.style.top).toBe("66px");
    expect(dialog.style.width).toBe("424px");
    expect(dialog.style.maxHeight).toBe("206px");
    expect(dialog.querySelectorAll('[role="grid"]')).toHaveLength(1);
    expect(dialog.querySelectorAll<HTMLButtonElement>("[data-date]")).toHaveLength(
      31,
    );
    expect(dialog.querySelectorAll('[data-date][tabindex="0"]')).toHaveLength(1);
    expect(document.activeElement?.getAttribute("data-date")).toBe("2026-07-10");
  });

  it("moves the real day focus with Arrow, Home and PageDown", () => {
    renderPicker();
    openPicker();
    const press = (key: string): void => {
      act(() => {
        document.activeElement?.dispatchEvent(
          new KeyboardEvent("keydown", { key, bubbles: true }),
        );
      });
    };
    press("ArrowRight");
    expect(document.activeElement?.getAttribute("data-date")).toBe("2026-07-11");
    press("Home");
    expect(document.activeElement?.getAttribute("data-date")).toBe("2026-07-06");
    press("PageDown");
    expect(document.activeElement?.getAttribute("data-date")).toBe("2026-08-06");
    expect(document.querySelector('[aria-label*="August 6, 2026"]')).not.toBeNull();
  });

  it("retains a reviewable draft, normalizes it, applies, and restores focus", async () => {
    const onApply = renderPicker();
    const dialog = openPicker();
    click(dialog.querySelector('[data-date="2026-07-20"]'));
    expect(document.body.textContent).toContain(
      "2026-07-20 selected. Choose an end date.",
    );
    click(dialog.querySelector('[data-date="2026-07-10"]'));
    const apply = Array.from(dialog.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Apply range",
    );
    expect(apply?.hasAttribute("disabled")).toBe(false);
    click(apply ?? null);
    await act(async () => Promise.resolve());
    expect(onApply).toHaveBeenCalledWith({
      from: "2026-07-10",
      to: "2026-07-20",
    });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(trigger());
    expect(document.body.textContent).toContain(
      "Date range 2026-07-10 through 2026-07-20 applied.",
    );
  });

  it("ignores composing Escape, then closes the top popup and restores focus", async () => {
    renderPicker();
    openPicker();
    const composing = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
    });
    Object.defineProperty(composing, "isComposing", { value: true });
    act(() => {
      window.dispatchEvent(composing);
    });
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();

    act(() => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });
    await act(async () => Promise.resolve());
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  it("closes when keyboard focus leaves the non-modal popup", () => {
    renderPicker();
    openPicker();
    const outside = document.createElement("button");
    document.body.appendChild(outside);
    act(() => outside.focus());
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(outside);
  });

  it("applies a named preset without requiring calendar traversal", async () => {
    const onApply = renderPicker();
    const dialog = openPicker();
    const today = Array.from(dialog.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Today",
    );
    click(today ?? null);
    await act(async () => Promise.resolve());
    expect(onApply).toHaveBeenCalledTimes(1);
    const range = onApply.mock.calls[0]?.[0] as { from: string; to: string };
    expect(range.from).toBe(range.to);
    expect(document.activeElement).toBe(trigger());
  });
});
