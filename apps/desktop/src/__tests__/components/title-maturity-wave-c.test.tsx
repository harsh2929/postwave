// @vitest-environment happy-dom

import axe from "axe-core";
import { act, Fragment, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { BYOKKeysPanel } from "../../components/hipaa/BYOKKeysPanel";
import { SequenceTriggerCard } from "../../components/sequence/SequenceTriggerCard";
import { StepPalette } from "../../components/sequence/StepPalette";
import { api } from "../../lib/api-client";

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
  ).find(
    (candidate) =>
      candidate.textContent?.trim() === label ||
      candidate.getAttribute("aria-label") === label,
  );
  if (!match) throw new Error(`Missing button: ${label}`);
  return match;
}

describe("title maturity wave C behavior", () => {
  it("keeps viewer actions keyboard-focusable, described, inert, and axe-clean", async () => {
    vi.spyOn(api, "byokListProviders").mockResolvedValue({
      data: { providers: ["aws"] },
    });
    const onAdd = vi.fn();
    const onEdit = vi.fn();
    render(
      <Fragment>
        <StepPalette disabled onAdd={onAdd} />
        <SequenceTriggerCard trigger={null} canMutate={false} onEdit={onEdit} />
        <BYOKKeysPanel keys={[]} onReload={vi.fn()} canMutate={false} />
      </Fragment>,
    );

    const heldTrigger = button("Runtime required");
    const heldTriggerDescriptionId =
      heldTrigger.getAttribute("aria-describedby");
    expect(
      document.getElementById(heldTriggerDescriptionId ?? "")?.textContent,
    ).toContain("Live sequence triggers, enrollment, delivery");

    const blocked = [
      button("Add Email step at the end"),
      heldTrigger,
      button("+ Register key"),
    ];
    for (const control of blocked) {
      expect(control.disabled).toBe(false);
      expect(control.getAttribute("aria-disabled")).toBe("true");
      const descriptionId = control.getAttribute("aria-describedby");
      expect(descriptionId).toBeTruthy();
      expect(
        document.getElementById(descriptionId ?? "")?.textContent,
      ).toBeTruthy();
      act(() => control.focus());
      expect(document.activeElement).toBe(control);
      act(() => control.click());
    }
    expect(onAdd).not.toHaveBeenCalled();
    expect(onEdit).not.toHaveBeenCalled();
    expect(document.querySelectorAll("button[title]")).toHaveLength(0);

    const result = await axe.run(container ?? document.body);
    expect(
      result.violations.filter((violation) =>
        ["serious", "critical"].includes(violation.impact ?? ""),
      ),
    ).toEqual([]);
  });
});
