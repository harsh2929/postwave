/**
 * The trigger-rule policy: row mapping must keep every rule VISIBLE (a rule
 * you cannot see is a rule you cannot pause), the draft validator must refuse
 * exactly what trigger_validation.go refuses, and the wire body must
 * canonicalise `exists` the way the server does.
 */
import { describe, expect, it } from "vitest";

import {
  EMPTY_TRIGGER_DRAFT,
  draftFromRule,
  isTriggerDraftDirty,
  normalizeTriggerRule,
  parseTriggerRuleList,
  triggerActionLine,
  triggerConditionLine,
  triggerDeleteConfirmCopy,
  triggerFiredLine,
  triggerInputFromDraft,
  triggerRulesSummary,
  triggerToggleCopy,
  utf8ByteLength,
  validateMatchOperand,
  validateTriggerDraft,
  validateTriggerJsonPath,
  type InboundTriggerRule,
  type TriggerRuleDraft,
} from "./inboundTriggerRules";

const WIRE = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  tenant_id: "t1",
  webhook_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  name: "Paid customer → onboarding",
  active: false,
  match_jsonpath: "$.event",
  match_operator: "equals",
  match_value: "customer.created",
  email_jsonpath: "$.customer.email",
  action_type: "add_tag",
  action_target_id: "paid",
  fired_count: 12,
  last_fired_at: "2026-09-02T09:00:00Z",
  created_at: "2026-08-01T00:00:00Z",
  updated_at: "2026-08-02T00:00:00Z",
};

const RULE = normalizeTriggerRule(WIRE) as InboundTriggerRule;

const VALID: TriggerRuleDraft = {
  name: "Paid → onboarding",
  matchJsonpath: "$.event",
  operator: "equals",
  matchValue: "customer.created",
  emailJsonpath: "$.customer.email",
  actionType: "add_to_sequence",
  actionTargetId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
};

describe("normalizeTriggerRule", () => {
  it("maps the wire row field for field", () => {
    expect(RULE).toEqual({
      id: WIRE.id,
      webhookId: WIRE.webhook_id,
      name: WIRE.name,
      active: false,
      matchJsonpath: "$.event",
      matchOperator: "equals",
      matchValue: "customer.created",
      emailJsonpath: "$.customer.email",
      actionType: "add_tag",
      actionTargetId: "paid",
      firedCount: 12,
      lastFiredAt: "2026-09-02T09:00:00Z",
      createdAt: WIRE.created_at,
      updatedAt: WIRE.updated_at,
    });
  });

  it("drops only a row with no id, and keeps a partial one visible", () => {
    expect(normalizeTriggerRule({ ...WIRE, id: "" })).toBeNull();
    expect(normalizeTriggerRule(null)).toBeNull();
    expect(normalizeTriggerRule("x")).toBeNull();
    const partial = normalizeTriggerRule({ id: "r1" });
    expect(partial?.name).toBe("Unnamed rule");
    expect(partial?.firedCount).toBe(0);
    expect(partial?.lastFiredAt).toBeNull();
    expect(partial?.matchValue).toBeNull();
  });

  it("reads a MISSING active flag as active — the safer misread for 'pause it'", () => {
    const { active: _drop, ...noFlag } = WIRE;
    void _drop;
    expect(normalizeTriggerRule(noFlag)?.active).toBe(true);
    expect(normalizeTriggerRule({ ...WIRE, active: true })?.active).toBe(true);
    expect(normalizeTriggerRule({ ...WIRE, active: false })?.active).toBe(false);
  });

  it("never invents a fired count", () => {
    expect(normalizeTriggerRule({ ...WIRE, fired_count: "12" })?.firedCount).toBe(0);
    expect(normalizeTriggerRule({ ...WIRE, fired_count: -3 })?.firedCount).toBe(0);
    expect(normalizeTriggerRule({ ...WIRE, fired_count: 2.9 })?.firedCount).toBe(2);
  });

  it("keeps a null match_value null rather than reading it as empty string", () => {
    expect(
      normalizeTriggerRule({ ...WIRE, match_operator: "exists", match_value: null })
        ?.matchValue,
    ).toBeNull();
  });
});

describe("parseTriggerRuleList", () => {
  it("reads the server's {items} envelope and tolerates a bare array", () => {
    expect(parseTriggerRuleList({ items: [WIRE, { nope: true }] })).toHaveLength(1);
    expect(parseTriggerRuleList([WIRE])).toHaveLength(1);
  });
  it("returns nothing for a shape it does not understand", () => {
    expect(parseTriggerRuleList({ items: "x" })).toEqual([]);
    expect(parseTriggerRuleList(undefined)).toEqual([]);
    expect(parseTriggerRuleList(42)).toEqual([]);
  });
});

