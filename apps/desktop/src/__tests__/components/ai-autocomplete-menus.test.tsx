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

import {
  AI_MENTION_LISTBOX_ID,
  MentionMenu,
  mentionOptionId,
  type MentionItem,
} from "../../components/ai/MentionMenu";
import {
  AI_SLASH_LISTBOX_ID,
  SlashCommandMenu,
  filterSlashCommands,
  slashCommandOptionId,
} from "../../components/ai/SlashCommandMenu";

let container: HTMLDivElement | null = null;
let root: Root | null = null;

const mentions: MentionItem[] = [
  {
    kind: "campaign",
    id: "campaign-1",
    label: "July launch",
    hint: "Draft",
  },
  {
    kind: "subscriber",
    id: "subscriber-2",
    label: "Mina Shah",
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
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("AI autocomplete menus", () => {
  it("exposes stable mention options without creating a second tab stop", () => {
    const onSelect = vi.fn();
    const onHover = vi.fn();
    render(
      <MentionMenu
        open
        items={mentions}
        activeIndex={1}
        loading={false}
        query="mi"
        onSelect={onSelect}
        onHover={onHover}
      />,
    );

    const listbox = document.getElementById(AI_MENTION_LISTBOX_ID);
    const options = Array.from(
      listbox?.querySelectorAll<HTMLButtonElement>('[role="option"]') ?? [],
    );
    expect(listbox?.getAttribute("role")).toBe("listbox");
    expect(options).toHaveLength(2);
    expect(options.map((option) => option.tabIndex)).toEqual([-1, -1]);
    expect(options[1]?.id).toBe(mentionOptionId(mentions[1]));
    expect(options[1]?.getAttribute("aria-selected")).toBe("true");
    expect(options[0]?.getAttribute("aria-selected")).toBe("false");

    const touchStart = new PointerEvent("pointerdown", {
      bubbles: true,
      cancelable: true,
      pointerType: "touch",
    });
    act(() => {
      expect(options[0]?.dispatchEvent(touchStart)).toBe(true);
    });
    expect(onSelect).not.toHaveBeenCalled();

    const pointerDown = new PointerEvent("pointerdown", {
      bubbles: true,
      cancelable: true,
      pointerType: "mouse",
    });
    act(() => {
      expect(options[0]?.dispatchEvent(pointerDown)).toBe(false);
      options[0]?.click();
    });
    expect(onSelect).toHaveBeenCalledWith(mentions[0]);
    expect(document.querySelector('[role="status"]')?.textContent).toBe(
      "2 results available",
    );
  });

  it("keeps an empty slash listbox mounted and announces the zero-result context", () => {
    render(
      <SlashCommandMenu
        open
        items={[]}
        activeIndex={0}
        query="unknown"
        onSelect={vi.fn()}
        onHover={vi.fn()}
      />,
    );

    const listbox = document.getElementById(AI_SLASH_LISTBOX_ID);
    expect(listbox?.getAttribute("role")).toBe("listbox");
    expect(listbox?.querySelectorAll('[role="option"]')).toHaveLength(0);
    expect(document.querySelector('[role="status"]')?.textContent).toBe(
      "No slash commands match unknown",
    );
  });

  it("gives every slash result a stable selected option id", () => {
    const items = filterSlashCommands("su");
    render(
      <SlashCommandMenu
        open
        items={items}
        activeIndex={0}
        query="su"
        onSelect={vi.fn()}
        onHover={vi.fn()}
      />,
    );

    const option = document.querySelector<HTMLButtonElement>('[role="option"]');
    expect(items).toHaveLength(2);
    expect(option?.id).toBe(slashCommandOptionId(items[0]));
    expect(option?.tabIndex).toBe(-1);
    expect(option?.getAttribute("aria-selected")).toBe("true");
  });
});

function render(node: ReactElement): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(node));
}
