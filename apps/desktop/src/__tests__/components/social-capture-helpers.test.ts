// Tests for the pure social-capture logic behind the Forms page's
// Social capture section (social_capture — catalog/validate bodies
// are loose maps, so the readers are defensive by design).

import { describe, expect, it } from "vitest";

import {
  answersCount,
  buildRuleInput,
  buildTapLinkInput,
  catalogNetworks,
  leadIdentity,
  newRuleDraft,
  newTapLinkDraft,
  parseTriggerPhrases,
  ruleVerdict,
  triggerPhrasesText,
} from "../../components/forms/social-capture-helpers";

describe("parseTriggerPhrases", () => {
  it("splits on commas and newlines, trims, drops empties", () => {
    expect(parseTriggerPhrases("GUIDE, FREEBIE\n  promo ,")).toEqual([
      "GUIDE",
      "FREEBIE",
      "promo",
    ]);
  });
  it("de-dupes case-insensitively, first casing wins", () => {
    expect(parseTriggerPhrases("Guide, GUIDE, guide")).toEqual(["Guide"]);
  });
  it("empty text → empty list", () => {
    expect(parseTriggerPhrases("  ")).toEqual([]);
  });
});

describe("triggerPhrasesText", () => {
  it("joins for the editor, tolerates undefined", () => {
    expect(triggerPhrasesText(["A", "B"])).toBe("A, B");
    expect(triggerPhrasesText(undefined)).toBe("");
  });
});

describe("catalogNetworks", () => {
  it("reads an array-of-objects catalog", () => {
    const nets = catalogNetworks({
      networks: [
        { key: "instagram", label: "Instagram", capabilities: ["dm", "comment"] },
        { key: "tiktok" },
      ],
    });
    expect(nets).toEqual([
      { key: "instagram", label: "Instagram", capabilities: ["dm", "comment"] },
      { key: "tiktok", label: "tiktok", capabilities: [] },
    ]);
  });
  it("reads a map-keyed catalog", () => {
    const nets = catalogNetworks({
      networks: { instagram: { label: "Instagram", capabilities: ["dm"] } },
    });
    expect(nets).toEqual([
      { key: "instagram", label: "Instagram", capabilities: ["dm"] },
    ]);
  });
  it("accepts `network` as the key field and bare strings", () => {
    const nets = catalogNetworks({ networks: [{ network: "x" }, "youtube"] });
    expect(nets.map((n) => n.key)).toEqual(["x", "youtube"]);
  });
  it("[] on junk — the UI says so instead of guessing", () => {
    expect(catalogNetworks(null)).toEqual([]);
    expect(catalogNetworks({})).toEqual([]);
    expect(catalogNetworks({ networks: 42 })).toEqual([]);
    // non-string capabilities are dropped, not coerced
    expect(
      catalogNetworks({ networks: [{ key: "a", capabilities: [1, "dm"] }] })[0]!
        .capabilities,
    ).toEqual(["dm"]);
  });
});

describe("ruleVerdict", () => {
  it("reads a well-formed verdict", () => {
    expect(
      ruleVerdict({ valid: false, errors: ["bad"], warnings: ["meh"] }),
    ).toEqual({ valid: false, errors: ["bad"], warnings: ["meh"] });
  });
  it("null valid flag when the body doesn't carry one", () => {
    expect(ruleVerdict({ something: 1 })).toEqual({
      valid: null,
      errors: [],
      warnings: [],
    });
    expect(ruleVerdict(null)).toEqual({ valid: null, errors: [], warnings: [] });
  });
  it("stringifies structured error entries instead of dropping them", () => {
    const v = ruleVerdict({ valid: false, errors: [{ field: "name" }] });
    expect(v.errors).toEqual(['{"field":"name"}']);
  });
});

describe("buildRuleInput", () => {
  it("builds a rule with trimmed optionals", () => {
    const r = buildRuleInput({
      name: " IG capture ",
      network: "instagram",
      triggerPhrasesText: "GUIDE, FREEBIE",
      replyTemplate: " Thanks! ",
      targetListId: "list-1",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rule).toEqual({
      name: "IG capture",
      network: "instagram",
      status: "active",
      trigger_phrases: ["GUIDE", "FREEBIE"],
      reply_template: "Thanks!",
      target_list_id: "list-1",
    });
  });
  it("omits blank optionals", () => {
    const r = buildRuleInput({
      ...newRuleDraft(),
      name: "X",
      network: "tiktok",
      triggerPhrasesText: "GO",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect("reply_template" in r.rule).toBe(false);
    expect("target_list_id" in r.rule).toBe(false);
  });
  it("requires name, network, and at least one phrase", () => {
    expect(buildRuleInput(newRuleDraft())).toMatchObject({ ok: false, field: "name" });
    expect(
      buildRuleInput({ ...newRuleDraft(), name: "X" }),
    ).toMatchObject({ ok: false, field: "network" });
    expect(
      buildRuleInput({ ...newRuleDraft(), name: "X", network: "n" }),
    ).toMatchObject({ ok: false, field: "triggerPhrases" });
  });
});

describe("buildTapLinkInput", () => {
  const valid = {
    ...newTapLinkDraft(),
    name: "Story opt-in",
    destinationPhone: "+14155551234",
    keyword: "JOIN",
    messageBody: "JOIN — sign me up",
  };
  it("builds a link with required fields only", () => {
    const r = buildTapLinkInput(valid);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.link).toEqual({
      name: "Story opt-in",
      status: "active",
      destination_phone: "+14155551234",
      keyword: "JOIN",
      message_body: "JOIN — sign me up",
    });
  });
  it("includes trimmed consent + success URL when set", () => {
    const r = buildTapLinkInput({
      ...valid,
      consentText: " consent ",
      successUrl: "https://x.example/thanks",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.link.consent_text).toBe("consent");
    expect(r.link.success_url).toBe("https://x.example/thanks");
  });
  it("rejects non-E.164 phones", () => {
    for (const p of ["4155551234", "+0123", "+1 415 555", ""]) {
      expect(
        buildTapLinkInput({ ...valid, destinationPhone: p }),
      ).toMatchObject({ ok: false, field: "destinationPhone" });
    }
  });
  it("rejects missing keyword/message and non-http success URLs", () => {
    expect(buildTapLinkInput({ ...valid, keyword: " " })).toMatchObject({
      ok: false,
      field: "keyword",
    });
    expect(buildTapLinkInput({ ...valid, messageBody: "" })).toMatchObject({
      ok: false,
      field: "messageBody",
    });
    expect(
      buildTapLinkInput({ ...valid, successUrl: "ftp://x" }),
    ).toMatchObject({ ok: false, field: "successUrl" });
  });
});

describe("leadIdentity", () => {
  it("prefers email, then phone, then network user id", () => {
    expect(
      leadIdentity({ subscriber_email: "a@b.c", phone_e164: "+1", external_user_id: "u" }),
    ).toBe("a@b.c");
    expect(leadIdentity({ phone_e164: "+14155551234" })).toBe("+14155551234");
    expect(leadIdentity({ external_user_id: "ig-123" })).toBe("user ig-123");
    expect(leadIdentity({})).toBe("—");
  });
});

describe("answersCount", () => {
  it("counts answer keys, zero when missing", () => {
    expect(answersCount({ a: 1, b: "x" })).toBe(2);
    expect(answersCount(undefined)).toBe(0);
  });
});
