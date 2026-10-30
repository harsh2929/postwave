// @vitest-environment happy-dom

import axe from "axe-core";
import { act, useState } from "react";
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

import { MarkdownNoteEditor } from "../../components/subscriber/MarkdownNoteEditor";
import type { NoteMentionItem } from "../../components/subscriber/NoteMentionMenu";

let container: HTMLDivElement | null = null;
let root: Root | null = null;

const candidates: NoteMentionItem[] = [
  {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    display: "Alex Rivera",
    hint: "alex@example.test",
  },
  {
    id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    display: "Mina Shah",
    hint: "mina@example.test",
  },
];

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(
    () => undefined,
  );
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

describe("MarkdownNoteEditor mention autocomplete", () => {
  it("owns one active-descendant focus model and preserves IME composition", () => {
    renderEditor();
    const textarea = editor();
    textarea.focus();
    setTextarea(textarea, "@");

    const listboxId = textarea.getAttribute("aria-controls");
    const options = () =>
      Array.from(
        document
          .getElementById(listboxId ?? "")
          ?.querySelectorAll<HTMLButtonElement>('[role="option"]') ?? [],
      );
    expect(textarea.getAttribute("role")).toBe("combobox");
    expect(textarea.getAttribute("aria-autocomplete")).toBe("list");
    expect(textarea.getAttribute("aria-expanded")).toBe("true");
    expect(document.getElementById(listboxId ?? "")).not.toBeNull();
    expect(options().map((option) => option.tabIndex)).toEqual([-1, -1]);
    expect(textarea.getAttribute("aria-activedescendant")).toBe(
      options()[0]?.id,
    );

    press(textarea, "ArrowDown", "keydown");
    press(textarea, "ArrowDown", "keyup");
    expect(textarea.getAttribute("aria-activedescendant")).toBe(
      options()[1]?.id,
    );

    act(() => {
      textarea.dispatchEvent(
        new Event("compositionstart", { bubbles: true, cancelable: true }),
      );
    });
    const composingEnter = press(textarea, "Enter", "keydown");
    expect(composingEnter.defaultPrevented).toBe(false);
    expect(textarea.value).toBe("@");
    act(() => {
      textarea.dispatchEvent(
        new Event("compositionend", { bubbles: true, cancelable: true }),
      );
    });

    press(textarea, "ArrowDown", "keydown");
    press(textarea, "Enter", "keydown");
    expect(textarea.value).toBe(
      "@[Mina Shah](user:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb) ",
    );
    expect(document.activeElement).toBe(textarea);
    expect(textarea.getAttribute("aria-expanded")).toBe("false");
    expect(textarea.hasAttribute("aria-activedescendant")).toBe(false);
  });

  it("announces no results and makes composing and real Escape distinct", () => {
    renderEditor();
    const textarea = editor();
    textarea.focus();
    setTextarea(textarea, "@nobody");

    expect(document.querySelectorAll('[role="option"]')).toHaveLength(0);
    expect(document.querySelector('[role="status"]')?.textContent).toBe(
      "No teammates match nobody",
    );
    expect(textarea.getAttribute("aria-expanded")).toBe("true");
    expect(textarea.hasAttribute("aria-activedescendant")).toBe(false);
    const emptyEnter = press(textarea, "Enter", "keydown");
    expect(emptyEnter.defaultPrevented).toBe(false);
    expect(textarea.getAttribute("aria-expanded")).toBe("true");

    act(() => {
      textarea.dispatchEvent(
        new Event("compositionstart", { bubbles: true, cancelable: true }),
      );
    });
    press(textarea, "Escape", "keydown");
    press(textarea, "Escape", "keyup");
    expect(textarea.getAttribute("aria-expanded")).toBe("true");
    act(() => {
      textarea.dispatchEvent(
        new Event("compositionend", { bubbles: true, cancelable: true }),
      );
    });

    const escape = press(textarea, "Escape", "keydown");
    press(textarea, "Escape", "keyup");
    expect(escape.defaultPrevented).toBe(true);
    expect(textarea.getAttribute("aria-expanded")).toBe("false");
    expect(textarea.value).toBe("@nobody");
  });

  it("commits a pointer selection without moving focus or losing the draft", () => {
    renderEditor("Context before ");
    const textarea = editor();
    textarea.focus();
    setTextarea(textarea, "Context before @");
    const first = document.querySelector<HTMLButtonElement>('[role="option"]');
    const pointerDown = new PointerEvent("pointerdown", {
      bubbles: true,
      cancelable: true,
      pointerType: "mouse",
    });

    act(() => {
      expect(first?.dispatchEvent(pointerDown)).toBe(false);
      first?.click();
    });
    expect(textarea.value).toBe(
      "Context before @[Alex Rivera](user:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa) ",
    );
    expect(document.activeElement).toBe(textarea);
  });

  it("has no serious automated accessibility violations while expanded", async () => {
    renderEditor();
    setTextarea(editor(), "@");

    const result = await axe.run(container ?? document.body);
    expect(
      result.violations.filter(
        (violation) =>
          violation.impact === "critical" || violation.impact === "serious",
      ),
    ).toEqual([]);
  });
});

function renderEditor(initialValue = ""): void {
  function Harness(): React.ReactElement {
    const [value, setValue] = useState(initialValue);
    return (
      <MarkdownNoteEditor
        value={value}
        onChange={setValue}
        mentionCandidates={candidates}
        ariaLabel="New note"
      />
    );
  }

  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(<Harness />));
}

function editor(): HTMLTextAreaElement {
  const textarea = document.querySelector<HTMLTextAreaElement>(
    'textarea[aria-label="New note"]',
  );
  if (!textarea) throw new Error("Missing note editor");
  return textarea;
}

function setTextarea(textarea: HTMLTextAreaElement, value: string): void {
  act(() => {
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )?.set?.call(textarea, value);
    textarea.setSelectionRange(value.length, value.length);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function press(
  textarea: HTMLTextAreaElement,
  key: string,
  type: "keydown" | "keyup",
): KeyboardEvent {
  const event = new KeyboardEvent(type, {
    key,
    bubbles: true,
    cancelable: true,
  });
  act(() => {
    textarea.dispatchEvent(event);
  });
  return event;
}
