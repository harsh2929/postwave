import { describe, expect, it } from "vitest";

import {
  decodeSmsActivityFeed,
  decodeSmsConversationTags,
  decodeSmsNotesReceipt,
  decodeSmsTagMutationReceipt,
  smsNotesError,
  smsTagError,
} from "./smsConversationMeta";

const TENANT = "11111111-1111-4111-8111-111111111111";
const PHONE = "+15552345678";
const AT = "2026-08-21T09:00:00Z";
const SNAPSHOT = "2026-08-21T10:00:00Z";
const scope = { tenantId: TENANT, phoneE164: PHONE };
const BEL = String.fromCharCode(7);

describe("validators", () => {
  it("mirrors the server tag gate", () => {
    expect(smsTagError("refund")).toBeNull();
    expect(smsTagError("")).toContain("1 to 64");
    expect(smsTagError(" padded ")).toContain("1 to 64");
    expect(smsTagError("a".repeat(65))).toContain("64");
    expect(smsTagError("ab" + BEL + "c")).toContain("control");
  });

  it("mirrors the server notes gate", () => {
    expect(smsNotesError("customer promised refund")).toBeNull();
    expect(smsNotesError(" padded")).toContain("whitespace");
    expect(smsNotesError("a".repeat(4001))).toContain("4,000");
  });
});

describe("decodeSmsConversationTags", () => {
  const raw = (over: Record<string, unknown> = {}) => ({
    tenantId: TENANT,
    phoneE164: PHONE,
    tags: [{ tag: "refund", createdAt: AT }],
    snapshotAt: SNAPSHOT,
    truncated: false,
    ...over,
  });

  it("decodes the inventory with each tag's CAS createdAt", () => {
    const page = decodeSmsConversationTags(raw(), scope);
    expect(page.tags).toEqual([{ tag: "refund", createdAt: AT }]);
    expect(page.truncated).toBe(false);
  });

  it("refuses another phone, duplicates, and unknown keys", () => {
    expect(() =>
      decodeSmsConversationTags(raw({ phoneE164: "+15552345679" }), scope),
    ).toThrow(/another phone/);
    expect(() =>
      decodeSmsConversationTags(
        raw({
          tags: [
            { tag: "refund", createdAt: AT },
            { tag: "refund", createdAt: AT },
          ],
        }),
        scope,
      ),
    ).toThrow(/duplicates/);
    expect(() =>
      decodeSmsConversationTags(raw({ notes: "x" }), scope),
    ).toThrow(/not part of the contract/);
  });
});

describe("decodeSmsTagMutationReceipt", () => {
  const raw = (over: Record<string, unknown> = {}) => ({
    ok: true,
    tenantId: TENANT,
    phoneE164: PHONE,
    tag: "refund",
    createdAt: AT,
    action: "add",
    ...over,
  });

  it("checks the receipt against the request", () => {
    const receipt = decodeSmsTagMutationReceipt(raw(), {
      ...scope,
      tag: "refund",
      action: "add",
    });
    expect(receipt.createdAt).toBe(AT);
    expect(() =>
      decodeSmsTagMutationReceipt(raw({ tag: "vip" }), {
        ...scope,
        tag: "refund",
        action: "add",
      }),
    ).toThrow(/does not match/);
    expect(() =>
      decodeSmsTagMutationReceipt(raw({ action: "remove" }), {
        ...scope,
        tag: "refund",
        action: "add",
      }),
    ).toThrow(/does not match/);
  });
});

describe("decodeSmsNotesReceipt", () => {
  it("requires the notes action and returns the fresh CAS token", () => {
    const receipt = decodeSmsNotesReceipt(
      {
        ok: true,
        tenantId: TENANT,
        phoneE164: PHONE,
        action: "notes",
        stateUpdatedAt: SNAPSHOT,
      },
      scope,
    );
    expect(receipt.stateUpdatedAt).toBe(SNAPSHOT);
    expect(() =>
      decodeSmsNotesReceipt(
        {
          ok: true,
          tenantId: TENANT,
          phoneE164: PHONE,
          action: "archive",
          stateUpdatedAt: SNAPSHOT,
        },
        scope,
      ),
    ).toThrow(/notes acknowledgment/);
  });
});

describe("decodeSmsActivityFeed", () => {
  const raw = (over: Record<string, unknown> = {}) => ({
    tenantId: TENANT,
    phoneE164: PHONE,
    events: [
      {
        kind: "consent",
        at: AT,
        title: "Consent granted",
        meta: { source: "keyword" },
      },
    ],
    snapshotAt: SNAPSHOT,
    truncated: false,
    sourcePlanes: ["sms_consent_events", "sms_subscriptions_current"],
    historyComplete: false,
    ...over,
  });

  it("decodes events and keeps the incompleteness bit", () => {
    const feed = decodeSmsActivityFeed(raw(), scope);
    expect(feed.events).toEqual([
      { kind: "consent", at: AT, title: "Consent granted" },
    ]);
    expect(feed.historyComplete).toBe(false);
  });

  it("refuses an unknown kind, a future event, and a complete-history claim", () => {
    expect(() =>
      decodeSmsActivityFeed(
        raw({ events: [{ kind: "operator", at: AT, title: "x" }] }),
        scope,
      ),
    ).toThrow(/kind is unknown/);
    expect(() =>
      decodeSmsActivityFeed(
        raw({
          events: [
            { kind: "consent", at: "2026-08-21T11:00:00Z", title: "x" },
          ],
        }),
        scope,
      ),
    ).toThrow(/response cutoff/);
    expect(() =>
      decodeSmsActivityFeed(raw({ historyComplete: true }), scope),
    ).toThrow(/contract forbids/);
  });
});
