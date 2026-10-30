import { describe, expect, it } from "vitest";

import {
  actionsForComment,
  authorLabel,
  authorOrigin,
  commentPreview,
  commentStatusPresentation,
  issueLabel,
  moderationCopy,
  moderationFailureMessage,
  moderationSuccessMessage,
  orderForFilter,
  parseArchiveCommentPage,
  statusForAction,
  truncationNotice,
  voteLabel,
  voteScore,
  type MobileArchiveComment,
} from "./archiveCommentQueue";

function comment(over: Partial<MobileArchiveComment> = {}): MobileArchiveComment {
  return {
    id: "c1",
    campaignId: "11111111-2222-4333-8444-555555555555",
    parentId: "",
    subscriberId: "",
    displayName: "Dana",
    body: "Great issue.",
    pinned: false,
    status: "visible",
    upvotes: 3,
    downvotes: 1,
    createdAt: "2026-07-20T10:00:00Z",
    ...over,
  };
}

describe("parseArchiveCommentPage", () => {
  it("reads the admin envelope the Go handler writes", () => {
    const page = parseArchiveCommentPage({
      items: [
        {
          id: "c1",
          campaignId: "cmp-1",
          parentId: "c0",
          subscriberId: "sub-1",
          displayName: " Dana ",
          body: "hello",
          pinned: true,
          status: "visible",
          upvotes: 4,
          downvotes: 2,
          createdAt: "2026-07-20T10:00:00Z",
        },
      ],
      total: 12,
    });
    expect(page.total).toBe(12);
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      id: "c1",
      parentId: "c0",
      subscriberId: "sub-1",
      displayName: "Dana",
      pinned: true,
      upvotes: 4,
      downvotes: 2,
    });
  });

  it("treats an ABSENT total on an empty page as the number zero", () => {
    // `Total int json:"total,omitempty"` drops a zero from the JSON entirely.
    const page = parseArchiveCommentPage({ items: [] });
    expect(page.total).toBe(0);
  });

  it("treats an absent total ALONGSIDE rows as unknown, never zero", () => {
    const page = parseArchiveCommentPage({ items: [{ id: "c1" }] });
    expect(page.total).toBeNull();
    expect(page.items).toHaveLength(1);
  });

  it("keeps a blank body — an anonymous empty comment is the kind to remove", () => {
    const page = parseArchiveCommentPage({
      items: [{ id: "c1", body: "", displayName: "" }],
    });
    expect(page.items).toHaveLength(1);
    expect(authorLabel(page.items[0]!)).toBe("Unnamed");
  });

  it("drops the Go zero time rather than rendering year 1", () => {
    const page = parseArchiveCommentPage({
      items: [{ id: "c1", createdAt: "0001-01-01T00:00:00Z" }],
    });
    expect(page.items[0]!.createdAt).toBeNull();
  });

  it("survives a non-object body without throwing", () => {
    expect(parseArchiveCommentPage(null)).toEqual({ items: [], total: 0 });
    expect(parseArchiveCommentPage("nope")).toEqual({ items: [], total: 0 });
  });
});

describe("ordering", () => {
  const older = comment({ id: "old", createdAt: "2026-07-01T00:00:00Z" });
  const newer = comment({ id: "new", createdAt: "2026-07-20T00:00:00Z" });

  it("keeps the server's newest-first order on the live tab", () => {
    expect(orderForFilter([newer, older], "visible").map((c) => c.id)).toEqual([
      "new",
      "old",
    ]);
  });

  it("flips pending to oldest-first so the longest wait is not starved", () => {
    expect(orderForFilter([newer, older], "pending").map((c) => c.id)).toEqual([
      "old",
      "new",
    ]);
  });

  it("does not mutate the array it was given", () => {
    const rows = [newer, older];
    orderForFilter(rows, "pending");
    expect(rows.map((c) => c.id)).toEqual(["new", "old"]);
  });
});

describe("presentation", () => {
  it("gives every status a spoken sentence, not just a coloured word", () => {
    for (const status of ["visible", "pending", "hidden", "spam"]) {
      const p = commentStatusPresentation(status);
      expect(p.spoken.length).toBeGreaterThan(p.label.length);
    }
  });

  it("says a status it does not recognise is unrecognised", () => {
    expect(commentStatusPresentation("weird").spoken).toContain("Unrecognised");
    expect(commentStatusPresentation("").spoken).toContain("missing");
  });

  it("distinguishes a guest from a signed-in subscriber", () => {
    expect(authorOrigin(comment())).toBe("Guest");
    expect(authorOrigin(comment({ subscriberId: "s1" }))).toBe("Subscriber");
  });

  it("collapses newlines so a preview cannot be padded off-screen", () => {
    expect(commentPreview("a\n\n\n\nb")).toBe("a b");
  });

  it("truncates a long body with an ellipsis", () => {
    const long = "x".repeat(400);
    const preview = commentPreview(long, 20);
    expect(preview).toHaveLength(20);
    expect(preview.endsWith("…")).toBe(true);
  });

  it("scores votes the way the public 'best' sort does", () => {
    expect(voteScore(comment({ upvotes: 7, downvotes: 2 }))).toBe(5);
    expect(voteScore(comment({ upvotes: 0, downvotes: 4 }))).toBe(-4);
    expect(voteLabel(comment({ upvotes: 7, downvotes: 2 }))).toBe(
      "+5 · 7 up, 2 down",
    );
    expect(voteLabel(comment({ upvotes: 0, downvotes: 4 }))).toBe(
      "-4 · 0 up, 4 down",
    );
  });
});

