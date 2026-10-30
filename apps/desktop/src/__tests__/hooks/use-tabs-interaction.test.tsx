// @vitest-environment happy-dom

import axe from "axe-core";
import { act, type ReactElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  type TabDescriptor,
  useTabsInteraction,
} from "../../hooks/useTabsInteraction";

type Value = "overview" | "activity" | "settings";

const allItems: readonly TabDescriptor<Value>[] = [
  { value: "overview" },
  { value: "activity", disabled: true },
  { value: "settings" },
];

let container: HTMLDivElement | null = null;
let root: Root | null = null;
const scrollIntoView = vi.fn();

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  HTMLElement.prototype.scrollIntoView = scrollIntoView;
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
  vi.clearAllMocks();
});

function Harness({
  activation = "automatic",
  items = allItems,
  initial = "overview",
}: {
  activation?: "automatic" | "manual";
  items?: readonly TabDescriptor<Value>[];
  initial?: Value;
}): ReactElement {
  const [value, setValue] = useState<Value>(initial);
  const tabs = useTabsInteraction({
    activation,
    items,
    onChange: setValue,
    value,
  });
  return (
    <>
      <div ref={tabs.listRef} {...tabs.listProps} aria-label="Example sections">
        {items.map((item) => (
          <button
            key={item.value}
            type="button"
            {...tabs.getTabProps(item.value)}
            disabled={item.disabled}
          >
            {item.value}
          </button>
        ))}
      </div>
      {items.map((item) => (
        <section key={item.value} {...tabs.getPanelProps(item.value)}>
          {item.value} panel
        </section>
      ))}
      <output aria-label="Active section">{value}</output>
    </>
  );
}

function render(node: ReactElement): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(node));
}

function tab(value: Value): HTMLButtonElement {
  const found = Array.from(
    document.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
  ).find((candidate) => candidate.textContent === value);
  if (!found) throw new Error(`Missing tab ${value}`);
  return found;
}

function key(
  target: HTMLElement,
  value: string,
  options: KeyboardEventInit = {},
): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    key: value,
    ...options,
  });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

async function flush(): Promise<void> {
  await act(async () => Promise.resolve());
}

describe("useTabsInteraction", () => {
  it("owns exact tab/panel relationships and an axe-clean active panel", async () => {
    render(<Harness />);
    const overview = tab("overview");
    const panel = document.querySelector<HTMLElement>(
      '[role="tabpanel"]:not([hidden])',
    );
    expect(overview.getAttribute("aria-controls")).toBe(panel?.id);
    expect(panel?.getAttribute("aria-labelledby")).toBe(overview.id);
    expect(overview.tabIndex).toBe(0);
    expect(tab("settings").tabIndex).toBe(-1);
    expect(tab("activity").getAttribute("aria-disabled")).toBe("true");
    const result = await axe.run(container!, {
      rules: { region: { enabled: false } },
    });
    expect(
      result.violations.filter((violation) =>
        ["serious", "critical"].includes(violation.impact ?? ""),
      ),
    ).toEqual([]);
  });

  it("automatically activates, wraps, skips disabled tabs, and handles Home/End", () => {
    render(<Harness />);
    act(() => tab("overview").focus());
    expect(key(tab("overview"), "ArrowRight").defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(tab("settings"));
    expect(tab("settings").getAttribute("aria-selected")).toBe("true");
    key(tab("settings"), "ArrowRight");
    expect(document.activeElement).toBe(tab("overview"));
    key(tab("overview"), "End");
    expect(document.activeElement).toBe(tab("settings"));
    key(tab("settings"), "Home");
    expect(document.activeElement).toBe(tab("overview"));
  });

  it("keeps manual arrow focus separate from Enter/Space activation", () => {
    render(<Harness activation="manual" />);
    act(() => tab("overview").focus());
    key(tab("overview"), "ArrowRight");
    expect(document.activeElement).toBe(tab("settings"));
    expect(tab("settings").tabIndex).toBe(0);
    expect(tab("overview").tabIndex).toBe(-1);
    expect(tab("overview").getAttribute("aria-selected")).toBe("true");
    key(tab("settings"), "Enter");
    expect(tab("settings").getAttribute("aria-selected")).toBe("true");
    key(tab("settings"), "Home");
    key(tab("overview"), " ");
    expect(tab("overview").getAttribute("aria-selected")).toBe("true");
    expect(scrollIntoView).toHaveBeenLastCalledWith({
      block: "nearest",
      inline: "nearest",
      behavior: "instant",
    });
  });

  it("ignores composition keys and falls back after dynamic removal", async () => {
    render(<Harness initial="settings" />);
    act(() => tab("settings").focus());
    const composing = key(tab("settings"), "ArrowLeft", { isComposing: true });
    expect(composing.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(tab("settings"));

    const remaining: readonly TabDescriptor<Value>[] = [
      { value: "overview" },
      { value: "activity", disabled: true },
    ];
    act(() => root?.render(<Harness initial="settings" items={remaining} />));
    await flush();
    expect(document.querySelector("output")?.textContent).toBe("overview");
    expect(tab("overview").tabIndex).toBe(0);
  });

  it("supports direct pointer activation without adding extra tab stops", () => {
    render(<Harness />);
    act(() => tab("settings").click());
    expect(tab("settings").getAttribute("aria-selected")).toBe("true");
    expect(
      Array.from(document.querySelectorAll('[role="tab"]')).filter(
        (candidate) => (candidate as HTMLElement).tabIndex === 0,
      ),
    ).toHaveLength(1);
  });

  it("keeps tab and panel ids stable when members reorder", () => {
    render(<Harness />);
    const settingsTabId = tab("settings").id;
    const settingsPanelId = tab("settings").getAttribute("aria-controls");
    const reordered: readonly TabDescriptor<Value>[] = [
      { value: "settings" },
      { value: "overview" },
      { value: "activity", disabled: true },
    ];
    act(() => root?.render(<Harness items={reordered} />));
    expect(tab("settings").id).toBe(settingsTabId);
    expect(tab("settings").getAttribute("aria-controls")).toBe(settingsPanelId);
    expect(
      document.getElementById(settingsPanelId ?? "")?.textContent,
    ).toContain("settings panel");
  });
});
