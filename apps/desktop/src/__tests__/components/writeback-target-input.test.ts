import { describe, expect, it } from "vitest";

import {
  buildWritebackTargetInput,
  type WritebackTargetDraft,
} from "../../components/WritebackTargetsSection";

describe("write-back target input builder", () => {
  it("builds the exact segment payload with normalized maps and advanced keys", () => {
    expect(
      buildWritebackTargetInput(
        draft({
          tags: " VIP, Newsletter, ",
          fieldRows: [{ id: "1", key: " tier ", value: " gold " }],
          traitRows: [{ id: "2", key: "lifetime_value", value: " clv_cents " }],
          syncInterval: "15",
          advancedJson: '{"object":"contact"}',
        }),
      ),
    ).toEqual({
      input: {
        provider: "hubspot",
        name: "VIP sync",
        status: "active",
        credentials_ref: "vault://writeback/hubspot",
        settings: {
          source_segment_id: "segment-1",
          tags: ["VIP", "Newsletter"],
          field_map: { tier: "gold" },
          trait_field_map: { lifetime_value: "clv_cents" },
          object: "contact",
        },
        sync_interval_minutes: 15,
      },
    });
  });

  it("accepts only UUID list sources and never retains the segment key", () => {
    expect(
      buildWritebackTargetInput(
        draft({
          sourceKind: "list",
          sourceSegmentId: "stale-segment",
          sourceListId: "123e4567-e89b-12d3-a456-426614174000",
        }),
      ),
    ).toEqual({
      input: expect.objectContaining({
        settings: {
          source_list_id: "123e4567-e89b-12d3-a456-426614174000",
        },
      }),
    });
    expect(
      buildWritebackTargetInput(
        draft({ sourceKind: "list", sourceListId: "not-a-uuid" }),
      ),
    ).toEqual({ error: "Source list id must be a valid UUID." });
  });

  it("fails incomplete rows and reserved advanced overrides closed", () => {
    expect(
      buildWritebackTargetInput(
        draft({ fieldRows: [{ id: "1", key: "tier", value: "" }] }),
      ),
    ).toEqual({
      error: "Every static field needs both a platform field and a value.",
    });
    expect(
      buildWritebackTargetInput(
        draft({ advancedJson: '{"source_segment_id":"other"}' }),
      ),
    ).toEqual({
      error:
        "Advanced settings can't override source_segment_id — use the fields above.",
    });
    expect(buildWritebackTargetInput(draft({ advancedJson: "{" }))).toEqual({
      error: "Advanced settings must be valid JSON.",
    });
  });

  it("preserves validation order for identity and source requirements", () => {
    expect(buildWritebackTargetInput(draft({ provider: "" }))).toEqual({
      error: "Pick a provider.",
    });
    expect(buildWritebackTargetInput(draft({ name: " " }))).toEqual({
      error:
        "A name is required — targets are keyed on (provider, name), so reusing a name updates that target instead of creating a new one.",
    });
    expect(buildWritebackTargetInput(draft({ credentialsRef: " " }))).toEqual({
      error: "A vault credential reference is required.",
    });
    expect(buildWritebackTargetInput(draft({ sourceSegmentId: "" }))).toEqual({
      error: "Choose a source segment.",
    });
  });
});

function draft(
  overrides: Partial<WritebackTargetDraft> = {},
): WritebackTargetDraft {
  return {
    provider: "hubspot",
    name: "VIP sync",
    credentialsRef: "vault://writeback/hubspot",
    sourceKind: "segment",
    sourceSegmentId: "segment-1",
    sourceListId: "",
    tags: "",
    fieldRows: [],
    traitRows: [],
    syncInterval: "0",
    advancedJson: "",
    ...overrides,
  };
}
