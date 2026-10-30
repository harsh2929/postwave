/**
 * The two feedback rules that carry real user consequence, tested directly:
 * an undo window long enough to act on, and a confirmation gate that cannot be
 * satisfied by a near-miss.
 */
import { describe, expect, it } from "vitest";

import {
  TOAST_ACTION_MS,
  TOAST_QUEUE_LIMIT,
  confirmPhraseSatisfied,
  enqueueFeedback,
  feedbackInterrupts,
  isRedundantFeedback,
  toastAnnouncement,
  toastDurationMs,
} from "./feedbackPolicy";

describe("toast timing", () => {
  it("gives an undo toast a longer window than a plain confirmation", () => {
    const plain = toastDurationMs({ message: "Saved" });
    const withUndo = toastDurationMs({
      message: "Suppressed",
      action: { label: "Undo", onPress: () => undefined },
    });
    expect(withUndo).toBeGreaterThan(plain);
    // Long enough to read, decide, and reach the button.
    expect(withUndo).toBe(TOAST_ACTION_MS);
    expect(TOAST_ACTION_MS).toBeGreaterThanOrEqual(6000);
  });

  it("honours an explicit duration, including zero", () => {
    expect(toastDurationMs({ message: "x", durationMs: 1200 })).toBe(1200);
    expect(toastDurationMs({ message: "x", durationMs: 0 })).toBe(0);
  });
});

describe("toast announcements", () => {
  it("announces that an undo exists", () => {
    const spoken = toastAnnouncement({
      message: "Subscriber suppressed",
      action: { label: "Undo", onPress: () => undefined },
    });
    expect(spoken).toContain("Subscriber suppressed");
    expect(spoken).toContain("Undo");
  });

  it("does not invent an action when there is none", () => {
    expect(toastAnnouncement({ message: "Saved" })).toBe("Saved");
  });
});

describe("confirm phrase gate", () => {
  it("passes straight through when no phrase is required", () => {
    expect(confirmPhraseSatisfied(undefined, "")).toBe(true);
    expect(confirmPhraseSatisfied(undefined, "anything")).toBe(true);
  });

  it("requires an exact match — a near miss must not unlock a delete", () => {
    expect(confirmPhraseSatisfied("Weekly Digest", "Weekly Digest")).toBe(true);
    expect(confirmPhraseSatisfied("Weekly Digest", "weekly digest")).toBe(false);
    expect(confirmPhraseSatisfied("Weekly Digest", "Weekly")).toBe(false);
    expect(confirmPhraseSatisfied("Weekly Digest", "Weekly Digest 2")).toBe(false);
    expect(confirmPhraseSatisfied("Weekly Digest", "")).toBe(false);
  });

  it("tolerates only surrounding whitespace", () => {
    expect(confirmPhraseSatisfied("Weekly Digest", "  Weekly Digest  ")).toBe(
      true,
    );
    expect(confirmPhraseSatisfied("Weekly Digest", "Weekly  Digest")).toBe(false);
  });
});

describe("toast queue", () => {
  const undo = { label: "Undo", onPress: () => undefined };

  it("queues rather than replacing, so a second toast cannot erase the first", () => {
    const queue = enqueueFeedback([{ message: "Suppressed", action: undo }], {
      message: "Deleted",
    });
    expect(queue.map((entry) => entry.message)).toEqual([
      "Suppressed",
      "Deleted",
    ]);
  });

  it("collapses an identical actionless repeat instead of showing it twice", () => {
    const once = enqueueFeedback([], { message: "Couldn't mark that read." });
    const twice = enqueueFeedback(once, { message: "Couldn't mark that read." });
    expect(twice).toHaveLength(1);
  });

  it("does NOT collapse a repeat that carries its own undo", () => {
    const first = enqueueFeedback([], { message: "Suppressed", action: undo });
    const second = enqueueFeedback(first, {
      message: "Suppressed",
      action: undo,
    });
    expect(second).toHaveLength(2);
  });

  it("evicts a plain confirmation before an undo when the queue overflows", () => {
    let queue = enqueueFeedback<{
      message: string;
      action?: typeof undo | undefined;
    }>([], { message: "a" });
    queue = enqueueFeedback(queue, { message: "b", action: undo });
    queue = enqueueFeedback(queue, { message: "c" });
    queue = enqueueFeedback(queue, { message: "d" });
    expect(queue).toHaveLength(TOAST_QUEUE_LIMIT);
    // "a" (oldest, no action) went; the undo survived.
    expect(queue.map((entry) => entry.message)).toEqual(["b", "c", "d"]);
  });

  it("still honours the bound when every entry carries an action", () => {
    let queue = enqueueFeedback<{ message: string; action?: typeof undo }>([], {
      message: "a",
      action: undo,
    });
    for (const message of ["b", "c", "d"]) {
      queue = enqueueFeedback(queue, { message, action: undo });
    }
    expect(queue).toHaveLength(TOAST_QUEUE_LIMIT);
    expect(queue.map((entry) => entry.message)).toEqual(["b", "c", "d"]);
  });

  it("never returns the caller's array identity", () => {
    const pending = [{ message: "a" }];
    expect(enqueueFeedback(pending, { message: "a" })).not.toBe(pending);
  });

  it("lets an error interrupt a routine confirmation, but not another error", () => {
    expect(feedbackInterrupts("success", "error")).toBe(true);
    expect(feedbackInterrupts("info", "error")).toBe(true);
    expect(feedbackInterrupts(undefined, "error")).toBe(true);
    expect(feedbackInterrupts("error", "error")).toBe(false);
    expect(feedbackInterrupts("error", "success")).toBe(false);
    expect(feedbackInterrupts("success", "warning")).toBe(false);
  });
});

describe("redundant feedback", () => {
  it("treats an identical actionless message as saying nothing new", () => {
    expect(
      isRedundantFeedback({ message: "Failed" }, { message: "Failed" }),
    ).toBe(true);
  });

  it("never calls two undos redundant, however identical their copy", () => {
    const action = { label: "Undo", onPress: () => undefined };
    expect(
      isRedundantFeedback(
        { message: "Suppressed", action },
        { message: "Suppressed", action },
      ),
    ).toBe(false);
    expect(
      isRedundantFeedback({ message: "Suppressed" }, { message: "Suppressed", action }),
    ).toBe(false);
  });

  it("does not collapse different messages", () => {
    expect(isRedundantFeedback({ message: "a" }, { message: "b" })).toBe(false);
  });
});