describe("validateTriggerJsonPath (the bounded grammar)", () => {
  it.each(["$", "$.event", "$.a.b.c", "$.items[0]", "$.items[*].id", "$['a key']", '$["k"]'])(
    "accepts %s",
    (path) => expect(validateTriggerJsonPath(path)).toBeNull(),
  );
  it.each([
    ["", /start at the root/u],
    ["event", /start at the root/u],
    ["$..event", /Recursive descent/u],
    ["$.items[-1]", /non-negative array index/u],
    ["$.items[0:2]", /non-negative array index/u],
    ["$.items[", /closing \]/u],
    ["$.a b", /plain dotted/u],
    ["$foo", /must start with a dot/u],
    ["$['']", /one non-empty key/u],
    ["$['a\\'b']", /one non-empty key/u],
    [`$.${"x".repeat(520)}`, /512 bytes/u],
  ])("refuses %j with the reason", (path, reason) => {
    expect(validateTriggerJsonPath(path)).toMatch(reason);
  });
});

describe("validateMatchOperand", () => {
  it("needs no operand for exists", () => {
    expect(validateMatchOperand("exists", "")).toBeNull();
  });
  it("lets equals compare against an empty string but not contains", () => {
    expect(validateMatchOperand("equals", "")).toBeNull();
    expect(validateMatchOperand("contains", "")).toMatch(/non-empty/u);
  });
  it("refuses an empty, oversized, JS-only or unparseable regex", () => {
    expect(validateMatchOperand("regex", "")).toMatch(/non-empty/u);
    expect(validateMatchOperand("regex", "a".repeat(1025))).toMatch(/1024 bytes/u);
    expect(validateMatchOperand("regex", "(a)\\1")).toMatch(/RE2/u);
    expect(validateMatchOperand("regex", "(?<=a)b")).toMatch(/RE2/u);
    expect(validateMatchOperand("regex", "[")).toMatch(/valid regular/u);
    expect(validateMatchOperand("regex", "^customer\\.")).toBeNull();
  });
  it("caps the value at 4 KiB of UTF-8, not characters", () => {
    expect(validateMatchOperand("equals", "é".repeat(2049))).toMatch(/4 KiB/u);
    expect(validateMatchOperand("equals", "é".repeat(2048))).toBeNull();
  });
});

describe("validateTriggerDraft", () => {
  it("accepts the reference draft", () => {
    expect(validateTriggerDraft(VALID)).toEqual({});
  });
  it("requires a name within 256 BYTES without control characters", () => {
    expect(validateTriggerDraft({ ...VALID, name: "  " }).name).toMatch(/Enter a rule name/u);
    expect(validateTriggerDraft({ ...VALID, name: "é".repeat(129) }).name).toMatch(/256 bytes/u);
    expect(validateTriggerDraft({ ...VALID, name: "a\u0007b" }).name).toMatch(/unsupported/u);
  });
  it("demands a UUID target for sequence and automation actions", () => {
    expect(
      validateTriggerDraft({ ...VALID, actionTargetId: "onboarding" }).actionTargetId,
    ).toMatch(/UUID/u);
    expect(
      validateTriggerDraft({
        ...VALID,
        actionType: "start_automation",
        actionTargetId: "not-a-uuid",
      }).actionTargetId,
    ).toMatch(/UUID/u);
    expect(
      validateTriggerDraft({ ...VALID, actionType: "start_automation" }).actionTargetId,
    ).toBeUndefined();
  });
  it("bounds a tag target at 64 characters (runes, not bytes) with no control chars", () => {
    const tag = (target: string) =>
      validateTriggerDraft({ ...VALID, actionType: "add_tag", actionTargetId: target })
        .actionTargetId;
    expect(tag("")).toMatch(/Choose the target/u);
    expect(tag("é".repeat(64))).toBeUndefined();
    expect(tag("é".repeat(65))).toMatch(/1–64/u);
    expect(tag("a\tb")).toMatch(/control/u);
  });
  it("reports every failing field at once", () => {
    const errors = validateTriggerDraft({
      ...VALID,
      name: "",
      matchJsonpath: "nope",
      operator: "contains",
      matchValue: "",
      emailJsonpath: "$..x",
      actionTargetId: "",
    });
    expect(Object.keys(errors).sort()).toEqual([
      "actionTargetId",
      "emailJsonpath",
      "matchJsonpath",
      "matchValue",
      "name",
    ]);
  });
});

