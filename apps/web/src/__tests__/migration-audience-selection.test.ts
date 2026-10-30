import { describe, expect, it } from "vitest";

import {
  initialSelectedAudienceIds,
  selectedAudienceSet,
  selectedMailchimpAudienceIds,
} from "@/lib/migration-audience-selection";
import type { DiscoveryReport } from "@/lib/types";

const discovery: DiscoveryReport = {
  source: "mailchimp",
  subscribers_count: 30,
  segments_count: 0,
  automations_count: 0,
  archive_count: 0,
  paid_subs_count: 0,
  custom_fields: [],
  warnings: [],
  audiences: [
    { id: "aud_b", name: "B", subscribers_total: 20 },
    { id: "aud_a", name: "A", subscribers_total: 10 },
  ],
};

describe("Mailchimp migration audience selection helpers", () => {
  it("requires the operator to explicitly select Mailchimp audiences", () => {
    expect(initialSelectedAudienceIds("mailchimp", discovery, [])).toEqual([]);
  });

  it("keeps an existing selected audience subset", () => {
    expect(
      initialSelectedAudienceIds("mailchimp", discovery, ["aud_b"]),
    ).toEqual(["aud_b"]);
  });

  it("filters stale selected ids that are not in the current discovery", () => {
    expect(
      initialSelectedAudienceIds("mailchimp", discovery, [
        "aud_missing",
        "aud_b",
      ]),
    ).toEqual(["aud_b"]);
    expect(selectedMailchimpAudienceIds(discovery, ["aud_missing"])).toEqual(
      [],
    );
  });

  it("treats an empty selected list as no audiences after initialization", () => {
    expect(selectedAudienceSet(discovery, [])).toEqual(new Set());
    expect(selectedMailchimpAudienceIds(discovery, [])).toEqual([]);
  });

  it("returns an explicit empty scope when discovery has no audiences", () => {
    expect(
      selectedMailchimpAudienceIds({ ...discovery, audiences: undefined }, []),
    ).toEqual([]);
  });
});
