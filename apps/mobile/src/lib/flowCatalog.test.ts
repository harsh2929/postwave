/**
 * The catalogue's whole job is to STOP this app describing a graph with a table
 * it transcribed by hand. These tests are about that one property and about the
 * three ways it could go wrong: overriding a good local label with nothing,
 * losing the local table when the server omits a key, and accepting a body that
 * is not a catalogue at all.
 */
import { describe, expect, it } from "vitest";

import {
  FLOW_CATALOG_SCHEMA,
  STATIC_FLOW_LABELS,
  flowCatalogSchemaKnown,
  flowLabels,
  parseFlowCatalog,
} from "@/lib/flowCatalog";
import { flowNodeLabel, flowTriggerLabel } from "@/lib/flowTopology";

/** A trimmed but structurally exact `Catalog()` body (flowbuilder.go:452). */
const SERVER_CATALOG = {
  schema_version: FLOW_CATALOG_SCHEMA,
  runtime: {
    capability: "flow_execution",
    runtime_status: "unavailable",
    execution_enabled: false,
  },
  statuses: ["draft", "active", "paused", "archived"],
  condition_fields: [
    {
      key: "custom.predicted_churn_risk",
      label: "Predicted churn risk",
      type: "number",
      category: "predictive",
    },
  ],
  triggers: [
    {
      key: "list_joined",
      label: "Joined list",
      category: "trigger",
      runtime_status: "unavailable",
      fields: [{ key: "list_id", type: "string", required: true }],
    },
  ],
  nodes: [
    {
      key: "send_email",
      label: "Email message",
      category: "message",
      channel: "email",
      runtime_status: "unavailable",
      requires_review: true,
      fields: [{ key: "template_id", type: "string", required: true }],
    },
    {
      key: "wait",
      label: "Time delay",
      category: "wait",
      runtime_status: "unavailable",
      fields: [
        { key: "duration_seconds", type: "number", required: true },
        {
          key: "delay_strategy",
          type: "select",
          options: ["fixed", "optimized"],
        },
      ],
    },
  ],
  actions: [
    {
      key: "add_tag",
      label: "Add tag",
      category: "tag",
      runtime_status: "unavailable",
    },
  ],
};

describe("parseFlowCatalog", () => {
  it("reads the server's catalogue", () => {
    const catalog = parseFlowCatalog(SERVER_CATALOG);
    expect(catalog).not.toBeNull();
    expect(catalog!.schemaVersion).toBe(FLOW_CATALOG_SCHEMA);
    expect(catalog!.nodes).toHaveLength(2);
    expect(catalog!.triggers).toHaveLength(1);
    expect(catalog!.actions).toHaveLength(1);
    expect(catalog!.statuses).toEqual([
      "draft",
      "active",
      "paused",
      "archived",
    ]);
    expect(catalog!.conditionFields[0]?.category).toBe("predictive");
  });

  it("keeps FieldSpec.required as declared, and only as declared", () => {
    const wait = parseFlowCatalog(SERVER_CATALOG)!.nodes.find(
      (n) => n.key === "wait",
    )!;
    expect(wait.fields.find((f) => f.key === "duration_seconds")?.required).toBe(
      true,
    );
    // `required` is omitempty: its ABSENCE is false, and a truthy-looking
    // value must not manufacture a constraint the server never declared.
    const strategy = wait.fields.find((f) => f.key === "delay_strategy")!;
    expect(strategy.required).toBe(false);
    expect(strategy.options).toEqual(["fixed", "optimized"]);
  });

  it("returns null for a body that is not a catalogue", () => {
    // The persisted query cache can hand back a value written by an older
    // build's fetcher. Each of these must leave the local table in play rather
    // than replace every label with a raw key.
    expect(parseFlowCatalog(null)).toBeNull();
    expect(parseFlowCatalog({})).toBeNull();
    expect(parseFlowCatalog({ nodes: [] })).toBeNull();
    expect(parseFlowCatalog({ items: [] })).toBeNull();
    expect(parseFlowCatalog("<html>gateway error</html>")).toBeNull();
  });

  it("drops a catalogue entry with no key rather than keying a list on ''", () => {
    const catalog = parseFlowCatalog({
      nodes: [{ key: "wait", label: "Time delay" }, { label: "Nameless" }],
    });
    expect(catalog!.nodes.map((n) => n.key)).toEqual(["wait"]);
  });

  it("falls back to the KEY when the server ships one with no label", () => {
    const catalog = parseFlowCatalog({ nodes: [{ key: "send_whatsapp" }] });
    expect(catalog!.nodes[0]?.label).toBe("send_whatsapp");
  });
});