describe("issueLabel", () => {
  it("uses the archive index title when the index has that issue", () => {
    const titles = new Map([["cmp-1", "Issue 42 — the one about ducks"]]);
    expect(issueLabel("cmp-1", titles)).toBe("Issue 42 — the one about ducks");
  });

  it("falls back to a truncated id rather than inventing a title", () => {
    expect(issueLabel("11111111-2222-4333-8444-555555555555", null)).toBe(
      "Issue 111111…555555",
    );
  });

  it("says the id itself is missing when the wire carried none", () => {
    expect(issueLabel("", new Map())).toBe("Issue unknown");
  });
});

describe("actions", () => {
  it("offers pin, hide and spam on a live comment", () => {
    expect(actionsForComment(comment())).toEqual([
      "pin",
      "hide",
      "spam",
      "delete",
    ]);
  });

  it("offers unpin instead of pin once it is pinned", () => {
    expect(actionsForComment(comment({ pinned: true }))).toContain("unpin");
    expect(actionsForComment(comment({ pinned: true }))).not.toContain("pin");
  });

  it("never offers pin on something readers cannot see", () => {
    for (const status of ["hidden", "spam", "pending"]) {
      const actions = actionsForComment(comment({ status }));
      expect(actions).not.toContain("pin");
      expect(actions).not.toContain("unpin");
      expect(actions).toContain("restore");
    }
  });

  it("does not offer the state a comment is already in", () => {
    expect(actionsForComment(comment({ status: "spam" }))).not.toContain(
      "spam",
    );
    expect(actionsForComment(comment({ status: "hidden" }))).not.toContain(
      "hide",
    );
  });

  it("maps each status verb to the value validStatus accepts", () => {
    expect(statusForAction("hide")).toBe("hidden");
    expect(statusForAction("spam")).toBe("spam");
    expect(statusForAction("restore")).toBe("visible");
    expect(statusForAction("pin")).toBeNull();
    expect(statusForAction("unpin")).toBeNull();
    expect(statusForAction("delete")).toBeNull();
  });
});

describe("confirmation copy", () => {
  it("warns that DELETE takes the replies with it, and offers hide instead", () => {
    // Repo.Delete hard-deletes and the FK cascades to children.
    const copy = moderationCopy("delete", comment());
    expect(copy.destructive).toBe(true);
    expect(copy.message).toContain("every reply underneath it");
    expect(copy.consequence).toContain("hide it instead");
  });

  it("promises hide KEEPS the replies, which is the difference that matters", () => {
    const copy = moderationCopy("hide", comment());
    expect(copy.message).toContain("Replies underneath it are kept");
    expect(copy.destructive).toBe(false);
  });

  it("says restoring publishes a stranger's words", () => {
    expect(moderationCopy("restore", comment()).consequence).toContain(
      "publishes a stranger's words",
    );
  });

  it("names the author in the title so the wrong row is obvious", () => {
    expect(moderationCopy("spam", comment({ displayName: "Ade" })).title).toBe(
      "Mark Ade's comment as spam?",
    );
  });

  it("reports each verb's outcome in the past tense", () => {
    expect(moderationSuccessMessage("hide", comment())).toContain("Hidden");
    expect(moderationSuccessMessage("delete", comment())).toContain("replies");
    expect(moderationSuccessMessage("restore", comment())).toContain("Live");
  });
});

describe("truncation and failure", () => {
  it("states the cap only when the server gave a bigger total", () => {
    const notice = truncationNotice({
      items: new Array(200).fill(comment()),
      total: 640,
    });
    expect(notice).toContain("200 newest of 640");
  });

  it("says nothing when the page IS the total", () => {
    expect(truncationNotice({ items: [comment()], total: 1 })).toBeNull();
  });

  it("says nothing when the total is unknown — no invented claim", () => {
    expect(truncationNotice({ items: [comment()], total: null })).toBeNull();
  });

  it("names the missing role on a 403 rather than blaming the network", () => {
    expect(moderationFailureMessage(403)).toContain("owner or admin");
    expect(moderationFailureMessage(404)).toContain("no longer there");
    expect(moderationFailureMessage(500)).toBe("Please try again.");
  });
});
