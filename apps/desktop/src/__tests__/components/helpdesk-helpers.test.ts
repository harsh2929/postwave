/**
 * helpdesk-helpers — pure logic behind HelpdeskInbox (KLV-10).
 *
 * High-stakes invariants:
 *   1. htmlToText strips ALL tags (no markup ever reaches the DOM as
 *      text we'd later inject as HTML) and decodes the common entities.
 *   2. messageText prefers body_text, falls back to stripped body_html,
 *      and never fabricates a body (empty → empty).
 *   3. requesterLabel cascades name → email → phone → "Unknown" and is
 *      never blank.
 *   4. statusChips always leads with the "All" sentinel, dedupes, and
 *      drops blanks; defaultStatus picks the first real catalog status.
 */

import { describe, expect, it } from "vitest";

import {
  ALL_STATUS,
  decodeConversationList,
  decodeMessageList,
  decodeTicketList,
  describeTicketDueDate,
  defaultStatus,
  htmlToText,
  internalNoteValidationError,
  isCanonicalHelpdeskId,
  isSafeOpaqueHelpdeskCursor,
  isSafeHelpdeskStatusRouteValue,
  messageText,
  requesterLabel,
  statusBadgeClass,
  statusChips,
  titleizeStatus,
} from "../../components/helpdesk/helpdesk-helpers";

const CONVERSATION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const MESSAGE_ID = "22222222-2222-4222-8222-222222222222";
const TENANT_ID = "33333333-3333-4333-8333-333333333333";
const VERSION = "2026-08-24T00:00:00Z";
const page = {
  has_more: false,
  next_cursor: null,
  as_of: VERSION,
  consistency: "mutable_window",
  may_reorder: true,
};
const messagePage = { ...page, consistency: "created_at_window" };

function messageRow(overrides: Record<string, unknown> = {}) {
  return {
    id: MESSAGE_ID,
    tenantId: TENANT_ID,
    tenant_id: TENANT_ID,
    conversation_id: CONVERSATION_ID,
    source_type: "manual",
    direction: "inbound",
    sender_type: "customer",
    body_text: "First line\n\tIndented\r\nLast line",
    record_kind: "inbound_record",
    delivery_status: "received",
    attachment_count: 0,
    projection_truncated: false,
    sent_at: "2026-08-24T09:30:00Z",
    created_at: "2026-08-24T09:30:00Z",
    ...overrides,
  };
}

describe("htmlToText", () => {
  it("returns empty for nullish / empty input", () => {
    expect(htmlToText(null)).toBe("");
    expect(htmlToText(undefined)).toBe("");
    expect(htmlToText("")).toBe("");
  });

  it("strips all tags, leaving plain text", () => {
    expect(htmlToText("<b>Hello</b> <i>world</i>")).toBe("Hello world");
    // No angle brackets survive — nothing the DOM could parse as markup.
    expect(htmlToText("<p>One</p><p>Two</p>")).not.toMatch(/[<>]/);
  });

  it("turns block tags and <br> into newlines, <li> into bullets", () => {
    expect(htmlToText("Line1<br>Line2")).toBe("Line1\nLine2");
    expect(htmlToText("<ul><li>a</li><li>b</li></ul>")).toContain("• a");
    expect(htmlToText("<ul><li>a</li><li>b</li></ul>")).toContain("• b");
  });

  it("decodes named and numeric entities", () => {
    expect(htmlToText("Tom &amp; Jerry")).toBe("Tom & Jerry");
    expect(htmlToText("a &lt;b&gt; c")).toBe("a <b> c");
    expect(htmlToText("&#39;quoted&#39;")).toBe("'quoted'");
    expect(htmlToText("&#x41;&#x42;")).toBe("AB");
    expect(htmlToText("a&nbsp;b")).toBe("a b");
  });

  it("collapses excess blank lines and trims", () => {
    expect(htmlToText("<p>a</p><p></p><p></p><p>b</p>")).toBe("a\n\nb");
  });

  it("neutralizes a script tag to inert text (no executable markup)", () => {
    const out = htmlToText("<script>alert('x')</script>safe");
    expect(out).not.toMatch(/<script/i);
    expect(out).toContain("safe");
  });
});

