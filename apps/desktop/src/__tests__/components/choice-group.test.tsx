// @vitest-environment happy-dom

import axe from "axe-core";
import { act, type ReactElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  ChoiceGroup,
  type ChoiceGroupOption,
} from "../../components/ChoiceGroup";

type Value = "all" | "locked" | "active" | "retired";

const options: readonly ChoiceGroupOption<Value>[] = [
  { value: "all", label: "All" },
  {
    value: "locked",
    label: "Predictive",
    unavailable: true,
    description: "Requires the Growth plan.",
  },
  { value: "active", label: "Active" },
  { value: "retired", label: "Retired", disabled: true },
];

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
});

function Harness(): ReactElement {
  const [value, setValue] = useState<Value>("all");
  return (
    <>
      <ChoiceGroup
        legend="Subscriber filter"
        value={value}
        options={options}
        onChange={setValue}
      />
      <output aria-label="Current filter">{value}</output>
    </>
  );
}

function render(): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(<Harness />));
}

function radio(value: Value): HTMLInputElement {
  const found = document.querySelector<HTMLInputElement>(
    `input[type="radio"][value="${value}"]`,
  );
  if (!found) throw new Error(`Missing radio ${value}`);
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

describe("ChoiceGroup", () => {
  it("renders a named native-radio group with described unavailable choices", async () => {
    render();
    expect(document.querySelector("legend")?.textContent).toBe(
      "Subscriber filter",
    );
    expect(radio("locked").getAttribute("aria-disabled")).toBe("true");
    const descriptionId = radio("locked").getAttribute("aria-describedby");
    expect(document.getElementById(descriptionId ?? "")?.textContent).toContain(
      "Growth plan",
    );
    expect(radio("retired").disabled).toBe(true);
    const result = await axe.run(container!, {
      rules: { region: { enabled: false } },
    });
    expect(
      result.violations.filter((violation) =>
        ["serious", "critical"].includes(violation.impact ?? ""),
      ),
    ).toEqual([]);
  });

  it("lets keyboard users inspect a locked choice without selecting it", () => {
    render();
    act(() => radio("all").focus());
    key(radio("all"), "ArrowRight");
    expect(document.activeElement).toBe(radio("locked"));
    expect(radio("all").checked).toBe(true);
    expect(key(radio("locked"), " ").defaultPrevented).toBe(true);
    expect(radio("all").checked).toBe(true);
    act(() => radio("locked").click());
    expect(radio("all").checked).toBe(true);

    key(radio("locked"), "ArrowRight");
    expect(document.activeElement).toBe(radio("active"));
    expect(radio("active").checked).toBe(true);
    key(radio("active"), "Home");
    expect(radio("all").checked).toBe(true);
    key(radio("all"), "End");
    expect(radio("active").checked).toBe(true);
  });

  it("ignores IME navigation and supports direct native change", () => {
    render();
    act(() => radio("all").focus());
    const composing = key(radio("all"), "ArrowRight", { isComposing: true });
    expect(composing.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(radio("all"));
    act(() => radio("active").click());
    expect(document.querySelector("output")?.textContent).toBe("active");
  });
});
