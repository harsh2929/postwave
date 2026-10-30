/**
 * lib/flowNodeDetail.test.ts — the facts printed under a step, and the two
 * rules that keep them honest: a missing required field is its OWN fact, and
 * nothing absent is ever rendered as zero.
 *
 * The field PLACEMENT asserted here was verified against the runtime's own
 * node struct — `AutomationNode` in
 * services/automation/internal/canonical/types.go:319 — where
 * `duration_seconds`, `template_id`, `sms_body`, `webhook_url` and `condition`
 * are TOP-LEVEL json fields, while `action` and `metadata` are nested objects.
 * apps/web writes graphs in exactly that shape (see lib/flow-starters.ts).
 * That matters: the server's own `missingRequiredFields` (flowbuilder.go:825)
 * looks these up under a node's `action` map instead, which is a different
 * shape from the one real stored graphs use — so this module deliberately
 * follows the CANONICAL runtime struct rather than that validator.
 */
import { describe, expect, it } from "vitest";

import { flowDelayLabel, flowNodeFacts, flowNodeIncomplete } from "./flowNodeDetail";
import type { MobileFlowNode } from "./flowWire";

function node(type: string, raw: Record<string, unknown> = {}): MobileFlowNode {
  return { id: "n", type, trueNext: null, falseNext: null, raw: { id: "n", type, ...raw } };
}

describe("flowDelayLabel", () => {
  it("formats whole units, at most two of them", () => {
    expect(flowDelayLabel(86_400)).toBe("1 day");
    expect(flowDelayLabel(3 * 86_400)).toBe("3 days");
    expect(flowDelayLabel(3_600)).toBe("1 hour");
    expect(flowDelayLabel(5_400)).toBe("1 hour 30 minutes");
    expect(flowDelayLabel(45)).toBe("45 seconds");
  });

  it("distinguishes a deliberate zero delay from an unset one", () => {
    // "No delay" is a decision someone made; null is a field nobody filled.
    expect(flowDelayLabel(0)).toBe("No delay");
    expect(flowDelayLabel(undefined)).toBeNull();
    expect(flowDelayLabel(null)).toBeNull();
    expect(flowDelayLabel("")).toBeNull();
  });

  it("returns null rather than a nonsense duration for bad input", () => {
    expect(flowDelayLabel(-5)).toBeNull();
    expect(flowDelayLabel(Number.NaN)).toBeNull();
    expect(flowDelayLabel("soon")).toBeNull();
  });
});

describe("flowNodeFacts — the incomplete rule", () => {
  it("marks a send_email with no template as incomplete, not as blank", () => {
    // The server's validator treats exactly this as the thing that makes a
    // graph non-executable; rendering an empty line would hide it.
    const facts = flowNodeFacts(node("send_email"));

    expect(facts).toEqual([
      { label: "Template", value: "not set", incomplete: true },
    ]);
    expect(flowNodeIncomplete(node("send_email"))).toBe(true);
  });

  it("reads a template that IS set from the node's top level", () => {
    const facts = flowNodeFacts(node("send_email", { template_id: "tpl-9" }));

    expect(facts).toEqual([{ label: "Template", value: "tpl-9" }]);
    expect(flowNodeIncomplete(node("send_email", { template_id: "tpl-9" }))).toBe(
      false,
    );
  });

  it("never renders a wait with no duration as zero seconds", () => {
    expect(flowNodeFacts(node("wait"))).toEqual([
      { label: "Waits", value: "not set", incomplete: true },
    ]);
  });

  it("surfaces send-time optimisation beside the delay it changes", () => {
    const facts = flowNodeFacts(
      node("wait", { duration_seconds: 86_400, delay_strategy: "optimized" }),
    );

    expect(facts).toEqual([
      { label: "Waits", value: "1 day" },
      { label: "Timing", value: "Send-time optimised" },
    ]);
  });
});

describe("flowNodeFacts — nested shapes", () => {
  it("reads action.kind from the nested action object", () => {
    expect(flowNodeFacts(node("action", { action: { kind: "add_tag" } }))).toEqual([
      { label: "Does", value: "add_tag" },
    ]);
  });

  it("reads the coupon pool from nested metadata", () => {
    expect(
      flowNodeFacts(
        node("coupon_assign", { metadata: { coupon_pool_id: "pool-3" } }),
      ),
    ).toEqual([{ label: "Pool", value: "pool-3" }]);
  });

  it("reads wait_until_trigger's nested trigger type", () => {
    expect(
      flowNodeFacts(
        node("wait_until_trigger", { wait_trigger: { type: "tag_added" } }),
      ),
    ).toEqual([{ label: "Waits for", value: "tag_added" }]);
  });

  it("reports a condition's SHAPE rather than paraphrasing a predicate", () => {
    expect(
      flowNodeFacts(node("branch", { condition: { rules: [{}, {}] } })),
    ).toEqual([{ label: "Condition", value: "2 rules" }]);
  });

  it("treats a non-object condition as missing rather than as configured", () => {
    expect(flowNodeFacts(node("branch"))).toEqual([
      { label: "Condition", value: "not set", incomplete: true },
    ]);
  });

  it("counts split variants", () => {
    expect(
      flowNodeFacts(node("percentage_split", { variants: [{}, {}, {}] })),
    ).toEqual([{ label: "Variants", value: "3 variants" }]);
    expect(flowNodeFacts(node("ab_test"))).toEqual([
      { label: "Variants", value: "not set", incomplete: true },
    ]);
  });
});

describe("flowNodeFacts — unknown types", () => {
  it("contributes no facts for a step this build does not understand", () => {
    // Which keeps it rendering as a plain titled row rather than as broken.
    expect(flowNodeFacts(node("send_whatsapp", { body: "hi" }))).toEqual([]);
    expect(flowNodeIncomplete(node("send_whatsapp"))).toBe(false);
  });

  it("contributes no facts for the control types that carry no config", () => {
    expect(flowNodeFacts(node("exit"))).toEqual([]);
    expect(flowNodeFacts(node("manual_review"))).toEqual([]);
  });
});