describe("wire body and draft round-trip", () => {
  it("trims, and sends match_value null for exists", () => {
    expect(
      triggerInputFromDraft({
        ...VALID,
        name: " Paid ",
        operator: "exists",
        matchValue: "stale",
        actionTargetId: ` ${VALID.actionTargetId} `,
      }),
    ).toEqual({
      name: "Paid",
      match_jsonpath: "$.event",
      match_operator: "exists",
      match_value: null,
      email_jsonpath: "$.customer.email",
      action_type: "add_to_sequence",
      action_target_id: VALID.actionTargetId,
    });
  });
  it("keeps the operand for every other operator, even an empty equals", () => {
    expect(triggerInputFromDraft({ ...VALID, matchValue: "" }).match_value).toBe("");
  });
  it("seeds the editor from a rule and from nothing", () => {
    expect(draftFromRule(RULE)).toEqual({
      name: WIRE.name,
      matchJsonpath: "$.event",
      operator: "equals",
      matchValue: "customer.created",
      emailJsonpath: "$.customer.email",
      actionType: "add_tag",
      actionTargetId: "paid",
    });
    expect(draftFromRule(null)).toEqual(EMPTY_TRIGGER_DRAFT);
    expect(draftFromRule(null)).not.toBe(EMPTY_TRIGGER_DRAFT);
  });
  it("is dirty only when a field differs", () => {
    const base = draftFromRule(RULE);
    expect(isTriggerDraftDirty({ ...base }, base)).toBe(false);
    expect(isTriggerDraftDirty({ ...base, matchValue: "x" }, base)).toBe(true);
  });
});

describe("row copy", () => {
  it("states the condition with a JSON-quoted operand, none for exists", () => {
    expect(triggerConditionLine(RULE)).toBe('When $.event equals "customer.created"');
    expect(
      triggerConditionLine({ ...RULE, matchOperator: "exists", matchValue: null }),
    ).toBe("When $.event exists");
  });
  it("names the action target: the tag verbatim, an id by its tail", () => {
    expect(triggerActionLine(RULE)).toBe("Email from $.customer.email → Add tag “paid”");
    expect(
      triggerActionLine({
        ...RULE,
        actionType: "add_to_sequence",
        actionTargetId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      }),
    ).toBe("Email from $.customer.email → Enroll in sequence …cccccccc");
  });
  it("reports the server's fired count and never derives one", () => {
    const now = Date.parse("2026-09-02T12:00:00Z");
    expect(triggerFiredLine({ ...RULE, firedCount: 0 }, now)).toBe("Never fired");
    expect(triggerFiredLine({ ...RULE, lastFiredAt: null }, now)).toBe("Fired 12 times");
    expect(triggerFiredLine({ ...RULE, firedCount: 1 }, now)).toMatch(/^Fired 1 time · last /u);
  });
  it("summarises the set with the paused count only when there is one", () => {
    expect(triggerRulesSummary([])).toBe("No rules yet");
    expect(triggerRulesSummary([{ ...RULE, active: true }])).toBe("1 rule");
    expect(triggerRulesSummary([RULE, { ...RULE, id: "2", active: true }])).toBe(
      "2 rules · 1 paused",
    );
  });
  it("offers the ACTION as the toggle label, in both directions", () => {
    expect(triggerToggleCopy({ ...RULE, active: true }).label).toBe("Pause");
    expect(triggerToggleCopy({ ...RULE, active: false }).label).toBe("Resume");
    expect(triggerToggleCopy({ ...RULE, active: true }).a11y).toMatch(/nothing is deleted/u);
  });
  it("carries the desktop's delete consequence, naming the rule", () => {
    const copy = triggerDeleteConfirmCopy(RULE);
    expect(copy.confirmLabel).toBe("Delete trigger");
    expect(copy.message).toContain(`“${WIRE.name}.”`);
    expect(copy.message).toMatch(/Pause it instead/u);
  });
});

describe("utf8ByteLength", () => {
  it("counts bytes, not code units", () => {
    expect(utf8ByteLength("abc")).toBe(3);
    expect(utf8ByteLength("é")).toBe(2);
    expect(utf8ByteLength("€")).toBe(3);
    expect(utf8ByteLength("😀")).toBe(4);
  });
});
