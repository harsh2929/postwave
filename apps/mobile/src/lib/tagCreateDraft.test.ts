/**
 * tagCreateDraft — the create-tag policy, pinned.
 *
 * Two drift guards matter more than the rest:
 *  - every palette id must resolve through `resolveTagColor`, so the sheet
 *    can never offer a colour the chips cannot render or the server rejects;
 *  - `tagsInvalidationKey` must stay a TRUE PREFIX of every tag read's
 *    query key, or a successful create stops refreshing the catalogue.
 */
import { describe, expect, it, vi } from "vitest";

// The key modules are RN-bound at import time (SDK client, secure vault);
// stub them so the key builders resolve — the same move useAnalytics.test.ts
// makes.
vi.mock("@/api/sdkClient", () => ({ getClient: vi.fn() }));
vi.mock("@/hooks/useOnlineQueryGate", () => ({ useOnlineQueryGate: vi.fn() }));
vi.mock("@/lib/deliverabilitySnapshots", () => ({
  REFERENCE_SNAPSHOT_MAX_BYTES: 1,
  capRowsForVault: vi.fn(),
  loadSnapshotBacked: vi.fn(),
  snapshotScope: vi.fn(),
}));

// eslint-disable-next-line import/first
import { resolveTagColor } from "@/lib/tagCatalogue";
// eslint-disable-next-line import/first
import {
  buildCreateTagBody,
  dedupHintCopy,
  EMPTY_TAG_DRAFT,
  TAG_PALETTE,
  tagCreateDedupHint,
  tagCreateNearMisses,
  tagsInvalidationKey,
  validateTagDraft,
} from "@/lib/tagCreateDraft";
// eslint-disable-next-line import/first
import { tagCatalogueKey, tagGroupsKey } from "@/hooks/useTagCatalogue";
// eslint-disable-next-line import/first
import { tagSuggestionsKey } from "@/hooks/useTagSuggestions";

describe("TAG_PALETTE", () => {
  it("offers only ids the chip colour resolver recognises", () => {
    // Drift guard against both tables: TAG_COLOR_PRESETS (mobile) and
    // tagPalette (apps/api/internal/tags/tags.go:48). A palette id that
    // resolves to null would render an invisible swatch AND 400 on create.
    for (const { id } of TAG_PALETTE) {
      expect(resolveTagColor(id), id).not.toBeNull();
    }
    expect(TAG_PALETTE).toHaveLength(8);
  });
});

describe("validateTagDraft", () => {
  it("refuses an empty name without nagging about it", () => {
    const v = validateTagDraft(EMPTY_TAG_DRAFT);
    expect(v.canSubmit).toBe(false);
    expect(v.nameHint).toBeNull();
  });

  it("counts RUNES against the server cap, not UTF-16 units", () => {
    // 64 emoji = 128 UTF-16 units but exactly 64 runes: acceptable.
    const okay = { ...EMPTY_TAG_DRAFT, name: "👍".repeat(64) };
    expect(validateTagDraft(okay).canSubmit).toBe(true);
    const over = { ...EMPTY_TAG_DRAFT, name: "👍".repeat(65) };
    const v = validateTagDraft(over);
    expect(v.canSubmit).toBe(false);
    expect(v.nameHint).toMatch(/64/);
  });

  it("caps the description at the server's 1024 runes", () => {
    const v = validateTagDraft({
      ...EMPTY_TAG_DRAFT,
      name: "vip",
      description: "d".repeat(1025),
    });
    expect(v.canSubmit).toBe(false);
    expect(v.descriptionHint).toMatch(/1024/);
  });
});

describe("buildCreateTagBody", () => {
  it("trims, omits empties, and maps groupId to snake_case", () => {
    expect(
      buildCreateTagBody({
        name: "  vip  ",
        color: "teal",
        description: "  top accounts ",
        groupId: "3a41d5a1-0000-4000-8000-000000000001",
      }),
    ).toEqual({
      name: "vip",
      color: "teal",
      description: "top accounts",
      group_id: "3a41d5a1-0000-4000-8000-000000000001",
    });
    // No colour / description / group → the keys are ABSENT, not "".
    expect(buildCreateTagBody({ ...EMPTY_TAG_DRAFT, name: "vip" })).toEqual({
      name: "vip",
    });
  });
});

describe("dedup hint + near misses", () => {
  const suggestions = [
    { tag: "VIP", subscribers: 41 },
    { tag: "vip-2026", subscribers: 3 },
    { tag: "vint", subscribers: 1 },
  ];

  it("matches exactly, case-insensitively — a near miss is not a dupe", () => {
    expect(tagCreateDedupHint(suggestions, "vip")?.tag).toBe("VIP");
    expect(tagCreateDedupHint(suggestions, "  Vip ")?.tag).toBe("VIP");
    expect(tagCreateDedupHint(suggestions, "vip-20")).toBeNull();
    expect(tagCreateDedupHint(suggestions, "")).toBeNull();
  });

  it("states both outcomes — orphan registration and refusal", () => {
    const copy = dedupHintCopy({ tag: "VIP", subscribers: 41 });
    expect(copy).toMatch(/41 subscribers already carry/);
    expect(copy).toMatch(/registers it/);
    expect(copy).toMatch(/refused/);
  });

  it("offers near misses excluding the exact match, capped", () => {
    expect(tagCreateNearMisses(suggestions, "vip").map((s) => s.tag)).toEqual([
      "vip-2026",
      "vint",
    ]);
    expect(tagCreateNearMisses(suggestions, "")).toEqual([]);
    expect(tagCreateNearMisses(suggestions, "v", 1)).toHaveLength(1);
  });
});

describe("tagsInvalidationKey", () => {
  it("is a true prefix of every tag read's query key", () => {
    const tenant = "11111111-1111-4111-8111-111111111111";
    const root = tagsInvalidationKey(tenant);
    for (const key of [
      tagCatalogueKey(tenant, { query: "q", groupId: "g" }),
      tagGroupsKey(tenant),
      tagSuggestionsKey(tenant, "vip"),
    ]) {
      expect(key.slice(0, root.length)).toEqual([...root]);
    }
  });
});