describe("messageText", () => {
  it("prefers body_text when present", () => {
    expect(
      messageText({
        direction: "inbound",
        sender_type: "customer",
        body_text: "plain",
        body_html: "<b>html</b>",
      }),
    ).toBe("plain");
  });

  it("falls back to stripped body_html when body_text is empty", () => {
    expect(
      messageText({
        direction: "inbound",
        sender_type: "customer",
        body_text: "   ",
        body_html: "<p>Hi</p>",
      }),
    ).toBe("Hi");
  });

  it("never fabricates — empty stays empty", () => {
    expect(messageText(null)).toBe("");
    expect(messageText(undefined)).toBe("");
    expect(messageText({ direction: "inbound", sender_type: "customer" })).toBe(
      "",
    );
  });
});

describe("requesterLabel", () => {
  it("cascades name → email → phone → Unknown", () => {
    expect(requesterLabel({ requester_name: "Ada" })).toBe("Ada");
    expect(
      requesterLabel({ requester_name: " ", requester_email: "a@b.co" }),
    ).toBe("a@b.co");
    expect(
      requesterLabel({ requester_email: "", requester_phone: "+15550100" }),
    ).toBe("+15550100");
    expect(requesterLabel({})).toBe("Unknown");
    expect(requesterLabel(null)).toBe("Unknown");
  });
});

describe("statusChips", () => {
  it("always leads with the All sentinel", () => {
    const chips = statusChips(["open", "closed"]);
    expect(chips[0]).toEqual({ value: ALL_STATUS, label: "All" });
  });

  it("dedupes, drops blanks, preserves order, and titleizes labels", () => {
    const chips = statusChips(["open", "open", "", "in_progress", "  "]);
    expect(chips.map((c) => c.value)).toEqual([
      ALL_STATUS,
      "open",
      "in_progress",
    ]);
    expect(chips.find((c) => c.value === "in_progress")?.label).toBe(
      "In progress",
    );
  });

  it("handles a missing / non-array catalog gracefully", () => {
    expect(statusChips(null)).toEqual([{ value: ALL_STATUS, label: "All" }]);
    expect(statusChips(undefined)).toEqual([
      { value: ALL_STATUS, label: "All" },
    ]);
  });
});

describe("defaultStatus", () => {
  it("returns the first non-blank catalog status", () => {
    expect(defaultStatus(["", "open", "closed"])).toBe("open");
  });

  it("falls back to ALL_STATUS when there are no statuses", () => {
    expect(defaultStatus([])).toBe(ALL_STATUS);
    expect(defaultStatus(null)).toBe(ALL_STATUS);
  });
});

describe("titleizeStatus", () => {
  it("humanizes snake/kebab case and dashes empties", () => {
    expect(titleizeStatus("in_progress")).toBe("In progress");
    expect(titleizeStatus("web-chat")).toBe("Web chat");
    expect(titleizeStatus("")).toBe("—");
    expect(titleizeStatus("  ")).toBe("—");
  });
});

describe("statusBadgeClass", () => {
  it("maps resolved-ish to success and open-ish to warning", () => {
    expect(statusBadgeClass("closed")).toBe("badge success");
    expect(statusBadgeClass("Resolved")).toBe("badge success");
    expect(statusBadgeClass("open")).toBe("badge warning");
    expect(statusBadgeClass("pending")).toBe("badge warning");
    expect(statusBadgeClass("snoozed")).toBe("badge");
    expect(statusBadgeClass(null)).toBe("badge");
  });
});

