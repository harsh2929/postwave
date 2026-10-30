// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// The campaign's semantic authoring surface now has two views over the SAME
// node array: a block editor over the closed union, and the original JSON
// escape hatch.
//
// The JSON view is not legacy. It is the only view that can round-trip a
// document this build does not fully model — the `opaque` field below is
// exactly that case — and dropping it in favour of a nicer editor would turn
// "we cannot show you this" into silent data loss on save. So these tests keep
// asserting the JSON path's losslessness, plus the new rule that the block
// editor REFUSES such a document rather than partially understanding it.

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CampaignSemanticSourceEditor } from "@/app/(dashboard)/app/campaigns/[id]/campaign-semantic-source-editor";

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

(
  globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  }
).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

/** A node carrying a field this build does not model. */
const OPAQUE_NODE = { id: "cta", type: "action", opaque: { kept: true } };

/** A node the block editor can open. */
const MODELLED_NODE = {
  id: "title",
  type: "heading",
  role: "heading",
  version: 2,
  content: {
    heading: { level: 1, text: { runs: [{ kind: "text", text: "Hi" }] } },
  },
  conditions: [],
  localizations: {},
  provenance: { source: "user" },
};

function render(
  enabled: boolean,
  nodes: Array<Record<string, unknown>>,
  onChange = vi.fn(),
): { root: Root; onChange: typeof onChange } {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      createElement(CampaignSemanticSourceEditor, {
        enabled,
        nodes,
        factContract: { schema_version: 1 },
        onChange,
      }),
    );
  });
  return { root, onChange };
}

function textarea(id: string): HTMLTextAreaElement {
  const value = document.getElementById(id);
  if (!(value instanceof HTMLTextAreaElement)) throw new Error(`missing ${id}`);
  return value;
}

function buttonWithText(text: string): HTMLButtonElement | null {
  return (
    ([...document.querySelectorAll("button")].find(
      (candidate) => candidate.textContent === text,
    ) as HTMLButtonElement | undefined) ?? null
  );
}

function openJSONView(): void {
  const tab = buttonWithText("JSON");
  if (!tab) throw new Error("missing JSON tab");
  act(() => tab.click());
}

async function pressTab(target: HTMLButtonElement, key: string): Promise<void> {
  await act(async () => {
    target.dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
    );
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

function change(target: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    "value",
  )?.set;
  setter?.call(target, value);
  target.dispatchEvent(new Event("input", { bubbles: true }));
  target.dispatchEvent(new Event("change", { bubbles: true }));
}

describe("CampaignSemanticSourceEditor", () => {
  it("moves between authoring views with arrows, Home, and End", async () => {
    const { root } = render(true, [MODELLED_NODE]);
    try {
      const list = document.querySelector('[role="tablist"]');
      const blocks = buttonWithText("Blocks");
      const json = buttonWithText("JSON");
      if (!blocks || !json) throw new Error("missing authoring tabs");

      expect(list?.getAttribute("aria-label")).toBe("Semantic authoring view");
      expect((list as HTMLElement | null)?.tabIndex).toBe(0);
      expect([blocks.tabIndex, json.tabIndex]).toEqual([-1, -1]);
      await act(async () => {
        blocks.focus();
        await new Promise((resolve) => window.setTimeout(resolve, 0));
      });
      expect([blocks.tabIndex, json.tabIndex]).toEqual([0, -1]);

      await pressTab(blocks, "ArrowRight");
      expect(document.activeElement).toBe(json);
      expect(json.getAttribute("aria-selected")).toBe("true");
      expect(textarea("campaign-semantic-nodes")).toBeTruthy();

      await pressTab(json, "Home");
      expect(document.activeElement).toBe(blocks);
      expect(blocks.getAttribute("aria-selected")).toBe("true");

      await pressTab(blocks, "End");
      expect(document.activeElement).toBe(json);
      expect(json.getAttribute("aria-selected")).toBe("true");
    } finally {
      act(() => root.unmount());
    }
  });

  it("shows exact semantic evidence read-only while the rollout flag is off", () => {
    const { root, onChange } = render(false, [MODELLED_NODE]);
    try {
      // No way to change anything from the block view…
      expect(buttonWithText("Stage semantic source")?.disabled).toBe(true);
      const palette = [
        ...document.querySelectorAll('[aria-label="Block palette"] button'),
      ];
      expect(palette.length).toBeGreaterThan(0);
      expect(
        palette.every((button) => (button as HTMLButtonElement).disabled),
      ).toBe(true);

      // …and the JSON view is evidence, not an input.
      openJSONView();
      expect(textarea("campaign-semantic-nodes").readOnly).toBe(true);
      expect(textarea("campaign-fact-contract").readOnly).toBe(true);
      expect(buttonWithText("Apply semantic source")).toBeNull();
      expect(onChange).not.toHaveBeenCalled();
    } finally {
      act(() => root.unmount());
    }
  });

  it("stages the node array and Fact Contract together without legacy conversion", () => {
    const { root, onChange } = render(true, [OPAQUE_NODE]);
    try {
      openJSONView();
      act(() => {
        change(
          textarea("campaign-semantic-nodes"),
          '[{"id":"cta","type":"action","opaque":{"kept":true}}]',
        );
        change(
          textarea("campaign-fact-contract"),
          '{"schema_version":1,"primary_action":{"action_id":"go"}}',
        );
      });
      const button = buttonWithText("Apply semantic source");
      if (!button) throw new Error("missing apply");
      act(() => button.click());

      expect(onChange).toHaveBeenCalledTimes(1);
      expect(onChange).toHaveBeenCalledWith({
        nodes: [{ id: "cta", type: "action", opaque: { kept: true } }],
        factContract: {
          schema_version: 1,
          primary_action: { action_id: "go" },
        },
      });
    } finally {
      act(() => root.unmount());
    }
  });

  it("does not stage a partial source when either JSON root has the wrong shape", () => {
    const { root, onChange } = render(true, [OPAQUE_NODE]);
    try {
      openJSONView();
      act(() => {
        change(textarea("campaign-semantic-nodes"), "{}");
      });
      const button = buttonWithText("Apply semantic source");
      if (!button) throw new Error("missing apply");
      act(() => button.click());
      expect(onChange).not.toHaveBeenCalled();
    } finally {
      act(() => root.unmount());
    }
  });

  it("opens a document it cannot model in the JSON view rather than half-understanding it", () => {
    const { root } = render(true, [OPAQUE_NODE]);
    try {
      // It did not land on Blocks: the JSON textarea is on screen already.
      expect(textarea("campaign-semantic-nodes")).toBeTruthy();

      const blocksTab = buttonWithText("Blocks");
      if (!blocksTab) throw new Error("missing Blocks tab");
      act(() => blocksTab.click());

      // And choosing Blocks explains the refusal instead of dropping the field.
      expect(document.body.textContent).toContain(
        "cannot be opened in the block editor",
      );
      expect(document.body.textContent).toContain('unknown field "opaque"');
      expect(buttonWithText("Stage semantic source")).toBeNull();
    } finally {
      act(() => root.unmount());
    }
  });

  it("opens a modelled document in the block editor", () => {
    const { root } = render(true, [MODELLED_NODE]);
    try {
      expect(document.getElementById("campaign-semantic-nodes")).toBeNull();
      expect(buttonWithText("Stage semantic source")).not.toBeNull();
      expect(
        (document.getElementById("semantic-node-0-id") as HTMLInputElement)
          .value,
      ).toBe("title");
    } finally {
      act(() => root.unmount());
    }
  });
});
