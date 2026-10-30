/**
 * The intent chips: counts come only from the unfiltered response, the chip
 * vocabulary is EXACTLY the classify verb's (no filter can name a label the
 * server does not), and the filter param round-trips URL-safely.
 */
import { describe, expect, it } from "vitest";

import { REPLY_INTENTS } from "@/lib/replyClassification";

import {
  intentFilterParam,
  readIntentCounts,
  replyIntentChips,
} from "./campaignReplyIntents";

describe("readIntentCounts", () => {
  it("reads intent_counts, dropping junk values", () => {
    expect(
      readIntentCounts({ intent_counts: { question: 5, praise: 0, bad: -1, junk: "x" } }),
    ).toEqual({ question: 5, praise: 0 });
  });
  it("empty for a filtered/absent body", () => {
    expect(readIntentCounts(null)).toEqual({});
    expect(readIntentCounts({})).toEqual({});
  });
});

describe("replyIntentChips", () => {
  it("leads with All (total) then one chip per server intent", () => {
    const chips = replyIntentChips({ question: 5 }, 42);
    expect(chips[0]).toEqual({ intent: null, label: "All", count: 42 });
    expect(chips).toHaveLength(1 + REPLY_INTENTS.length);
    const question = chips.find((c) => c.intent === "question");
    expect(question?.count).toBe(5);
    // A count the server did not report is unknown, not zero.
    const praise = chips.find((c) => c.intent === "praise");
    expect(praise?.count).toBeNull();
  });
});

describe("intentFilterParam", () => {
  it("empty for the unfiltered list, &intent= otherwise", () => {
    expect(intentFilterParam(null)).toBe("");
    expect(intentFilterParam("question")).toBe("&intent=question");
  });
});
