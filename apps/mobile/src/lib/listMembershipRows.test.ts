/**
 * The pure half of list-side membership editing.
 *
 * What these pin, in order of what a wrong answer would cost:
 *  - a candidate already on the list is never presented as addable;
 *  - a candidate the POST could never resolve is never selectable (one bad id
 *    400s the WHOLE batch);
 *  - the add toast reports the server's {added, skipped} verbatim, and says
 *    NOTHING numeric when the server sent no counts;
 *  - the remove confirm names the person AND the list, and describes a
 *    detach — the handler does not unsubscribe anyone.
 */
import { describe, expect, it } from "vitest";

import {
  addMembersConfirmCopy,
  addMembersToastCopy,
  addableSelection,
  buildCandidateRows,
  candidateTrailingLabel,
  isSubscriberUuid,
  LIST_MEMBER_ADD_MAX,
  memberIdSet,
  parseAddMembersResult,
  parseCandidatePage,
  removeMemberConfirmCopy,
  type ListCandidate,
} from "./listMembershipRows";

const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_B = "22222222-2222-4222-8222-222222222222";

function candidate(over: Partial<ListCandidate> = {}): ListCandidate {
  return { id: UUID_A, email: "a@example.com", status: "enabled", name: "", ...over };
}

describe("isSubscriberUuid", () => {
  it("accepts a canonical uuid in either case, trimmed", () => {
    expect(isSubscriberUuid(UUID_A)).toBe(true);
    expect(isSubscriberUuid(` ${UUID_A.toUpperCase()} `)).toBe(true);
  });

  it("rejects the bigint shape the subscribers table has no map for", () => {
    // membership_write.go accepts an integer sub_id and can never resolve it.
    expect(isSubscriberUuid("42")).toBe(false);
    expect(isSubscriberUuid("")).toBe(false);
    expect(isSubscriberUuid(null)).toBe(false);
    expect(isSubscriberUuid(42)).toBe(false);
  });
});

describe("parseCandidatePage", () => {
  it("reads the subscribers.Page shape and prefers a real display name", () => {
    const page = parseCandidatePage({
      items: [
        { id: UUID_A, email: "dana@example.com", status: "enabled", first_name: "Dana", last_name: "Reed" },
        { id: UUID_B, email: "sam@example.com", status: "blocklisted", full_name: "Sam K" },
      ],
      total: 9,
    });
    expect(page.total).toBe(9);
    expect(page.items).toEqual([
      { id: UUID_A, email: "dana@example.com", status: "enabled", name: "Dana Reed" },
      { id: UUID_B, email: "sam@example.com", status: "blocklisted", name: "Sam K" },
    ]);
  });

  it("keeps a row whose id is not a uuid, but marks it unusable with id null", () => {
    // Hiding it would answer "nobody by that name" when the truth is
    // "found, but not addable".
    const page = parseCandidatePage({ items: [{ id: 42, email: "n@example.com" }] });
    expect(page.items).toEqual([{ id: null, email: "n@example.com", status: "", name: "" }]);
  });

  it("drops rows with no email and falls back to the row count for total", () => {
    const page = parseCandidatePage({ items: [{ id: UUID_A }, { id: UUID_B, email: "b@example.com" }] });
    expect(page.items.map((r) => r.email)).toEqual(["b@example.com"]);
    expect(page.total).toBe(1);
  });

  it("answers an empty page for a non-page body rather than throwing", () => {
    expect(parseCandidatePage(null)).toEqual({ items: [], total: 0 });
    expect(parseCandidatePage({ items: "nope" })).toEqual({ items: [], total: 0 });
  });
});

describe("memberIdSet", () => {
  it("collects only uuid ids from the members pages", () => {
    const ids = memberIdSet([
      { items: [{ id: UUID_A, email: "a@example.com" }, { id: 7, email: "b@example.com" }] },
      { items: [{ id: UUID_B }] },
      null,
    ]);
    expect([...ids].sort()).toEqual([UUID_A, UUID_B].sort());
  });
});

describe("buildCandidateRows", () => {
  it("marks a known member as `member`, never as addable", () => {
    const rows = buildCandidateRows([candidate({ id: UUID_A })], new Set([UUID_A]));
    expect(rows[0]?.state).toBe("member");
  });

  it("marks an id-less row unavailable and an unknown row addable", () => {
    const rows = buildCandidateRows(
      [candidate({ id: null, email: "x@example.com" }), candidate({ id: UUID_B, email: "y@example.com" })],
      new Set(),
    );
    expect(rows.map((r) => [r.email, r.state])).toEqual([
      ["y@example.com", "addable"],
      ["x@example.com", "unavailable"],
    ]);
  });

  it("sorts actionable rows first, preserving order inside each group", () => {
    const rows = buildCandidateRows(
      [
        candidate({ id: UUID_A, email: "member@example.com" }),
        candidate({ id: UUID_B, email: "first@example.com" }),
        candidate({ id: null, email: "noid@example.com" }),
      ],
      new Set([UUID_A]),
    );
    expect(rows.map((r) => r.email)).toEqual([
      "first@example.com",
      "member@example.com",
      "noid@example.com",
    ]);
  });
});

