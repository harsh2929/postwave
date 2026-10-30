// @vitest-environment happy-dom

import axe from "axe-core";
import { act, type ReactElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { BulkImportSuppressionsModal } from "../../components/suppressions/BulkImportSuppressionsModal";
import { SequenceCreateDialog } from "../../pages/Sequences";

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  HTMLElement.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
  document.body.style.overflow = "";
  vi.clearAllMocks();
});

function render(node: ReactElement): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(node));
}

function key(target: HTMLElement, value: string): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    key: value,
  });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

function namedTab(list: HTMLElement, label: string): HTMLButtonElement {
  const match = [
    ...list.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
  ].find((candidate) => candidate.textContent?.trim() === label);
  if (!match) throw new Error(`Missing tab: ${label}`);
  return match;
}

function radio(value: string): HTMLInputElement {
  const match = document.querySelector<HTMLInputElement>(
    `input[type="radio"][value="${value}"]`,
  );
  if (!match) throw new Error(`Missing radio: ${value}`);
  return match;
}

async function expectNoSeriousAxeViolations(): Promise<void> {
  const result = await axe.run(document.body, {
    rules: { region: { enabled: false } },
  });
  expect(
    result.violations.filter((violation) =>
      ["serious", "critical"].includes(violation.impact ?? ""),
    ),
  ).toEqual([]);
}

function SequenceDialogHarness(): ReactElement {
  const [mode, setMode] = useState<"templates" | "ai" | "blank">("templates");
  const [brief, setBrief] = useState("");
  const [name, setName] = useState("");
  return (
    <SequenceCreateDialog
      aiDraft={null}
      aiGenerating={false}
      aiServerDraft={null}
      aiStepCount=""
      aiTone=""
      brief={brief}
      canCreate
      createMode={mode}
      name={name}
      open
      operationActive={false}
      selectedTemplateKey="blank"
      submitErr={null}
      submitting={false}
      unavailableReason={null}
      onAiStepCountChange={vi.fn()}
      onAiToneChange={vi.fn()}
      onBriefChange={setBrief}
      onClose={vi.fn()}
      onGenerate={vi.fn()}
      onModeChange={setMode}
      onNameChange={setName}
      onPickTemplate={vi.fn()}
      onQuickMatch={vi.fn()}
      onSubmit={vi.fn()}
    />
  );
}

describe("DUX-023 semantic choice and tab migrations", () => {
  it("keeps sequence document tabs manual, fully controlled, and axe-clean", async () => {
    render(<SequenceDialogHarness />);
    const list = document.querySelector<HTMLElement>(
      '[role="tablist"][aria-label="Sequence creation mode"]',
    );
    expect(list).not.toBeNull();
    const templates = namedTab(list!, "Templates");
    const ai = namedTab(list!, "AI generate");
    const blank = namedTab(list!, "Blank");

    for (const tab of [templates, ai, blank]) {
      const controlledId = tab.getAttribute("aria-controls");
      const panel = controlledId ? document.getElementById(controlledId) : null;
      expect(panel?.getAttribute("role")).toBe("tabpanel");
      expect(panel?.getAttribute("aria-labelledby")).toBe(tab.id);
    }
    expect(
      [...list!.querySelectorAll('[role="tab"]')].filter(
        (candidate) => (candidate as HTMLElement).tabIndex === 0,
      ),
    ).toHaveLength(1);

    act(() => templates.focus());
    expect(key(templates, "ArrowRight").defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(ai);
    expect(templates.getAttribute("aria-selected")).toBe("true");
    key(ai, "Enter");
    expect(ai.getAttribute("aria-selected")).toBe("true");

    const brief = document.querySelector<HTMLTextAreaElement>("#seq-ai-brief");
    act(() => {
      Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )?.set?.call(brief, "Welcome new customers");
      brief?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => blank.click());
    act(() => ai.click());
    expect(
      document.querySelector<HTMLTextAreaElement>("#seq-ai-brief")?.value,
    ).toBe("Welcome new customers");
    await expectNoSeriousAxeViolations();
  });

  it("treats suppression input formats as one native immediate-choice group", async () => {
    render(
      <BulkImportSuppressionsModal
        open
        onClose={vi.fn()}
        onImported={vi.fn()}
      />,
    );
    expect(document.querySelector("legend")?.textContent).toBe("Input mode");
    expect(radio("emails").checked).toBe(true);
    expect(radio("emails").name).toBe(radio("csv").name);

    act(() => radio("emails").focus());
    key(radio("emails"), "ArrowRight");
    expect(document.activeElement).toBe(radio("csv"));
    expect(radio("csv").checked).toBe(true);
    expect(document.body.textContent).toContain("Default reason");
    expect(document.querySelector("textarea")?.placeholder).toContain(
      "email,reason",
    );

    key(radio("csv"), "End");
    expect(radio("json").checked).toBe(true);
    expect(document.body.textContent).toContain(
      "Each object may set its own reason",
    );
    expect(document.querySelector('[role="tablist"]')).toBeNull();
    await expectNoSeriousAxeViolations();
  });
});
