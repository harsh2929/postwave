import { describe, expect, it } from "vitest";

import { isFrequencyCap } from "../../components/deliverability/FrequencyCapsCard";
import { isCustomFieldLimits } from "../../components/settings/CustomFieldGovernance";
import {
  isTagMembership,
  isTagSubscriber,
  isTagSuggestion,
} from "../../components/tags/tagRemoteValidation";
import { isTag, isTagGroup, isTagUsage } from "../../pages/tags/useTagCatalog";

const TAG_ID = "11111111-1111-4111-8111-111111111111";
const GROUP_ID = "22222222-2222-4222-8222-222222222222";
const SUBSCRIBER_ID = "33333333-3333-4333-8333-333333333333";
const NOW = "2026-07-01T00:00:00Z";

describe("remote settings and deliverability shape validation", () => {
  it("accepts complete custom-field limits and rejects partial or unsafe values", () => {
    expect(
      isCustomFieldLimits({
        max_custom_fields: 1_000,
        max_searchable_fields: 20,
        used_custom_fields: 42,
        used_searchable_fields: 3,
      }),
    ).toBe(true);
    expect(isCustomFieldLimits({ max_custom_fields: 1_000 })).toBe(false);
    expect(
      isCustomFieldLimits({
        max_custom_fields: Number.NaN,
        max_searchable_fields: 20,
        used_custom_fields: 42,
        used_searchable_fields: 3,
      }),
    ).toBe(false);
  });

  it("accepts complete frequency caps and rejects malformed renderer rows", () => {
    expect(
      isFrequencyCap({
        id: "cap-1",
        label: "Marketing email limit",
        max_sends: 3,
        window_hours: 24,
        active: true,
        channels: ["email", "sms"],
        updated_at: NOW,
      }),
    ).toBe(true);
    expect(
      isFrequencyCap({
        id: "cap-1",
        label: "Incomplete",
        active: true,
      }),
    ).toBe(false);
    expect(
      isFrequencyCap({
        id: "cap-1",
        label: "Unknown channel",
        max_sends: 3,
        window_hours: 24,
        active: true,
        channels: ["fax"],
      }),
    ).toBe(false);
    expect(
      isFrequencyCap({
        id: "cap-1",
        label: "Duplicate channel",
        max_sends: 3,
        window_hours: 24,
        active: true,
        channels: ["email", "email"],
      }),
    ).toBe(false);
  });

  it("validates tag catalogue, group, and taxonomy rows before rendering", () => {
    const tag = {
      id: TAG_ID,
      name: "customer",
      color: "blue",
      description: "Customers",
      created_at: NOW,
      created_by: null,
      updated_at: NOW,
      updated_by: null,
      archived_at: null,
      pii: false,
      group_id: GROUP_ID,
      version: 1,
      etag: `"tag:${TAG_ID}:v1"`,
    };
    expect(isTag(tag)).toBe(true);
    expect(isTag({ ...tag, name: 42 })).toBe(false);

    expect(
      isTagGroup({
        id: GROUP_ID,
        name: "Lifecycle",
        color: "blue",
        sort_order: 1,
        created_at: NOW,
      }),
    ).toBe(true);
    expect(isTagGroup({ id: GROUP_ID, name: "Lifecycle" })).toBe(false);

    expect(
      isTagUsage({ tag: "customer", subscribers: 12, registered: true }),
    ).toBe(true);
    expect(isTagUsage({ tag: "customer", registered: false })).toBe(false);
    expect(
      isTagUsage({ tag: "customer", subscribers: -1, registered: false }),
    ).toBe(false);
  });

  it("validates tag suggestions, subscriber rows, and membership analytics", () => {
    expect(
      isTagSuggestion({ tag: "customer", subscribers: 12, registered: true }),
    ).toBe(true);
    expect(
      isTagSuggestion({ tag: "customer", subscribers: -1, registered: true }),
    ).toBe(false);

    expect(
      isTagSubscriber({
        id: SUBSCRIBER_ID,
        email: "reader@example.test",
        status: "active",
        created_at: NOW,
      }),
    ).toBe(true);
    expect(
      isTagSubscriber({
        id: SUBSCRIBER_ID,
        email: "reader@example.test",
        status: "active",
      }),
    ).toBe(false);

    expect(
      isTagMembership({
        tag_id: TAG_ID,
        days: 30,
        current_count: 12,
        added: 3,
        removed: 1,
        daily: [{ date: "2026-07-01", net: 2 }],
        coverage: {
          contract_version: "canonical-join-events-v2",
          coverage_started_at: NOW,
          as_of: "2026-07-01T23:59:59Z",
          completeness: "complete_from_coverage_start",
          source: "subscriber_tags_event_ledger",
          requested_window_complete: false,
        },
      }),
    ).toBe(true);
    expect(
      isTagMembership({
        tag_id: TAG_ID,
        days: 30,
        current_count: 12,
        added: 3,
        removed: 1,
        daily: [{ date: "2026-07-01", net: Number.NaN }],
        coverage: {
          contract_version: "canonical-join-events-v2",
          coverage_started_at: NOW,
          as_of: "2026-07-01T23:59:59Z",
          completeness: "complete_from_coverage_start",
          source: "subscriber_tags_event_ledger",
          requested_window_complete: false,
        },
      }),
    ).toBe(false);
  });
});
