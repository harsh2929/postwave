// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// Render coverage for NodeProperties — the property panel of the semantic
// block editor, and the heaviest handler surface in the app (70 onChange /
// onClick closures in one file).
//
// WHY THIS FILE EXISTS. NodeProperties is not unreached — the block editor
// renders it, and semantic-block-editor.test.tsx mounts one node of every type
// through the palette. But the palette only ever produces createNode()
// DEFAULTS, and the defaults are the empty case for exactly the branches that
// carry the interesting logic: an offer with no availability window, a
// structured-data block whose declaration is always `discount_offer`, an order
// with no items, a node with no conditions and no localizations, a list with
// one item so both reorder buttons are disabled. v8 measured node-properties
// at 21% of statements and 18% of functions under that suite.
//
// So this file drives the panel directly, with props shaped like a tree that
// came back from the API rather than one the palette just minted.
import { act, useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { NodeProperties } from "@/components/semantic-email/node-properties";
import { createNode } from "@/lib/semantic-email/authoring";
import {
  NODE_TYPES,
  type Diagnostic,
  type NodeType,
  type SemanticNode,
} from "@/lib/semantic-email/types";

import { clickEveryControl, renderPage, unmount } from "../pages/_harness";

/**
 * The panel is a controlled component: it renders `node` and reports edits
 * through `onChange`. Tests that only need to observe what an edit PRODUCES
 * mount it uncontrolled with a spy, which is also what makes the click sweep
 * meaningful — nothing is removed from the DOM mid-sweep, so every button is
 * still attached when its turn comes.
 */
function Panel({
  node,
  nodes,
  diagnostics = [],
  onChange,
}: {
  node: SemanticNode;
  nodes?: readonly SemanticNode[];
  diagnostics?: readonly Diagnostic[];
  onChange: (next: SemanticNode) => void;
}) {
  return (
    <NodeProperties
      node={node}
      index={0}
      nodes={nodes ?? [node]}
      diagnostics={diagnostics}
      onChange={onChange}
    />
  );
}

/** Stateful variant, for the few assertions about what the panel shows AFTER an edit. */
function LivePanel({ initial }: { initial: SemanticNode }) {
  const [node, setNode] = useState(initial);
  return <Panel node={node} onChange={setNode} />;
}

/**
 * The field counterpart of clickEveryControl.
 *
 * clickEveryControl presses buttons; most of this panel is not buttons. Of the
 * ~70 handler closures in node-properties.tsx the large majority hang off an
 * <input> or a <select>, and none of them had ever been fired by anything. This
 * edits every enabled field and reports what broke.
 *
 * Single-option selects are skipped rather than counted: a <select> whose only
 * option is already selected has nothing to change to, so dispatching on it
 * would inflate the denominator without exercising a handler.
 */
async function changeEveryField(
  container: HTMLElement,
): Promise<{ changed: number; failures: string[] }> {
  const failures: string[] = [];
  let changed = 0;
  const inputValue = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )!.set!;
  const selectValue = Object.getOwnPropertyDescriptor(
    HTMLSelectElement.prototype,
    "value",
  )!.set!;

  const fields = [
    ...container.querySelectorAll<HTMLInputElement | HTMLSelectElement>(
      "input, select",
    ),
  ].filter((field) => !field.disabled);

  for (const field of fields) {
    const name = field.id || field.getAttribute("aria-label") || field.tagName;
    try {
      if (field.tagName === "SELECT") {
        const select = field as HTMLSelectElement;
        const next = [...select.options]
          .map((option) => option.value)
          .find((value) => value !== select.value);
        if (next === undefined) continue;
        await act(async () => {
          selectValue.call(select, next);
          select.dispatchEvent(new Event("change", { bubbles: true }));
        });
      } else {
        const input = field as HTMLInputElement;
        await act(async () => {
          if (input.type === "checkbox") {
            input.click();
          } else {
            inputValue.call(input, input.type === "number" ? "7" : "edited");
            input.dispatchEvent(new Event("input", { bubbles: true }));
          }
        });
      }
      changed += 1;
    } catch (error) {
      failures.push(
        `${name}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return { changed, failures };
}

/** A structured-data node whose declaration is the requested kind. */
function structured(kind: "promotion_card" | "event_reservation" | "order"): SemanticNode {
  const node = createNode("structured_data", "9");
  const declaration =
    kind === "promotion_card"
      ? {
          promotion_card: {
            image_node_id: "",
            action_node_id: "",
            headline_node_id: "",
            price_node_id: "",
            discount_value_node_id: "",
            position: 0,
          },
        }
      : kind === "event_reservation"
        ? {
            event_reservation: {
              reservation_number_node_id: "",
              under_name_node_id: "",
              event_name_node_id: "",
              start_datetime_node_id: "",
              location_node_id: "",
              status_node_id: "",
              status: "confirmed",
              action_node_id: "",
            },
          }
        : {
            order: {
              merchant_node_id: "",
              order_number_node_id: "",
              total_node_id: "",
              action_node_id: "",
              items: [
                { product_node_id: "", price_node_id: "", quantity_node_id: "" },
              ],
            },
          };
  node.content.structured_data = {
    ...node.content.structured_data!,
    kind,
    use_case: kind === "promotion_card" ? "gmail_promotion" : "gmail_transaction",
    declaration,
  };
  return node;
}

function optionValues(select: HTMLSelectElement | null): string[] {
  expect(select).not.toBeNull();
  return [...select!.options].map((option) => option.value);
}

/** Drive a native <select> the way a real change does. */
async function choose(select: HTMLSelectElement | null, value: string) {
  expect(select).not.toBeNull();
  const setter = Object.getOwnPropertyDescriptor(
    HTMLSelectElement.prototype,
    "value",
  )!.set!;
  await act(async () => {
    setter.call(select!, value);
    select!.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

// ---------------------------------------------------------------------------

/**
 * One editor per member of the closed union, keyed by something only that
 * branch renders. Deleting or mis-guarding any `{type === "x" && ...}` block
 * fails here; so does renaming a control id the block editor's own tests
 * address by id.
 */
const PER_TYPE: Record<NodeType, { text: string; controlId: string | null }> = {
  heading: { text: "Heading text", controlId: "semantic-node-0-level" },
  paragraph: {
    text: "Paragraph text",
    controlId: "semantic-node-0-paragraph-run-0-text",
  },
  list: { text: "Ordered list", controlId: "semantic-node-0-item-0-run-0-text" },
  answer: { text: "Question", controlId: "semantic-node-0-question-run-0-text" },
  legal: { text: "Legal text", controlId: "semantic-node-0-legal-run-0-text" },
  action: { text: "Canonical URL", controlId: "semantic-node-0-action-url" },
  image: { text: "Alt text", controlId: "semantic-node-0-image-alt" },
  datetime: {
    text: "Event date & time",
    controlId: "semantic-node-0-datetime-rfc3339",
  },
  money: {
    text: "Currency (ISO 4217)",
    controlId: "semantic-node-0-money-amount",
  },
  deadline: { text: "Deadline", controlId: "semantic-node-0-deadline-timezone" },
  offer: {
    text: "Canonical offer id (optional)",
    controlId: "semantic-node-0-offer-code",
  },
  location: {
    text: "Place name",
    controlId: "semantic-node-0-location-postal_code",
  },
  product: { text: "SKU (optional)", controlId: "semantic-node-0-product-sku" },
  fact: { text: "Label", controlId: "semantic-node-0-fact-value" },
  personalization: {
    text: "Semantic class",
    controlId: "semantic-node-0-personalization-fallback",
  },
  structured_data: {
    text: "Structured data declares provider markup",
    controlId: "semantic-node-0-structured-kind",
  },
  divider: { text: "A divider has no content", controlId: null },
  poll: { text: "Poll id", controlId: "semantic-node-0-poll-option-1-id" },
};

describe("semantic node properties", () => {
  it("renders the editor that belongs to each member of the closed union", async () => {
    for (const type of NODE_TYPES) {
      const node = createNode(type as NodeType, "1");
      const { text, container, root } = await renderPage(Panel, {
        node,
        onChange: vi.fn(),
      });
      try {
        const expected = PER_TYPE[type as NodeType];
        expect(text, `content editor for ${type}`).toContain(expected.text);
        if (expected.controlId !== null) {
          expect(
            container.querySelector(`#${expected.controlId}`),
            `control ${expected.controlId} for ${type}`,
          ).not.toBeNull();
        }
        // The three fields every node carries, whatever its type.
        expect(container.querySelector("#semantic-node-0-id")).not.toBeNull();
        expect(container.querySelector("#semantic-node-0-role")).not.toBeNull();
        expect(container.querySelector("#semantic-node-0-source")).not.toBeNull();
        expect(text).toContain("Conditions (0)");
      } finally {
        unmount(root);
      }
    }
  });

  it("keeps an imported role that its type forbids visible instead of silently swapping it", async () => {
    // A tree that arrived from the API may carry a role this type does not
    // allow. The picker is populated from ROLES_BY_TYPE, so without the escape
    // option the <select> would show the FIRST allowed role and the author
    // would believe the document says something it does not.
    const node = { ...createNode("paragraph", "1"), role: "unsubscribe" };
    const { container, root } = await renderPage(Panel, {
      node,
      onChange: vi.fn(),
    });
    try {
      const role = container.querySelector<HTMLSelectElement>(
        "#semantic-node-0-role",
      );
      expect(optionValues(role)).toEqual(["body", "unsubscribe"]);
      expect(role!.value).toBe("unsubscribe");
      expect(role!.textContent).toContain("not valid here");
    } finally {
      unmount(root);
    }
  });

  it("names an imported node type it cannot edit instead of erasing it", async () => {
    // types.ts keeps `type` as a plain string precisely so an unsupported
    // value from the API is representable "so it can be reported, not
    // silently dropped". The panel used to drop it anyway: the role picker is
    // populated from ROLES_BY_TYPE, so an unknown type produced an EMPTY
    // <select>, no content editor, and the type string nowhere on screen — a
    // node that reads as blank rather than as unknown.
    const node = { ...createNode("paragraph", "1"), type: "carousel" };
    const { text, container, root } = await renderPage(Panel, {
      node,
      onChange: vi.fn(),
    });
    try {
      // The type is named, and the panel says plainly that it cannot edit it.
      expect(text).toContain("carousel");
      expect(text).toMatch(/cannot edit/i);
      // No content editor is a fact about this build, not about the node: the
      // paragraph editor must not be borrowed for a type that is not one.
      expect(
        container.querySelector("#semantic-node-0-paragraph-run-0-text"),
      ).toBeNull();
      // And the role survives, the same way an invalid role does for a known
      // type — an empty picker would show nothing and report nothing.
      const role = container.querySelector<HTMLSelectElement>(
        "#semantic-node-0-role",
      );
      expect(optionValues(role)).toEqual(["body"]);
      expect(role!.value).toBe("body");
      expect(role!.textContent).toContain("not valid here");
    } finally {
      unmount(root);
    }
  });

  it("offers only nodes of a permitted type as a structured-data reference", async () => {
    // The whole point of structured data is that the markup and the copy
    // cannot disagree: it names nodes that are already visible. A picker that
    // offered the wrong kind of node would produce markup a provider silently
    // ignores, which is invisible in the rendered email.
    const offer = { ...createNode("offer", "1"), id: "the_offer" };
    const image = { ...createNode("image", "2"), id: "the_image" };
    const action = { ...createNode("action", "3"), id: "the_action" };
    const money = { ...createNode("money", "4"), id: "the_money" };
    const heading = { ...createNode("heading", "5"), id: "the_heading" };
    const siblings = [offer, image, action, money, heading];

    const promo = createNode("structured_data", "9");
    promo.content.structured_data = {
      ...promo.content.structured_data!,
      kind: "promotion_card",
      use_case: "gmail_promotion",
      declaration: {
        promotion_card: {
          image_node_id: "the_image",
          action_node_id: "the_action",
          headline_node_id: "",
          price_node_id: "",
          discount_value_node_id: "",
          position: 3,
        },
      },
    };

    const { container, root } = await renderPage(Panel, {
      node: promo,
      nodes: [...siblings, promo],
      onChange: vi.fn(),
    });
    try {
      // allowed: ["image"] — the action, money and heading nodes must not be
      // offered, and the empty sentinel says the reference is required.
      expect(
        optionValues(
          container.querySelector<HTMLSelectElement>(
            "#semantic-node-0-structured-image_node_id",
          ),
        ),
      ).toEqual(["", "the_image"]);
      // allowed: ["heading","paragraph","fact","product"], optional
      const headline = container.querySelector<HTMLSelectElement>(
        "#semantic-node-0-structured-headline_node_id",
      );
      expect(optionValues(headline)).toEqual(["", "the_heading"]);
      expect(headline!.options[0].textContent).toBe("— none —");
      // allowed: ["money"]
      expect(
        optionValues(
          container.querySelector<HTMLSelectElement>(
            "#semantic-node-0-structured-price_node_id",
          ),
        ),
      ).toEqual(["", "the_money"]);
      // The position field is the promotion card's own, not a node reference.
      expect(
        container.querySelector<HTMLInputElement>(
          "#semantic-node-0-structured-position",
        )!.value,
      ).toBe("3");
      // A different declaration's controls must not leak in.
      expect(
        container.querySelector("#semantic-node-0-structured-offer"),
      ).toBeNull();
    } finally {
      unmount(root);
    }
  });

  it("renders one reference row per order item and appends a blank item", async () => {
    const onChange = vi.fn();
    const order = createNode("structured_data", "9");
    order.content.structured_data = {
      ...order.content.structured_data!,
      kind: "order",
      use_case: "gmail_transaction",
      declaration: {
        order: {
          merchant_node_id: "",
          order_number_node_id: "",
          total_node_id: "",
          action_node_id: "",
          items: [
            { product_node_id: "", price_node_id: "", quantity_node_id: "" },
            { product_node_id: "", price_node_id: "", quantity_node_id: "" },
          ],
        },
      },
    };

    const { text, container, root } = await renderPage(Panel, {
      node: order,
      onChange,
    });
    try {
      // Three references per item, addressed by item index, plus a labelled
      // remove for each — an unlabelled one would be "button, button" to a
      // screen reader.
      expect(text).toContain("Product (item 1)");
      expect(text).toContain("Quantity fact (item 2)");
      expect(
        container.querySelector(
          "#semantic-node-0-structured-item-1-price_node_id",
        ),
      ).not.toBeNull();
      expect(
        container.querySelector('[aria-label="Remove order item 2"]'),
      ).not.toBeNull();

      const add = [...container.querySelectorAll("button")].find(
        (button) => button.textContent === "+ Add order item",
      );
      expect(add).toBeDefined();
          await act(async () => {
        add!.click();
      });
      const next = onChange.mock.calls.at(-1)![0] as SemanticNode;
      expect(next.content.structured_data!.declaration.order!.items).toHaveLength(3);
      expect(
        next.content.structured_data!.declaration.order!.items[2],
      ).toEqual({
        product_node_id: "",
        price_node_id: "",
        quantity_node_id: "",
      });
    } finally {
      unmount(root);
    }
  });

  it("shows a condition's value only for the equality operators, and drops it on the others", async () => {
    const onChange = vi.fn();
    const node = createNode("paragraph", "1");
    node.conditions = [
      { id: "cond_1", slot_id: "tier", operator: "equals", value: "gold" },
      { id: "cond_2", slot_id: "coupon", operator: "present", value: "" },
    ];

    const { text, container, root } = await renderPage(Panel, {
      node,
      onChange,
    });
    try {
      expect(text).toContain("Conditions (2)");
      // equals carries a value…
      const value = container.querySelector<HTMLInputElement>(
        "#semantic-node-0-condition-0-value",
      );
      expect(value).not.toBeNull();
      expect(value!.value).toBe("gold");
      // …present cannot, so the control is not offered at all.
      expect(
        container.querySelector("#semantic-node-0-condition-1-value"),
      ).toBeNull();

      // Switching away from an equality operator must clear the value rather
      // than carry over a comparand the author never typed — present/absent
      // forbid one, and it would fail validation on save.
      await choose(
        container.querySelector<HTMLSelectElement>(
          "#semantic-node-0-condition-0-operator",
        ),
        "absent",
      );
      const next = onChange.mock.calls.at(-1)![0] as SemanticNode;
      expect(next.conditions[0]).toEqual({
        id: "cond_1",
        slot_id: "tier",
        operator: "absent",
        value: "",
      });
      // The untouched condition is preserved.
      expect(next.conditions[1].id).toBe("cond_2");
    } finally {
      unmount(root);
    }
  });

  it("routes a diagnostic to the field its JSON Pointer addresses", async () => {
    // The reason diagnostics live under the control rather than in a summary
    // is that a list of "3 problems" addressed by JSON Pointer is a puzzle. So
    // the routing is the feature: the message must land on the URL field, and
    // only that field must be marked invalid.
    const node = createNode("action", "1");
    const diagnostics: Diagnostic[] = [
      {
        severity: "error",
        code: "https_required",
        path: "/nodes/0/content/action/canonical_url",
        message: "action URL must be absolute http(s)",
      },
    ];
    const { text, container, root } = await renderPage(Panel, {
      node,
      diagnostics,
      onChange: vi.fn(),
    });
    try {
      expect(text).toContain("action URL must be absolute http(s)");
      expect(text).toContain("https_required");
      expect(
        container
          .querySelector("#semantic-node-0-action-url")!
          .getAttribute("aria-invalid"),
      ).toBe("true");
      expect(
        container
          .querySelector("#semantic-node-0-action-label")!
          .getAttribute("aria-invalid"),
      ).toBe("false");
    } finally {
      unmount(root);
    }
  });

  it("adds and removes an offer availability window", async () => {
    // createNode leaves both windows null, so the block editor's own suite
    // never renders these DateTimeFields at all.
    const initial = createNode("offer", "1");
    const { text, container, root } = await renderPage(LivePanel, { initial });
    try {
      expect(text).not.toContain("Availability starts");
      const addStart = [...container.querySelectorAll("button")].find(
        (button) => button.textContent === "Add start",
      );
      expect(addStart).toBeDefined();
          await act(async () => {
        addStart!.click();
      });
      expect(container.textContent).toContain("Availability starts");
      expect(
        container.querySelector<HTMLInputElement>(
          "#semantic-node-0-offer-starts-timezone",
        )!.value,
      ).toBe("UTC");
      // The same button now removes it — one control, two states.
      const removeStart = [...container.querySelectorAll("button")].find(
        (button) => button.textContent === "Remove start",
      );
      expect(removeStart).toBeDefined();
      await act(async () => {
        removeStart!.click();
      });
      expect(container.textContent).not.toContain("Availability starts");
    } finally {
      unmount(root);
    }
  });

  it("reports localizations it will not let the block editor re-point", async () => {
    const node = createNode("paragraph", "1");
    node.localizations = {
      "fr-FR": { paragraph: { text: { runs: [] } } },
      "de-DE": { paragraph: { text: { runs: [] } } },
    };
    const { text, root } = await renderPage(Panel, { node, onChange: vi.fn() });
    try {
      expect(text).toContain("2 localization(s)");
      // Sorted, so the note reads the same whatever order the map decoded in.
      expect(text).toContain("de-DE, fr-FR");
    } finally {
      unmount(root);
    }
  });

  it("fires every enabled button, and every one of them is named", async () => {
    // The panel carries ~70 handler closures. Mounted uncontrolled, nothing is
    // detached mid-sweep, so each button's handler really runs. This asserts
    // no handler explodes and that all of them are wired — not that any of
    // them does the right thing.
    const onChange = vi.fn();
    const node = createNode("list", "1");
    node.content.list = {
      ordered: false,
      items: [
        { runs: [{ kind: "text", text: "One", url: "", accessible_label: "", slot: null }] },
        { runs: [{ kind: "text", text: "Two", url: "", accessible_label: "", slot: null }] },
        { runs: [{ kind: "text", text: "Three", url: "", accessible_label: "", slot: null }] },
      ],
    };
    node.conditions = [
      { id: "cond_1", slot_id: "tier", operator: "equals", value: "gold" },
    ];

    const { container, root } = await renderPage(Panel, { node, onChange });
    try {
      const buttons = [...container.querySelectorAll("button")];
      const unnamed = buttons.filter(
        (button) =>
          (button.getAttribute("aria-label") ?? button.textContent ?? "").trim() ===
          "",
      );
      expect(unnamed.map((button) => button.outerHTML)).toEqual([]);

      const { clicked, failures } = await clickEveryControl(container);
      expect(failures).toEqual([]);
      // 31 of 39 buttons on this fixture; the other 8 are the correctly
      // disabled ends of the four reorder pairs.
      expect(clicked).toBeGreaterThan(20);
      // Every button in this panel is an edit. If one were ever added with no
      // handler — or with a handler that swallows its own change — the counts
      // would part company here.
      expect(onChange.mock.calls).toHaveLength(clicked);
    } finally {
      unmount(root);
    }
  });

  it("reports an edit from every field it renders, for every node type", async () => {
    // The button sweep above covers the reorder/add/remove closures. This
    // covers the other and much larger half: a field rendered without an
    // onChange, or one whose handler throws on a value the author can type,
    // is a box that looks editable and silently is not.
    let total = 0;
    const shapes: Array<{ label: string; node: SemanticNode }> = [
      ...NODE_TYPES.map((type) => ({
        label: type,
        node: createNode(type as NodeType, "1"),
      })),
      { label: "structured_data/promotion_card", node: structured("promotion_card") },
      { label: "structured_data/event_reservation", node: structured("event_reservation") },
      { label: "structured_data/order", node: structured("order") },
      {
        label: "conditions",
        node: {
          ...createNode("divider", "1"),
          conditions: [
            { id: "cond_1", slot_id: "tier", operator: "equals", value: "gold" },
          ],
        },
      },
    ];

    for (const shape of shapes) {
      const onChange = vi.fn();
      const { container, root } = await renderPage(Panel, {
        node: shape.node,
        onChange,
      });
      try {
        const { changed, failures } = await changeEveryField(container);
        expect(failures, `field failures for ${shape.label}`).toEqual([]);
        expect(changed, `fields edited for ${shape.label}`).toBeGreaterThan(1);
        expect(
          onChange.mock.calls.length,
          `edits reported for ${shape.label}`,
        ).toBe(changed);
        // Wired is not enough: a handler that reports the value it already had
        // keeps the counts honest while losing the keystroke. Every reported
        // edit must differ from the node the panel was given.
        const before = JSON.stringify(shape.node);
        const inert = onChange.mock.calls
          .map(([next]) => next as SemanticNode)
          .filter((next) => JSON.stringify(next) === before);
        expect(inert, `edits that changed nothing for ${shape.label}`).toEqual([]);
        total += changed;
      } finally {
        unmount(root);
      }
    }
    // Guards against the sweep quietly shrinking to nothing if a fixture stops
    // rendering its editor.
    expect(total).toBeGreaterThan(80);
  });
});
