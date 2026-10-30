// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// Behaviour of the semantic block editor, exercised through the DOM the way an
// author uses it.
//
// The three properties under test are the ones that decide whether this
// surface is usable at all:
//
//   1. It can express every member of the closed node union, and for each one
//      it offers exactly the roles that type allows — no more.
//   2. Reordering works from the keyboard, with focus following the block, so
//      "move this up three" is possible without a mouse.
//   3. An invalid tree cannot leave the editor. Validation runs as the author
//      types, and the hand-off to the campaign draft refuses on any error.

import { act } from "react";
import type { Root } from "react-dom/client";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { trackRoot, unmountRoots } from "./_roots";

import { SemanticBlockEditor } from "@/components/semantic-email/semantic-block-editor";
import { createNode, stageNodes } from "@/lib/semantic-email/authoring";
import {
  NODE_TYPES,
  ROLES_BY_TYPE,
  type NodeType,
  type SemanticNode,
} from "@/lib/semantic-email/types";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

let host: HTMLDivElement | null = null;
let root: Root | null = null;
let staged: Array<Record<string, unknown>> | null = null;
let current: SemanticNode[] = [];

afterEach(() => {
  // Every root, not only the last: a test that mounts again replaces `root`,
  // and the root it replaced would otherwise stay mounted for the whole file.
  unmountRoots();
  host?.remove();
  host = null;
  root = null;
  staged = null;
  current = [];
});

function Harness({ initial }: { initial: SemanticNode[] }) {
  const [nodes, setNodes] = useState<SemanticNode[]>(initial);
  current = nodes;
  return (
    <SemanticBlockEditor
      nodes={nodes}
      onNodesChange={(next) => {
        current = next;
        setNodes(next);
      }}
      onStage={(next) => {
        staged = next;
      }}
    />
  );
}

async function mount(initial: SemanticNode[]) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = trackRoot(host);
  await act(async () => {
    root!.render(<Harness initial={initial} />);
  });
}

async function click(element: Element | null) {
  expect(element).not.toBeNull();
  await act(async () => {
    (element as HTMLElement).click();
  });
}