describe("strict helpdesk identity and wire boundaries", () => {
  const conversation = {
    id: CONVERSATION_ID,
    tenantId: TENANT_ID,
    tenant_id: TENANT_ID,
    version: VERSION,
    channel_type: "web_chat",
    source_type: "web_chat",
    status: "open",
    priority: "normal",
    assignment_state: "unassigned",
    created_at: VERSION,
    updated_at: VERSION,
  };

  it("accepts only canonical UUID route identities", () => {
    expect(isCanonicalHelpdeskId(CONVERSATION_ID)).toBe(true);
    expect(isCanonicalHelpdeskId(CONVERSATION_ID.toUpperCase())).toBe(false);
    expect(isCanonicalHelpdeskId("%00" + CONVERSATION_ID)).toBe(false);
    expect(isCanonicalHelpdeskId(`${CONVERSATION_ID}\u0000`)).toBe(false);
    expect(isCanonicalHelpdeskId("a".repeat(300))).toBe(false);
  });

  it("allows only bounded enum-like status intents in route history", () => {
    expect(isSafeHelpdeskStatusRouteValue("in_progress")).toBe(true);
    expect(isSafeHelpdeskStatusRouteValue("reader@example.test")).toBe(false);
    expect(isSafeHelpdeskStatusRouteValue("+15551234567")).toBe(false);
    expect(isSafeHelpdeskStatusRouteValue("a".repeat(65))).toBe(false);
    expect(isSafeHelpdeskStatusRouteValue("open\u0000closed")).toBe(false);
  });

  it("separates opaque cursor controls from multiline display text", () => {
    expect(isSafeOpaqueHelpdeskCursor("opaque&cursor=next@example.test")).toBe(
      true,
    );
    for (const poison of [
      "cursor\tvalue",
      "cursor\nvalue",
      "cursor\rvalue",
      "cursor\u0085value",
      "cursor\u202evalue",
    ]) {
      expect(isSafeOpaqueHelpdeskCursor(poison)).toBe(false);
    }
  });

  it("requires a top-level tenant binding and both matching row bindings", () => {
    expect(
      decodeConversationList(
        { tenantId: TENANT_ID, items: [conversation], page },
        TENANT_ID,
      ),
    ).toMatchObject({ rejected: 0, envelopeError: null });
    expect(
      decodeConversationList(
        { tenant_id: TENANT_ID, items: [conversation], page },
        TENANT_ID,
      ).envelopeError,
    ).not.toBeNull();
    expect(
      decodeConversationList(
        {
          tenantId: TENANT_ID,
          items: [{ ...conversation, tenantId: "other" }],
          page,
        },
        TENANT_ID,
      ).rejected,
    ).toBe(1);
  });

  it("rejects noncanonical conversation tokens, byte overflow, and timestamp poison", () => {
    for (const poisoned of [
      { channel_type: "web chat" },
      { source_type: "provider_magic" },
      { status: "Open" },
      { priority: "critical" },
      { subject: "😀".repeat(126) },
      { requester_email: "not-an-email" },
      { updated_at: "1999-12-31T23:59:59Z" },
      { created_at: "2026-08-24T00:00:01Z" },
      { tenantId: "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA" },
    ]) {
      expect(
        decodeConversationList(
          {
            tenantId: TENANT_ID,
            items: [{ ...conversation, ...poisoned }],
            page,
          },
          TENANT_ID,
        ),
        `poisoned conversation projection: ${JSON.stringify(poisoned)}`,
      ).toMatchObject({ items: [], rejected: 1 });
    }
  });

  it("requires exact page metadata and collection-specific consistency", () => {
    expect(
      decodeConversationList(
        {
          tenantId: TENANT_ID,
          items: [conversation],
          page: { ...page, consistency: "created_at_window" },
        },
        TENANT_ID,
      ).envelopeError,
    ).not.toBeNull();
    for (const next_cursor of [
      "cursor\tvalue",
      "cursor\nvalue",
      "cursor\rvalue",
      "cursor\u0085value",
      "cursor\u202evalue",
    ]) {
      const poisonedPage = { ...page, has_more: true, next_cursor };
      expect(
        decodeConversationList(
          { tenantId: TENANT_ID, items: [conversation], page: poisonedPage },
          TENANT_ID,
        ).envelopeError,
      ).not.toBeNull();
      expect(
        decodeMessageList(
          {
            tenantId: TENANT_ID,
            items: [messageRow()],
            page: { ...poisonedPage, consistency: "created_at_window" },
          },
          TENANT_ID,
          CONVERSATION_ID,
        ).envelopeError,
      ).not.toBeNull();
    }
    expect(
      decodeConversationList(
        {
          tenantId: TENANT_ID,
          items: [conversation],
          page: { ...page, unexpected: true },
        },
        TENANT_ID,
      ).envelopeError,
    ).not.toBeNull();
  });

  it("accepts only projected ticket assignment truth with no raw assignee", () => {
    const ticket = {
      id: "55555555-5555-4555-8555-555555555555",
      tenantId: TENANT_ID,
      tenant_id: TENANT_ID,
      version: VERSION,
      conversation_id: CONVERSATION_ID,
      ticket_number: 41,
      title: "Synthetic ticket",
      status: "open",
      priority: "normal",
      assignment_state: "legacy_unverified",
      source_channel: "generic",
      due_at: null,
      resolved_at: null,
      created_at: VERSION,
      updated_at: VERSION,
    };
    expect(
      decodeTicketList(
        { tenantId: TENANT_ID, items: [ticket], page },
        TENANT_ID,
      ),
    ).toMatchObject({ rejected: 0, envelopeError: null });
    expect(
      decodeTicketList(
        {
          tenantId: TENANT_ID,
          items: [{ ...ticket, assignee: "legacy@example.invalid" }],
          page,
        },
        TENANT_ID,
      ),
    ).toMatchObject({ items: [], rejected: 1 });
    expect(
      decodeTicketList(
        {
          tenantId: TENANT_ID,
          items: [{ ...ticket, ticket_number: 0 }],
          page,
        },
        TENANT_ID,
      ),
    ).toMatchObject({ items: [], rejected: 1 });
    expect(
      decodeTicketList(
        {
          tenantId: TENANT_ID,
          items: [ticket],
          page: {
            ...page,
            has_more: true,
            next_cursor: "ticket\nnext",
          },
        },
        TENANT_ID,
      ).envelopeError,
    ).not.toBeNull();
  });

  it("rejects an outbound row that claims customer delivery", () => {
    const decoded = decodeMessageList(
      {
        tenantId: TENANT_ID,
        page: messagePage,
        items: [
          messageRow({
            direction: "outbound",
            sender_type: "agent",
            body_text: "Stored outbound evidence",
            record_kind: "outbound_record",
            delivery_status: "sent",
          }),
        ],
      },
      TENANT_ID,
      CONVERSATION_ID,
    );
    expect(decoded.items).toEqual([]);
    expect(decoded.rejected).toBe(1);
    expect(decoded.envelopeError).toContain("page was withheld");
  });

  it("accepts multiline message text and enforces the 16 KiB UTF-8 boundary", () => {
    const decode = (body_text: string) =>
      decodeMessageList(
        {
          tenantId: TENANT_ID,
          page: messagePage,
          items: [messageRow({ body_text })],
        },
        TENANT_ID,
        CONVERSATION_ID,
      );

    expect(decode("First\n\tSecond\r\nThird")).toMatchObject({
      rejected: 0,
      envelopeError: null,
    });
    expect(decode("😀".repeat(4096))).toMatchObject({
      rejected: 0,
      envelopeError: null,
    });
    expect(decode("😀".repeat(4097))).toMatchObject({
      items: [],
      rejected: 1,
    });
  });

  it("requires exactly one nonblank body or omission reason", () => {
    for (const projection of [
      { body_text: "", body_omitted_reason: "" },
      { body_text: "   ", body_omitted_reason: undefined },
      { body_text: "Visible", body_omitted_reason: "html_only" },
      { body_text: "", body_omitted_reason: "body_exceeds_inbox_limit" },
    ]) {
      expect(
        decodeMessageList(
          {
            tenantId: TENANT_ID,
            page: messagePage,
            items: [messageRow(projection)],
          },
          TENANT_ID,
          CONVERSATION_ID,
        ),
      ).toMatchObject({ items: [], rejected: 1 });
    }

    expect(
      decodeMessageList(
        {
          tenantId: TENANT_ID,
          page: messagePage,
          items: [
            messageRow({
              body_text: "",
              body_omitted_reason: "source_body_unsafe",
              projection_truncated: true,
            }),
          ],
        },
        TENANT_ID,
        CONVERSATION_ID,
      ),
    ).toMatchObject({ rejected: 0, envelopeError: null });
    expect(
      decodeMessageList(
        {
          tenantId: TENANT_ID,
          page: messagePage,
          items: [
            messageRow({
              attachment_count: 1,
              projection_truncated: false,
            }),
          ],
        },
        TENANT_ID,
        CONVERSATION_ID,
      ),
    ).toMatchObject({ items: [], rejected: 1 });
  });

  it("withholds controls, bidi disguises, timestamp poison, duplicates, and wrong order", () => {
    for (const body_text of [
      "hidden\u0000value",
      "invoice\u202epdf",
      "line\u2028separator",
    ]) {
      expect(
        decodeMessageList(
          {
            tenantId: TENANT_ID,
            page: messagePage,
            items: [messageRow({ body_text })],
          },
          TENANT_ID,
          CONVERSATION_ID,
        ).envelopeError,
      ).toContain("withheld");
    }

    expect(
      decodeMessageList(
        {
          tenantId: TENANT_ID,
          page: messagePage,
          items: [messageRow({ sent_at: "2026-08-24T09:30:00+00:00" })],
        },
        TENANT_ID,
        CONVERSATION_ID,
      ).envelopeError,
    ).toContain("withheld");

    expect(
      decodeMessageList(
        {
          tenantId: TENANT_ID,
          page: messagePage,
          items: [
            messageRow({
              sent_at: "2026-08-24T09:31:00Z",
              created_at: "2026-08-24T09:30:00Z",
            }),
          ],
        },
        TENANT_ID,
        CONVERSATION_ID,
      ).envelopeError,
    ).toContain("withheld");

    const newer = messageRow({
      sent_at: "2026-08-24T09:31:00Z",
      created_at: "2026-08-24T09:31:00Z",
    });
    const older = messageRow({
      id: "44444444-4444-4444-8444-444444444444",
      sent_at: "2026-08-24T09:29:00Z",
    });
    expect(
      decodeMessageList(
        { tenantId: TENANT_ID, page: messagePage, items: [newer, newer] },
        TENANT_ID,
        CONVERSATION_ID,
      ).envelopeError,
    ).toContain("duplicate");
    expect(
      decodeMessageList(
        { tenantId: TENANT_ID, page: messagePage, items: [older, newer] },
        TENANT_ID,
        CONVERSATION_ID,
        "desc",
      ).envelopeError,
    ).toContain("deterministic order");
  });
});