describe("flowLabels", () => {
  it("with no catalogue, behaves exactly as the shipped mirror", () => {
    const labels = flowLabels(null);
    expect(labels.node("send_email")).toBe(flowNodeLabel("send_email"));
    expect(labels.trigger("list_joined")).toBe(flowTriggerLabel("list_joined"));
    expect(labels).toBe(STATIC_FLOW_LABELS);
  });

  it("NAMES A NODE TYPE THIS BUILD HAS NEVER HEARD OF — the whole point", () => {
    // The local mirror can only ever describe the catalogue as of the day this
    // build shipped. A workspace on a newer API renders `send_whatsapp` as its
    // raw key on a phone and as "WhatsApp message" everywhere else.
    expect(flowNodeLabel("send_whatsapp")).toBe("send_whatsapp");
    expect(flowTriggerLabel("cart_abandoned")).toBe("cart_abandoned");

    const labels = flowLabels(
      parseFlowCatalog({
        nodes: [{ key: "send_whatsapp", label: "WhatsApp message" }],
        triggers: [{ key: "cart_abandoned", label: "Abandoned cart" }],
      }),
    );
    expect(labels.node("send_whatsapp")).toBe("WhatsApp message");
    expect(labels.trigger("cart_abandoned")).toBe("Abandoned cart");
  });

  it("keeps the local label for a key the catalogue does not mention", () => {
    // A MISS is not the same as "no catalogue". A partial catalogue must not
    // strip names off the node types this build does know.
    const labels = flowLabels(
      parseFlowCatalog({ nodes: [{ key: "send_whatsapp", label: "WhatsApp" }] }),
    );
    expect(labels.node("coupon_assign")).toBe("Assign coupon");
    expect(labels.trigger("tag_added")).toBe("Tag added");
  });

  it("still falls back to the raw key for a type nobody knows", () => {
    const labels = flowLabels(parseFlowCatalog(SERVER_CATALOG));
    expect(labels.node("teleport")).toBe("teleport");
    expect(labels.trigger("mind_read")).toBe("mind_read");
  });

  it("survives a REHYDRATED value that is not a catalogue at all", () => {
    // The persisted query cache can hand a `MobileFlowCatalog`-typed slot a
    // payload written by an older build's fetcher. `.map` on that throws inside
    // render, and the error boundary turns a thrown render into a blank screen
    // with no way back — so the type is not treated as a guarantee.
    const junk = { items: [], nextCursor: null } as unknown as Parameters<
      typeof flowLabels
    >[0];
    expect(() => flowLabels(junk)).not.toThrow();
    expect(flowLabels(junk).node("send_email")).toBe("Email message");
    expect(flowLabels(junk).trigger("list_joined")).toBe("Joined list");
  });

  it("prefers the server's wording when the two disagree", () => {
    const labels = flowLabels(
      parseFlowCatalog({ nodes: [{ key: "wait", label: "Pause" }] }),
    );
    expect(flowNodeLabel("wait")).toBe("Time delay");
    expect(labels.node("wait")).toBe("Pause");
  });
});

describe("flowCatalogSchemaKnown", () => {
  it("is true only for the schema this build was written against", () => {
    expect(flowCatalogSchemaKnown(parseFlowCatalog(SERVER_CATALOG))).toBe(true);
    expect(
      flowCatalogSchemaKnown(
        parseFlowCatalog({
          ...SERVER_CATALOG,
          schema_version: "klv04.flow-builder.v2",
        }),
      ),
    ).toBe(false);
    expect(flowCatalogSchemaKnown(null)).toBe(false);
  });
});