/** Drive a controlled input the way a real keystroke does. */
async function type(element: Element | null, value: string) {
  expect(element).not.toBeNull();
  const field = element as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )!.set!;
  await act(async () => {
    setter.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function paletteButton(label: string): HTMLButtonElement {
  const buttons = [
        ...host!.querySelectorAll('[aria-label="Block palette"] button'),
      ];
  const found = buttons.find((button) =>
    button.textContent?.startsWith(label),
  ) as HTMLButtonElement | undefined;
  if (!found) throw new Error(`no palette button for ${label}`);
  return found;
}

function paragraph(id: string): SemanticNode {
  const node = createNode("paragraph", id);
  node.id = id;
  return node;
}

describe("semantic block editor", () => {
  it("offers every node type in the closed union, with only that type's roles", async () => {
    await mount([]);
    // The palette offers the union and nothing else.
    expect(
      [...host!.querySelectorAll('[aria-label="Block palette"] button')],
    ).toHaveLength(NODE_TYPES.length);

    // Sweep the class: every member of the union, not a sample of three.
    for (const type of NODE_TYPES) {
      await mount([]);
      const buttons = [
        ...host!.querySelectorAll('[aria-label="Block palette"] button'),
      ];
      const target = buttons.find(
        (button) =>
          button.querySelector("div")?.textContent ===
          paletteLabelFor(type as NodeType),
      );
      await click(target ?? null);

      expect(current).toHaveLength(1);
      expect(current[0].type).toBe(type);

      const roleSelect = host!.querySelector<HTMLSelectElement>(
        "#semantic-node-0-role",
      );
      expect(roleSelect, `role select missing for ${type}`).not.toBeNull();
      const offered = [...roleSelect!.options].map((option) => option.value);
      expect(offered, `roles offered for ${type}`).toEqual([
        ...ROLES_BY_TYPE[type as NodeType],
      ]);

      act(() => root?.unmount());
      host?.remove();
      host = null;
      root = null;
      current = [];
    }
  });

  it("never produces a structurally invalid node for any type in the union", async () => {
    // The factory picks type, role and content together, so the classes of
    // failure that the union exists to prevent cannot be authored at all.
    const structural = new Set([
      "content_cardinality",
      "content_type_mismatch",
      "role_type_mismatch",
      "node_version_unsupported",
      "invalid_enum",
    ]);
    const { validateNodes } = await import("@/lib/semantic-email/authoring");
    for (const type of NODE_TYPES) {
      const node = createNode(type as NodeType, "1");
      const diagnostics = validateNodes([node]);
      const structuralFailures = diagnostics.filter((diagnostic) =>
        structural.has(diagnostic.code),
      );
      expect(structuralFailures, `structural diagnostics for ${type}`).toEqual([]);
    }
  });

  it("reorders with the keyboard and keeps focus on the moved block", async () => {
    await mount([paragraph("alpha"), paragraph("bravo"), paragraph("charlie")]);

    const moveUp = host!.querySelector<HTMLButtonElement>(
      '[data-focus-key="move-up-charlie"]',
    );
    expect(moveUp).not.toBeNull();
    // The control is reachable and described for a screen reader, not a drag
    // handle with a title attribute.
    expect(moveUp!.getAttribute("aria-label")).toBe(
      "Move Paragraph charlie up to position 2",
    );

    await click(moveUp);
    expect(current.map((node) => node.id)).toEqual(["alpha", "charlie", "bravo"]);

    // Focus followed the block, so a second press moves it again without the
    // author having to find the button.
    expect(
      (document.activeElement as HTMLElement | null)?.getAttribute(
        "data-focus-key",
      ),
    ).toBe("move-up-charlie");

    await click(
      host!.querySelector('[data-focus-key="move-up-charlie"]'),
    );
    expect(current.map((node) => node.id)).toEqual(["charlie", "alpha", "bravo"]);

    // And the move is announced rather than left to be discovered visually.
    const live = host!.querySelector('[aria-live="polite"]');
    expect(live?.textContent).toContain("moved to position 1 of 3");
  });

  it("adds and removes blocks at the cursor", async () => {
    await mount([paragraph("alpha")]);
    await click(paletteButton("Divider"));
    expect(current.map((node) => node.type)).toEqual(["paragraph", "divider"]);

    await click(
      host!.querySelector('[aria-label^="Remove Paragraph alpha"]'),
    );
    expect(current.map((node) => node.type)).toEqual(["divider"]);
  });

  it("surfaces a duplicate poll option id inline, as the id is typed", async () => {
    await mount([createNode("poll", "1")]);

    const secondOptionID = host!.querySelector<HTMLInputElement>(
      "#semantic-node-0-poll-option-1-id",
    );
    expect(secondOptionID).not.toBeNull();
    expect(secondOptionID!.value).toBe("option_2");

    // No error yet: two distinct ids are two distinct choices.
    expect(host!.textContent).not.toContain("merge two choices into one tally");

    // The author retypes the second option's id to match the first.
    await type(secondOptionID, "option_1");

    // Reported immediately, on the field that is wrong — not at save time, and
    // not as "3 problems" at the top of the page.
    expect(host!.textContent).toContain("merge two choices into one tally");
    expect(secondOptionID!.getAttribute("aria-invalid")).toBe("true");
  });

  it("refuses to stage a tree with errors, and stages a valid one", async () => {
    await mount([createNode("poll", "1")]);

    const stageButton = [...host!.querySelectorAll("button")].find(
      (button) => button.textContent === "Stage semantic source",
    ) as HTMLButtonElement;
    expect(stageButton.disabled).toBe(false);

    const secondOptionID = host!.querySelector<HTMLInputElement>(
      "#semantic-node-0-poll-option-1-id",
    );
    await type(secondOptionID, "option_1");

    const blockedButton = [...host!.querySelectorAll("button")].find(
      (button) => button.textContent === "Stage semantic source",
    ) as HTMLButtonElement;
    expect(blockedButton.disabled).toBe(true);

    // The disabled attribute is only the visible half, and React will not
    // deliver a click to a button its own props mark disabled, so the DOM
    // cannot bypass it. What the DOM CAN check is that the button's state and
    // the hand-off are the same decision: run the exact function the handler
    // runs, over the exact tree on screen.
    expect(stageNodes(current).ok).toBe(false);
    expect(stageNodes(current).nodes).toBeNull();
    expect(staged).toBeNull();

    // Restoring a unique id unblocks it and the staged payload is the wire
    // shape the API stores.
    await type(
      host!.querySelector("#semantic-node-0-poll-option-1-id"),
      "option_2",
    );
    const readyButton = [...host!.querySelectorAll("button")].find(
      (button) => button.textContent === "Stage semantic source",
    ) as HTMLButtonElement;
    expect(readyButton.disabled).toBe(false);
    await click(readyButton);
    expect(staged).not.toBeNull();
    expect(staged).toHaveLength(1);
    expect((staged![0] as { type: string }).type).toBe("poll");
  });

  it("previews both projections from the same compile", async () => {
    await mount([createNode("paragraph", "1")]);
    const frame = host!.querySelector("iframe");
    expect(frame?.getAttribute("sandbox")).toBe("");
    expect(frame?.getAttribute("srcdoc")).toContain(
      'data-postwave-node="paragraph_1"',
    );

    const textTab = [...host!.querySelectorAll('[role="tab"]')].find(
      (tab) => tab.textContent === "Plain text",
    );
    await click(textTab ?? null);
    const pre = host!.querySelector("pre");
    expect(pre?.textContent).toBe("Body copy.\n");
  });
});

function paletteLabelFor(type: NodeType): string {
  const labels: Record<NodeType, string> = {
    heading: "Heading",
    paragraph: "Paragraph",
    list: "List",
    answer: "Question & answer",
    legal: "Legal / footer",
    action: "Action",
    image: "Image",
    datetime: "Date & time",
    money: "Price",
    deadline: "Deadline",
    offer: "Offer",
    location: "Location",
    product: "Product",
    fact: "Fact",
    personalization: "Personalization",
    structured_data: "Structured data",
    divider: "Divider",
    poll: "Poll",
  };
  return labels[type];
}
