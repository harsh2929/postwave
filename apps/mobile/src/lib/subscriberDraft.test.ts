import { describe, expect, it } from "vitest";

import {
  addDraftTag,
  createSubscriberErrorMessage,
  EMPTY_SUBSCRIBER_DRAFT,
  looksLikeEmail,
  removeDraftTag,
  subscriberCreateBody,
  UNCONFIRMED_CREATE_NOTICE,
  validateSubscriberDraft,
} from "./subscriberDraft";

describe("looksLikeEmail", () => {
  it("accepts ordinary addresses", () => {
    for (const ok of [
      "a@b.co",
      "first.last+tag@sub.example.com",
      "UPPER@Example.COM",
    ]) {
      expect(looksLikeEmail(ok)).toBe(true);
    }
  });

  it("rejects only the certainly-wrong shapes", () => {
    for (const bad of [
      "",
      "nope",
      "@example.com",
      "a@",
      "a@b",
      "a@@b.com",
      "a b@c.com",
      "a@.com",
      "a@com.",
    ]) {
      expect(looksLikeEmail(bad)).toBe(false);
    }
  });
});

describe("validateSubscriberDraft", () => {
  it("says nothing about an empty field the user has not filled yet", () => {
    const v = validateSubscriberDraft(EMPTY_SUBSCRIBER_DRAFT);
    expect(v.canSubmit).toBe(false);
    expect(v.emailHint).toBeNull();
  });

  it("hints once the address is non-empty and wrong", () => {
    const v = validateSubscriberDraft({
      ...EMPTY_SUBSCRIBER_DRAFT,
      email: "nope",
    });
    expect(v.canSubmit).toBe(false);
    expect(v.emailHint).toMatch(/email address/i);
  });

  it("submits on a valid address alone — the server needs nothing else", () => {
    expect(
      validateSubscriberDraft({
        ...EMPTY_SUBSCRIBER_DRAFT,
        email: "  someone@example.com ",
      }).canSubmit,
    ).toBe(true);
  });
});

describe("draft tags", () => {
  it("dedupes case-insensitively and trims", () => {
    let d = addDraftTag(EMPTY_SUBSCRIBER_DRAFT, "  VIP ");
    d = addDraftTag(d, "vip");
    expect(d.tags).toEqual(["VIP"]);
  });

  it("ignores an empty tag", () => {
    expect(addDraftTag(EMPTY_SUBSCRIBER_DRAFT, "   ").tags).toEqual([]);
  });

  it("truncates at the server's rune ceiling rather than being rejected", () => {
    const long = "é".repeat(200);
    const d = addDraftTag(EMPTY_SUBSCRIBER_DRAFT, long);
    expect(Array.from(d.tags[0] ?? "")).toHaveLength(64);
  });

  it("removes by exact value", () => {
    const d = addDraftTag(EMPTY_SUBSCRIBER_DRAFT, "vip");
    expect(removeDraftTag(d, "vip").tags).toEqual([]);
  });
});

describe("subscriberCreateBody", () => {
  it("sends the address and OMITS status so the server default applies", () => {
    const body = subscriberCreateBody({
      ...EMPTY_SUBSCRIBER_DRAFT,
      email: " Someone@Example.com ",
    });
    expect(body).toEqual({ email: "Someone@Example.com" });
    expect("status" in body).toBe(false);
  });

  it("never sends empty name/tag keys", () => {
    const body = subscriberCreateBody({
      email: "a@b.co",
      firstName: "  ",
      lastName: "",
      tags: [],
    });
    expect(Object.keys(body)).toEqual(["email"]);
  });

  it("includes names and tags when present", () => {
    expect(
      subscriberCreateBody({
        email: "a@b.co",
        firstName: "Ada",
        lastName: "Lovelace",
        tags: ["vip"],
      }),
    ).toEqual({
      email: "a@b.co",
      first_name: "Ada",
      last_name: "Lovelace",
      tags: ["vip"],
    });
  });
});

describe("copy", () => {
  it("states non-sendability rather than implying a subscribe", () => {
    expect(UNCONFIRMED_CREATE_NOTICE).toMatch(/won't receive marketing/i);
    expect(UNCONFIRMED_CREATE_NOTICE).toMatch(/Unconfirmed/);
  });

  it("maps the server's specific create failures", () => {
    expect(createSubscriberErrorMessage(409, "email_taken", "")).toMatch(
      /already belongs/i,
    );
    expect(createSubscriberErrorMessage(409, "erasure_blocked", "")).toMatch(
      /data-subject request/i,
    );
    expect(createSubscriberErrorMessage(403, undefined, "")).toMatch(/role/i);
    expect(createSubscriberErrorMessage(402, undefined, "")).toMatch(/limit/i);
  });

  it("prefers the server's own sentence for anything else", () => {
    expect(createSubscriberErrorMessage(400, "validation_failed", "bad email")).toBe(
      "bad email",
    );
  });
});
