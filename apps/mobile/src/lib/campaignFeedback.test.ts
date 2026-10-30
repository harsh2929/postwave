import { describe, expect, it } from "vitest";

import {
  EMPTY_FEEDBACK_THREAD,
  FEEDBACK_MAX_CHARS,
  feedbackDraftProblem,
  feedbackSummary,
  isFeedbackResolved,
  readFeedbackThread,
} from "./campaignFeedback";

describe("isFeedbackResolved", () => {
  it("treats an ABSENT resolved_at as open", () => {
    // `resolved_at` is `*time.Time` with omitempty: an open comment omits the
    // key entirely. A `=== null` test would mark every open comment resolved.
    expect(isFeedbackResolved({})).toBe(false);
    expect(isFeedbackResolved({ resolved_at: null })).toBe(false);
    expect(isFeedbackResolved({ resolved_at: "" })).toBe(false);
  });

  it("treats Go's zero time as open, not as a 1-AD resolution", () => {
    expect(isFeedbackResolved({ resolved_at: "0001-01-01T00:00:00Z" })).toBe(
      false,
    );
  });

  it("is true for a real timestamp", () => {
    expect(isFeedbackResolved({ resolved_at: "2026-07-01T09:00:00Z" })).toBe(
      true,
    );
  });
});

describe("readFeedbackThread", () => {
  it("returns the empty thread for absent / malformed payloads", () => {
    expect(readFeedbackThread(null)).toEqual(EMPTY_FEEDBACK_THREAD);
    expect(readFeedbackThread({})).toEqual(EMPTY_FEEDBACK_THREAD);
    expect(readFeedbackThread({ items: "nope" })).toEqual(
      EMPTY_FEEDBACK_THREAD,
    );
  });

  it("partitions open above resolved while keeping server order in each", () => {
    const thread = readFeedbackThread({
      items: [
        { id: "3", body: "newest resolved", resolved_at: "2026-07-03T00:00:00Z" },
        { id: "2", body: "newer open" },
        { id: "1", body: "older open" },
        { id: "0", body: "older resolved", resolved_at: "2026-07-01T00:00:00Z" },
      ],
    });
    expect(thread.rows.map((r) => r.id)).toEqual(["2", "1", "3", "0"]);
    expect(thread.openCount).toBe(2);
    expect(thread.resolvedCount).toBe(2);
    expect(thread.empty).toBe(false);
  });

  it("drops rows with no id or no body", () => {
    // An id-less row cannot be resolved; a body-less row has nothing to read.
    const thread = readFeedbackThread({
      items: [
        { body: "orphan" },
        { id: "1" },
        { id: "  ", body: "blank id" },
        { id: "2", body: "   " },
        { id: "3", body: "real" },
        null,
        "junk",
      ],
    });
    expect(thread.rows.map((r) => r.id)).toEqual(["3"]);
  });

  it("names an author-less comment rather than showing a blank byline", () => {
    const thread = readFeedbackThread({
      items: [{ id: "1", body: "from an API key" }],
    });
    expect(thread.rows[0]?.author).toBe("Someone in this workspace");
  });

  it("bounds a long body", () => {
    const long = "z".repeat(FEEDBACK_MAX_CHARS + 50);
    const thread = readFeedbackThread({ items: [{ id: "1", body: long }] });
    expect(thread.rows[0]?.body.length).toBe(FEEDBACK_MAX_CHARS + 1);
  });

  it("never reports a resolvedAt for an open row", () => {
    const thread = readFeedbackThread({
      items: [{ id: "1", body: "open", resolved_at: "0001-01-01T00:00:00Z" }],
    });
    expect(thread.rows[0]?.resolved).toBe(false);
    expect(thread.rows[0]?.resolvedAt).toBeNull();
  });
});

describe("feedbackDraftProblem", () => {
  it("rejects an empty or whitespace-only draft, matching the handler", () => {
    expect(feedbackDraftProblem("")).toContain("Write a comment");
    expect(feedbackDraftProblem("   \n ")).toContain("Write a comment");
  });
  it("rejects an over-long draft and says by how much", () => {
    const problem = feedbackDraftProblem("q".repeat(FEEDBACK_MAX_CHARS + 7));
    expect(problem).toContain(String(FEEDBACK_MAX_CHARS + 7));
  });
  it("accepts a normal note", () => {
    expect(feedbackDraftProblem("  subject is too long  ")).toBeNull();
  });
});

describe("feedbackSummary", () => {
  it("describes the thread by what is still open", () => {
    expect(feedbackSummary(EMPTY_FEEDBACK_THREAD)).toBe("No comments yet");
    expect(
      feedbackSummary(
        readFeedbackThread({
          items: [
            { id: "1", body: "a" },
            { id: "2", body: "b", resolved_at: "2026-07-01T00:00:00Z" },
          ],
        }),
      ),
    ).toBe("1 open · 1 resolved");
    expect(
      feedbackSummary(readFeedbackThread({ items: [{ id: "1", body: "a" }] })),
    ).toBe("1 open");
  });
});
