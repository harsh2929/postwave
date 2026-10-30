// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import {
  buildWritebackTargetInput,
  hasIncompleteRow,
  rowsToMap,
  type BuildWritebackTargetInputArgs,
} from "@/components/integrations/writeback-create-form-helpers";

function args(
  overrides: Partial<BuildWritebackTargetInputArgs> = {},
): BuildWritebackTargetInputArgs {
  return {
    advancedJson: "",
    credentialsRef: " vault://writeback/shopify ",
    fieldRows: [],
    name: " VIP sync ",
    provider: "shopify",
    sourceKind: "segment",
    sourceListId: "",
    sourceSegmentId: "seg_123",
    syncInterval: "30",
    tags: " VIP, Newsletter, ",
    traitRows: [],
    ...overrides,
  };
}

describe("writeback create form helpers", () => {
  it("builds a create payload from segment source, tags, maps, and advanced settings", () => {
    const result = buildWritebackTargetInput(
      args({
        advancedJson: '{"shop_domain":"acme.myshopify.com"}',
        fieldRows: [
          { id: "field_1", key: "accepts_marketing", value: "true" },
        ],
        traitRows: [
          { id: "trait_1", key: "lifetime_value", value: "ltv_cents" },
        ],
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.input).toEqual({
      provider: "shopify",
      name: "VIP sync",
      status: "active",
      credentials_ref: "vault://writeback/shopify",
      sync_interval_minutes: 30,
      settings: {
        source_segment_id: "seg_123",
        tags: ["VIP", "Newsletter"],
        field_map: { accepts_marketing: "true" },
        trait_field_map: { lifetime_value: "ltv_cents" },
        shop_domain: "acme.myshopify.com",
      },
    });
  });

  it("validates list ids and advanced settings ownership", () => {
    expect(
      buildWritebackTargetInput(
        args({ sourceKind: "list", sourceListId: "not-a-uuid" }),
      ),
    ).toEqual({
      ok: false,
      error: "Source list id must be a valid UUID.",
    });

    expect(
      buildWritebackTargetInput(
        args({ advancedJson: '{"tags":["override"]}' }),
      ),
    ).toEqual({
      ok: false,
      error: "Advanced settings can't override tags - use the fields above.",
    });
  });

  it("rejects malformed field rows and non-object advanced settings", () => {
    expect(
      buildWritebackTargetInput(
        args({
          fieldRows: [{ id: "field_1", key: "accepts_marketing", value: "" }],
        }),
      ),
    ).toEqual({
      ok: false,
      error: "Every static field needs both a platform field and a value.",
    });

    expect(buildWritebackTargetInput(args({ advancedJson: "null" }))).toEqual({
      ok: false,
      error: "Advanced settings must be a JSON object.",
    });
  });

  it("normalizes key-value rows and detects incomplete rows", () => {
    const rows = [
      { id: "row_1", key: " accepts_marketing ", value: " true " },
      { id: "row_2", key: "", value: "ignored" },
      { id: "row_3", key: " empty_value ", value: "" },
    ];

    expect(rowsToMap(rows)).toEqual({
      accepts_marketing: "true",
      empty_value: "",
    });
    expect(hasIncompleteRow(rows)).toBe(true);
    expect(
      hasIncompleteRow([
        { id: "row_1", key: "accepts_marketing", value: "true" },
      ]),
    ).toBe(false);
  });
});
