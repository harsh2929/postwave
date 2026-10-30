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

import { SettingsNavigationIndex } from "../../components/settings/SettingsNavigator";

let root: Root | null = null;
let container: HTMLDivElement | null = null;
const scrollIntoView = vi.fn();

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  scrollIntoView.mockReset();
  vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(
    scrollIntoView,
  );
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  vi.restoreAllMocks();
});

describe("SettingsNavigationIndex", () => {
  it("announces the route location and browses without navigating", () => {
    const navigate = vi.fn();
    render(
      <SettingsNavigationIndex
        activeAnchor="desktop-window"
        onNavigate={navigate}
      />,
    );
    expect(nav("Current settings location").textContent).toContain(
      "Desktop appDesktop window",
    );
    expect(button("Desktop window").getAttribute("aria-current")).toBe(
      "location",
    );

    act(() => button("Data & privacy").click());
    expect(document.body.textContent).toContain("Identifier transforms");
    expect(navigate).not.toHaveBeenCalled();
  });

  it("searches by synonym and passes only a typed anchor to navigation", () => {
    const navigate = vi.fn();
    render(
      <SettingsNavigationIndex
        activeAnchor="setup-progress"
        onNavigate={navigate}
      />,
    );
    const input = document.querySelector<HTMLInputElement>(
      'input[placeholder="Search settings"]',
    );
    if (!input) throw new Error("Missing settings search");
    setInput(input, "2FA");
    expect(input.getAttribute("role")).toBe("combobox");
    expect(input.getAttribute("aria-expanded")).toBe("true");
    expect(document.querySelector('[role="listbox"]')).not.toBeNull();

    act(() => button("Security").click());
    expect(navigate).toHaveBeenCalledWith("security");
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(input.value).toBe("");
  });

  it("supports arrow selection, Enter, Escape, and an honest empty result", () => {
    const navigate = vi.fn();
    render(
      <SettingsNavigationIndex
        activeAnchor="setup-progress"
        onNavigate={navigate}
      />,
    );
    const input =
      document.querySelector<HTMLInputElement>("input[type=search]");
    if (!input) throw new Error("Missing settings search");
    setInput(input, "api");
    const composingEnter = new KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
    });
    Object.defineProperty(composingEnter, "isComposing", { value: true });
    act(() => {
      input.dispatchEvent(composingEnter);
    });
    expect(navigate).not.toHaveBeenCalled();
    act(() => {
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
      );
    });
    act(() => {
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
    });
    expect(navigate).toHaveBeenCalledTimes(1);

    setInput(input, "not-a-real-setting");
    expect(document.body.textContent).toContain("No settings found");
    expect(document.querySelector('[role="listbox"]')).not.toBeNull();
    act(() => {
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });
    expect(input.value).toBe("");
  });

  it("clears a local query when Back or an external action changes the anchor", () => {
    const view = render(
      <SettingsNavigationIndex
        activeAnchor="setup-progress"
        onNavigate={vi.fn()}
      />,
    );
    const input =
      document.querySelector<HTMLInputElement>("input[type=search]");
    if (!input) throw new Error("Missing settings search");
    setInput(input, "api");
    view.rerender(
      <SettingsNavigationIndex activeAnchor="security" onNavigate={vi.fn()} />,
    );
    expect(input.value).toBe("");
    expect(nav("Current settings location").textContent).toContain(
      "AccountSecurity",
    );
  });

  it("keeps one combobox focus model and reveals the arrow-highlighted option", () => {
    render(
      <SettingsNavigationIndex
        activeAnchor="setup-progress"
        onNavigate={vi.fn()}
      />,
    );
    const input =
      document.querySelector<HTMLInputElement>("input[type=search]");
    if (!input) throw new Error("Missing settings search");
    input.focus();
    setInput(input, "a");
    const options = Array.from(
      document.querySelectorAll<HTMLElement>('[role="option"]'),
    );
    expect(options).toHaveLength(8);
    expect(options.every((option) => option.tabIndex === -1)).toBe(true);

    scrollIntoView.mockClear();
    act(() => {
      for (let index = 0; index < 7; index += 1) {
        input.dispatchEvent(
          new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
        );
      }
    });
    expect(input.getAttribute("aria-activedescendant")).toBe(options[7]?.id);
    expect(scrollIntoView).toHaveBeenCalled();
    expect(scrollIntoView.mock.contexts.at(-1)).toBe(options[7]);

    const tab = new KeyboardEvent("keydown", {
      key: "Tab",
      bubbles: true,
      cancelable: true,
    });
    expect(input.dispatchEvent(tab)).toBe(true);
    const pointerDown = new PointerEvent("pointerdown", {
      bubbles: true,
      cancelable: true,
    });
    expect(options[0]?.dispatchEvent(pointerDown)).toBe(false);
    expect(document.activeElement).toBe(input);
  });
});

function render(node: ReactElement): {
  rerender: (next: ReactElement) => void;
} {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(node));
  return { rerender: (next) => act(() => root?.render(next)) };
}

function setInput(input: HTMLInputElement, value: string): void {
  act(() => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function button(label: string): HTMLButtonElement {
  const matches = Array.from(
    document.querySelectorAll<HTMLButtonElement>("button"),
  );
  const match = matches.find((candidate) =>
    candidate.textContent?.trim().startsWith(label),
  );
  if (!match) throw new Error(`Missing button: ${label}`);
  return match;
}

function nav(label: string): HTMLElement {
  const match = document.querySelector<HTMLElement>(
    `nav[aria-label="${label}"]`,
  );
  if (!match) throw new Error(`Missing nav: ${label}`);
  return match;
}
