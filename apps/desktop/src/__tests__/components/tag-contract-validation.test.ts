import { describe, expect, it } from "vitest";

import {
  isTag,
  isTagGroup,
  isTagMembership,
} from "../../components/tags/tagRemoteValidation";
import { tagColorPresentation } from "../../components/tags/tagColorPresentation";
import {
  validTagGroups,
  validTags,
} from "../../pages/tags/tagCatalogContracts";

const TAG_ID = "11111111-1111-4111-8111-111111111111";

function tag(overrides: Record<string, unknown> = {}) {
  return {
    id: TAG_ID,
    name: "Customer",
    color: "slate",
    description: "",
    created_at: "2026-07-01T00:00:00Z",
    updated_at: "2026-07-01T00:00:00Z",
    pii: false,
    version: 1,
    etag: `"tag:${TAG_ID}:v1"`,
    ...overrides,
  };
}

function group(overrides: Record<string, unknown> = {}) {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    name: "Lifecycle",
    color: "teal",
    sort_order: 0,
    created_at: "2026-07-01T00:00:00Z",
    ...overrides,
  };
}

function membership(overrides: Record<string, unknown> = {}) {
  return {
    tag_id: TAG_ID,
    days: 30,
    current_count: 9,
    added: 3,
    removed: 1,
    daily: [{ date: "2026-07-01", net: 2 }],
    coverage: {
      contract_version: "canonical-join-events-v2",
      coverage_started_at: "2026-06-01T00:00:00Z",
      as_of: "2026-07-01T12:00:00Z",
      completeness: "complete_from_coverage_start",
      source: "subscriber_tags_event_ledger",
      requested_window_complete: true,
    },
    ...overrides,
  };
}

describe("tag 1774 read and presentation contracts", () => {
  it("preserves the complete bounded legacy read envelope without truncation", () => {
    const legacyName = ` ${"n".repeat(98)} `;
    const legacyDescription = "d".repeat(4_096);
    const legacyColor = "unsupported-legacy-colour-value!";

    expect(
      isTag(
        tag({
          name: legacyName,
          description: legacyDescription,
          color: legacyColor,
        }),
      ),
    ).toBe(true);
    expect(
      isTagGroup(
        group({
          name: legacyName,
          color: legacyColor,
          sort_order: -2_147_483_648,
        }),
      ),
    ).toBe(true);
  });

  it("rejects every value immediately outside the bounded legacy envelope", () => {
    expect(isTag(tag({ name: "n".repeat(101) }))).toBe(false);
    expect(isTag(tag({ description: "d".repeat(4_097) }))).toBe(false);
    expect(isTag(tag({ color: "c".repeat(33) }))).toBe(false);
    expect(isTagGroup(group({ name: "g".repeat(101) }))).toBe(false);
    expect(isTagGroup(group({ color: "c".repeat(33) }))).toBe(false);
    expect(isTagGroup(group({ sort_order: Number.MAX_SAFE_INTEGER + 1 }))).toBe(
      false,
    );
  });

  it("renders unknown colours through a neutral token with honest provenance", () => {
    const malicious = "url(javascript:alert(1))";
    const presentation = tagColorPresentation(malicious);

    expect(presentation.legacy).toBe(true);
    expect(presentation.background).toBe("#64748b");
    expect(presentation.background).not.toContain(malicious);
    expect(tagColorPresentation("#F0a").legacy).toBe(false);
    expect(tagColorPresentation("ROSE").legacy).toBe(false);
  });

  it("rejects duplicate identities after Unicode normalization and case folding", () => {
    expect(
      validTags([
        tag(),
        tag({
          id: "33333333-3333-4333-8333-333333333333",
          name: "customer",
          etag: '"tag:33333333-3333-4333-8333-333333333333:v1"',
        }),
      ]),
    ).toBe(false);
    expect(
      validTagGroups([
        group({ name: "Ａudience" }),
        group({
          id: "44444444-4444-4444-8444-444444444444",
          name: "Audience",
        }),
      ]),
    ).toBe(false);
  });

  it("accepts only internally coherent, exact membership coverage", () => {
    expect(isTagMembership(membership())).toBe(true);
    expect(
      isTagMembership(
        membership({
          coverage: {
            ...membership().coverage,
            contract_version: "legacy-v1",
          },
        }),
      ),
    ).toBe(false);
    expect(isTagMembership(membership({ added: 4 }))).toBe(false);
    expect(
      isTagMembership(membership({ daily: [{ date: "2026-02-31", net: 2 }] })),
    ).toBe(false);
    expect(
      isTagMembership(
        membership({
          coverage: {
            ...membership().coverage,
            coverage_started_at: "2026-07-02T00:00:00Z",
          },
        }),
      ),
    ).toBe(false);
  });
});
