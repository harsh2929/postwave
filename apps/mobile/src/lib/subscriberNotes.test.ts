import { describe, expect, it } from "vitest";

import {
  noteSpokenLabel,
  NOTE_BODY_MAX,
  orderSubscriberNotes,
  parseSubscriberNotes,
  validateNoteDraft,
  type SubscriberNote,
} from "./subscriberNotes";

function note(over: Partial<SubscriberNote> = {}): SubscriberNote {
  return {
    id: "n1",
    body: "Met at SaaStr",
    authorEmail: "ada@postwave.test",
    pinned: false,
    createdAt: "2026-07-01T10:00:00Z",
    attachmentCount: 0,
    ...over,
  };
}

describe("parseSubscriberNotes", () => {
  it("reads the handler's {notes} envelope and prefers markdown_body", () => {
    expect(
      parseSubscriberNotes({
        count: 1,
        notes: [
          {
            id: "n1",
            body: "plain projection",
            markdown_body: "**rich** source",
            author_email: "ada@postwave.test",
            pinned: true,
            created_at: "2026-07-01T10:00:00Z",
            attachments: [{ file_key: "a" }, { file_key: "b" }],
          },
        ],
      }),
    ).toEqual([
      {
        id: "n1",
        body: "**rich** source",
        authorEmail: "ada@postwave.test",
        pinned: true,
        createdAt: "2026-07-01T10:00:00Z",
        attachmentCount: 2,
      },
    ]);
  });

  it("falls back to the plain body when markdown_body is absent", () => {
    expect(
      parseSubscriberNotes({ notes: [{ id: "n1", body: "legacy row" }] })[0]
        ?.body,
    ).toBe("legacy row");
  });

  it("accepts a bare array", () => {
    expect(parseSubscriberNotes([{ id: "n1", body: "x" }])).toHaveLength(1);
  });

  it("drops rows that would render as a blank card", () => {
    expect(
      parseSubscriberNotes({
        notes: [{ id: "", body: "no id" }, { id: "n2", body: "   " }, null, 3],
      }),
    ).toEqual([]);
  });

  it("degrades to empty on junk instead of throwing", () => {
    expect(parseSubscriberNotes(null)).toEqual([]);
    expect(parseSubscriberNotes("nope")).toEqual([]);
    expect(parseSubscriberNotes({ notes: "nope" })).toEqual([]);
  });
});

describe("orderSubscriberNotes", () => {
  it("puts pinned first, then newest first", () => {
    const rows = [
      note({ id: "old", createdAt: "2026-01-01T00:00:00Z" }),
      note({ id: "new", createdAt: "2026-07-01T00:00:00Z" }),
      note({ id: "pin", createdAt: "2025-01-01T00:00:00Z", pinned: true }),
    ];
    expect(orderSubscriberNotes(rows).map((n) => n.id)).toEqual([
      "pin",
      "new",
      "old",
    ]);
  });

  it("does not mutate its input", () => {
    const rows = [note({ id: "a" }), note({ id: "b", pinned: true })];
    orderSubscriberNotes(rows);
    expect(rows.map((n) => n.id)).toEqual(["a", "b"]);
  });
});

describe("validateNoteDraft", () => {
  it("refuses a blank draft silently (nothing typed yet is not an error)", () => {
    expect(validateNoteDraft("   ")).toEqual({
      code: "empty",
      hint: null,
      canSave: false,
    });
  });

  it("refuses an oversized draft with the server's own limit", () => {
    const v = validateNoteDraft("x".repeat(NOTE_BODY_MAX + 1));
    expect(v.code).toBe("too_long");
    expect(v.canSave).toBe(false);
    expect(v.hint).toContain("20,000");
  });

  it("accepts a normal note", () => {
    expect(validateNoteDraft(" met at SaaStr ")).toEqual({
      code: "ok",
      hint: null,
      canSave: true,
    });
  });
});

describe("noteSpokenLabel", () => {
  it("announces pinned state, author, time and body", () => {
    expect(noteSpokenLabel(note({ pinned: true }), "3 days ago")).toBe(
      "Pinned note, by ada@postwave.test, 3 days ago. Met at SaaStr",
    );
  });

  it("omits the parts it does not have", () => {
    expect(noteSpokenLabel(note({ authorEmail: "" }), "")).toBe(
      "Note. Met at SaaStr",
    );
  });

  it("counts attachments", () => {
    expect(
      noteSpokenLabel(note({ authorEmail: "", attachmentCount: 1 }), ""),
    ).toBe("Note, 1 attachment. Met at SaaStr");
    expect(
      noteSpokenLabel(note({ authorEmail: "", attachmentCount: 4 }), ""),
    ).toBe("Note, 4 attachments. Met at SaaStr");
  });
});
