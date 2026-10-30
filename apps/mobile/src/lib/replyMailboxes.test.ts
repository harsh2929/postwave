import { describe, expect, it } from "vitest";

import {
  decodeReplyMailboxList,
  mailboxDeleteConsequence,
  mailboxHealth,
  mailboxSummary,
  mailboxTone,
  toReplyMailbox,
  type ReplyMailbox,
} from "./replyMailboxes";

function mailbox(over: Partial<ReplyMailbox> = {}): ReplyMailbox {
  return {
    id: "018f47f2-9f25-7f73-8ec6-3fd483eb51dd",
    label: "Support inbox",
    host: "imap.example.com",
    port: 993,
    useTLS: true,
    folder: "INBOX",
    usernameSecretRef: "env:POSTWAVE_REPLY_IMAP_TENANT_018F47F29F257F738EC63FD483EB51DD_USER",
    passwordSecretRef: "env:POSTWAVE_REPLY_IMAP_TENANT_018F47F29F257F738EC63FD483EB51DD_PASSWORD",
    enabled: true,
    lastPolledAt: "2026-08-18T11:00:00Z",
    lastError: "",
    securityQuarantinedAt: "",
    securityQuarantineReason: "",
    ...over,
  };
}

describe("mailboxHealth", () => {
  it("is polling when enabled and it has run", () => {
    expect(mailboxHealth(mailbox())).toBe("polling");
  });

  it("separates never-polled from polling", () => {
    // A mailbox enabled ten minutes ago that has not run is not the same as
    // one running fine; collapsing them lets a misconfiguration look healthy.
    expect(mailboxHealth(mailbox({ lastPolledAt: "" }))).toBe("never_polled");
  });

  it("is paused when disabled", () => {
    expect(mailboxHealth(mailbox({ enabled: false }))).toBe("paused");
  });

  it("reports FAILING even when the mailbox has been disabled", () => {
    // Rendering it as a calm "paused" hides the reason it was paused, and
    // last_error is only cleared by a successful poll.
    const m = mailbox({ enabled: false, lastError: "auth failed" });
    expect(mailboxHealth(m)).toBe("failing");
  });

  it("ignores a whitespace-only error", () => {
    expect(mailboxHealth(mailbox({ lastError: "   " }))).toBe("polling");
  });
});

describe("mailboxSummary", () => {
  it("shows the server's own error text verbatim", () => {
    // "Check your settings" throws away the one string that says which of six
    // things is wrong.
    const s = mailboxSummary(mailbox({ lastError: "LOGIN failed: invalid credentials" }));
    expect(s).toContain("LOGIN failed: invalid credentials");
  });

  it("names host, port and folder in every state", () => {
    for (const m of [
      mailbox(),
      mailbox({ enabled: false }),
      mailbox({ lastPolledAt: "" }),
      mailbox({ lastError: "boom" }),
    ]) {
      expect(mailboxSummary(m)).toContain("imap.example.com:993");
      expect(mailboxSummary(m)).toContain("INBOX");
    }
  });

  it("says a paused mailbox is not polling", () => {
    expect(mailboxSummary(mailbox({ enabled: false }))).toContain("not polling");
  });

  it("does not claim a poll time it does not have", () => {
    const s = mailboxSummary(mailbox({ lastPolledAt: "" }));
    expect(s).toContain("never completed a poll");
  });
});

describe("mailboxTone", () => {
  it("warns for failing and for never-polled", () => {
    expect(mailboxTone(mailbox({ lastError: "x" }))).toBe("warning");
    expect(mailboxTone(mailbox({ lastPolledAt: "" }))).toBe("warning");
  });

  it("is calm for healthy and for deliberately paused", () => {
    expect(mailboxTone(mailbox())).toBe("success");
    expect(mailboxTone(mailbox({ enabled: false }))).toBe("neutral");
  });
});

describe("mailboxDeleteConsequence", () => {
  it("names the high-water data-loss boundary, which is the part people discover late", () => {
    const s = mailboxDeleteConsequence(mailbox());
    expect(s).toContain("poll cursor");
    expect(s).toMatch(/high-water mark|may be skipped/u);
  });

  it("points at disable as the non-destructive alternative", () => {
    expect(mailboxDeleteConsequence(mailbox())).toContain("Disable it instead");
  });
});

describe("toReplyMailbox", () => {
  const wire = {
    id: "018f47f2-9f25-7f73-8ec6-3fd483eb51dd",
    label: "Support",
    host: "imap.example.com",
    port: 993,
    use_tls: true,
    folder: "INBOX",
    username_secret_ref: "env:POSTWAVE_REPLY_IMAP_TENANT_018F47F29F257F738EC63FD483EB51DD_USER",
    password_secret_ref: "env:POSTWAVE_REPLY_IMAP_TENANT_018F47F29F257F738EC63FD483EB51DD_PASSWORD",
    enabled: true,
  };

  it("maps the wire shape", () => {
    const m = toReplyMailbox(wire);
    expect(m.host).toBe("imap.example.com");
    expect(m.useTLS).toBe(true);
    expect(m.usernameSecretRef).toContain("_USER");
  });

  it("rejects malformed rows rather than dropping them into an empty state", () => {
    expect(() => toReplyMailbox({ ...wire, id: "" })).toThrow(/invalid/ui);
    expect(() => toReplyMailbox(null)).toThrow(/invalid/ui);
    expect(() => toReplyMailbox("nope")).toThrow(/invalid/ui);
    expect(() => toReplyMailbox({ ...wire, unexpected: true })).toThrow(/invalid/ui);
  });

  it("does not invent required server fields", () => {
    const { folder: _drop, ...without } = wire;
    expect(() => toReplyMailbox(without)).toThrow(/invalid/ui);
  });

  it("accepts a paired disabled quarantine and rejects an enabled one", () => {
    const quarantined = {
      ...wire,
      enabled: false,
      use_tls: false,
      security_quarantined_at: "2026-08-30T00:00:00Z",
      security_quarantine_reason:
        "legacy_insecure_transport_or_secret_reference",
    };
    expect(toReplyMailbox(quarantined).securityQuarantinedAt).toContain("2026");
    expect(() => toReplyMailbox({ ...quarantined, enabled: true })).toThrow(/invalid/ui);
  });
});

describe("decodeReplyMailboxList", () => {
  const wire = {
    id: "018f47f2-9f25-7f73-8ec6-3fd483eb51dd",
    label: "Support",
    host: "imap.example.com",
    port: 993,
    use_tls: true,
    folder: "INBOX",
    username_secret_ref: "env:POSTWAVE_REPLY_IMAP_TENANT_018F47F29F257F738EC63FD483EB51DD_USER",
    password_secret_ref: "env:POSTWAVE_REPLY_IMAP_TENANT_018F47F29F257F738EC63FD483EB51DD_PASSWORD",
    enabled: false,
  };

  it("requires the authoritative items envelope", () => {
    expect(decodeReplyMailboxList({ items: [wire] })).toHaveLength(1);
    expect(() => decodeReplyMailboxList([wire])).toThrow(/invalid/ui);
    expect(() => decodeReplyMailboxList({})).toThrow(/invalid/ui);
  });

  it("rejects duplicate ids and raw credential-looking values", () => {
    expect(() => decodeReplyMailboxList({ items: [wire, wire] })).toThrow(/duplicate/u);
    expect(() =>
      decodeReplyMailboxList({
        items: [{ ...wire, password_secret_ref: "literal-password" }],
      }),
    ).toThrow(/invalid/ui);
  });
});