describe("internal-note UTF-8 boundary", () => {
  it("accepts exactly 16 KiB and rejects one additional ASCII byte", () => {
    expect(internalNoteValidationError("a".repeat(16 * 1024))).toBeNull();
    expect(internalNoteValidationError("a".repeat(16 * 1024 + 1))).toContain(
      "16 KiB",
    );
  });

  it("counts emoji by encoded bytes without truncating", () => {
    expect(internalNoteValidationError("😀".repeat(4096))).toBeNull();
    expect(internalNoteValidationError("😀".repeat(4097))).toContain("16 KiB");
  });

  it("allows ordinary line breaks but rejects unsafe display controls", () => {
    expect(internalNoteValidationError("First\n\tSecond\r\nThird")).toBeNull();
    expect(internalNoteValidationError("spoof\u202estatus")).toContain("bidi");
    expect(internalNoteValidationError("split\u2028line")).toContain("control");
  });
});

describe("ticket recorded due-date evidence", () => {
  it("does not turn a missing ticket in a bounded window into no due date", () => {
    expect(describeTicketDueDate(null)).toMatchObject({
      label: "Due date unverified",
    });
  });

  it("describes due_at as a clock comparison without a policy claim", () => {
    const descriptor = describeTicketDueDate(
      {
        id: "55555555-5555-4555-8555-555555555555",
        tenantId: TENANT_ID,
        tenant_id: TENANT_ID,
        version: VERSION,
        title: "Recorded timing",
        status: "open",
        priority: "normal",
        assignment_state: "unassigned",
        source_channel: "generic",
        due_at: "2026-08-24T09:00:00Z",
        resolved_at: null,
        created_at: VERSION,
        updated_at: VERSION,
      },
      Date.parse("2026-08-24T10:00:00Z"),
    );
    expect(descriptor.label).toBe("1h past recorded due");
    expect(descriptor.detail).toContain("clock comparison");
    expect(descriptor.detail).not.toMatch(/\b(?:compliant|on track)\b/iu);
  });
});