describe("candidateTrailingLabel", () => {
  it("says why a row cannot be picked, and reflects selection when it can", () => {
    const member = buildCandidateRows([candidate()], new Set([UUID_A]))[0]!;
    const unusable = buildCandidateRows([candidate({ id: null })], new Set())[0]!;
    const open = buildCandidateRows([candidate({ id: UUID_B })], new Set())[0]!;
    expect(candidateTrailingLabel(member, false)).toBe("On list");
    expect(candidateTrailingLabel(unusable, false)).toBe("No id");
    expect(candidateTrailingLabel(open, false)).toBe("Add");
    expect(candidateTrailingLabel(open, true)).toBe("Selected");
  });
});

describe("addableSelection", () => {
  it("sends only ids that are selected AND still addable", () => {
    const rows = buildCandidateRows(
      [candidate({ id: UUID_A }), candidate({ id: UUID_B, email: "b@example.com" })],
      new Set([UUID_A]), // A is already a member
    );
    expect(addableSelection(rows, new Set([UUID_A, UUID_B]))).toEqual({
      ids: [UUID_B],
      // The addresses travel with the ids so the confirm can name the people.
      emails: ["b@example.com"],
      capped: false,
    });
  });

  it("never sends an id-less row, even if something selected it", () => {
    const rows = buildCandidateRows([candidate({ id: null })], new Set());
    expect(addableSelection(rows, new Set(["anything"])).ids).toEqual([]);
  });

  it("caps at the server batch limit and SAYS it trimmed the ask", () => {
    const many = Array.from({ length: LIST_MEMBER_ADD_MAX + 5 }, (_, i) =>
      candidate({
        id: `${String(i).padStart(8, "0")}-1111-4111-8111-111111111111`,
        email: `p${i}@example.com`,
      }),
    );
    const rows = buildCandidateRows(many, new Set());
    const selected = new Set(rows.flatMap((r) => (r.id ? [r.id] : [])));
    const result = addableSelection(rows, selected);
    expect(result.ids).toHaveLength(LIST_MEMBER_ADD_MAX);
    expect(result.emails).toHaveLength(LIST_MEMBER_ADD_MAX);
    expect(result.capped).toBe(true);
  });
});

describe("addMembersConfirmCopy", () => {
  it("names the list and every person while the selection is readable", () => {
    const copy = addMembersConfirmCopy("Weekly", ["a@example.com", "b@example.com"]);
    expect(copy.message).toBe(
      "a@example.com, b@example.com will be added to “Weekly”.",
    );
    expect(copy.confirmLabel).toBe("Add 2");
  });

  it("summarises a long selection instead of an unreadable wall", () => {
    const copy = addMembersConfirmCopy("Weekly", [
      "a@example.com",
      "b@example.com",
      "c@example.com",
      "d@example.com",
    ]);
    expect(copy.message).toContain("4 subscribers");
    expect(copy.message).toContain("and 2 more");
    expect(copy.message).toContain("Weekly");
  });

  it("says what adding someone DOES — it changes who receives mail", () => {
    const copy = addMembersConfirmCopy("Weekly", ["a@example.com"]);
    expect(copy.title).toBe("Add to this list?");
    expect(copy.consequence).toContain("start receiving what this list is sent");
    // The server skips existing members; the confirm says so rather than
    // implying every selected row is new.
    expect(copy.consequence).toContain("already on it is skipped");
  });
});

describe("parseAddMembersResult", () => {
  it("reads the server's two counts", () => {
    expect(parseAddMembersResult({ added: 3, skipped: 1 })).toEqual({ added: 3, skipped: 1 });
  });

  it("returns null rather than inventing a count", () => {
    expect(parseAddMembersResult({ added: 3 })).toBeNull();
    expect(parseAddMembersResult({ added: "3", skipped: 0 })).toBeNull();
    expect(parseAddMembersResult(null)).toBeNull();
  });
});

describe("addMembersToastCopy", () => {
  it("reports both counts when some were skipped — never just the added ones", () => {
    const copy = addMembersToastCopy("Weekly", { added: 2, skipped: 3 });
    expect(copy.kind).toBe("success");
    expect(copy.message).toContain("Added 2 of 5");
    expect(copy.message).toContain("3 skipped");
  });

  it("claims a clean add only when nothing was skipped", () => {
    expect(addMembersToastCopy("Weekly", { added: 1, skipped: 0 })).toEqual({
      kind: "success",
      message: "Added 1 subscriber to “Weekly”.",
    });
  });

  it("does not call an all-skipped result a success", () => {
    const copy = addMembersToastCopy("Weekly", { added: 0, skipped: 4 });
    expect(copy.kind).toBe("info");
    expect(copy.message).toContain("all 4 were skipped");
  });

  it("states no number at all when the server sent no counts", () => {
    const copy = addMembersToastCopy("Weekly", null);
    expect(copy).toEqual({ kind: "info", message: "Updated “Weekly”." });
    expect(copy.message).not.toMatch(/\d/u);
  });
});

describe("removeMemberConfirmCopy", () => {
  const copy = removeMemberConfirmCopy("Weekly", "dana@example.com");

  it("names the person and the list, so the confirm is about THIS row", () => {
    expect(copy.message).toContain("dana@example.com");
    expect(copy.message).toContain("Weekly");
  });

  it("says it detaches — the handler never unsubscribes anyone", () => {
    // membership_write.go soft-deletes the list_subscribers row and touches
    // neither the subscriber record nor their status.
    expect(copy.consequence).toContain("stay a subscriber");
    expect(copy.consequence).toContain("keep their other lists");
    expect(copy.consequence.toLowerCase()).not.toContain("unsubscrib");
  });
});
