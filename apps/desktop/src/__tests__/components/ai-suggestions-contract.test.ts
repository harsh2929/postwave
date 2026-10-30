import { describe, expect, it } from "vitest";

import { parseAISuggestions } from "../../components/segments/ai-suggestions-contract";

const suggestion = {
  key: "engaged",
  name: "Recently engaged",
  description: "Opened in the last week",
  predicate_json: { field: "last_open_at" },
  estimated_size: 10,
  rationale: "Recent engagement is predictive",
  category: "engagement",
};

describe("AI suggestions runtime contract", () => {
  it("accepts a complete renderer payload", () => {
    const payload = {
      items: [suggestion],
      generated: "heuristic-v1",
      notice: "Heuristic suggestions",
    };
    expect(parseAISuggestions(payload)).toEqual(payload);
  });

  it("rejects malformed envelopes and card fields", () => {
    expect(parseAISuggestions({ items: [{}] })).toBeNull();
    expect(
      parseAISuggestions({
        items: [{ ...suggestion, estimated_size: undefined }],
        generated: "heuristic-v1",
        notice: "",
      }),
    ).toBeNull();
  });
});
