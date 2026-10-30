// Region card helpers (full-surface wiring #57): zone labels derive
// strictly from the is_eu/is_us booleans the public endpoint sends,
// and the current region floats to the top of the list.

import { describe, expect, it } from "vitest";

import type { CurrentRegionInfo, RegionInfo } from "../../lib/api-client";
import {
  describeCurrentRegion,
  regionZoneLabel,
  sortRegions,
} from "../../components/settings/region-helpers";

describe("regionZoneLabel", () => {
  it("labels EU / US / Other from the wire booleans", () => {
    expect(regionZoneLabel({ is_eu: true })).toBe("EU");
    expect(regionZoneLabel({ is_eu: false, is_us: true })).toBe("US");
    expect(regionZoneLabel({ is_eu: false, is_us: false })).toBe("Other");
    // Rows from /api/regions don't carry is_us at all.
    expect(regionZoneLabel({ is_eu: false })).toBe("Other");
  });
});

describe("describeCurrentRegion", () => {
  const current: CurrentRegionInfo = {
    region: "eu-north-1",
    is_eu: true,
    is_us: false,
    sdk_host: "eu.api.moosewave.com",
    postmark_base: "",
    mailgun_base: "",
    ses_region: "eu-north-1",
  };

  it("names the region and zone without inventing anything else", () => {
    const copy = describeCurrentRegion(current);
    expect(copy).toContain("eu-north-1");
    expect(copy).toContain("(EU)");
  });
});

describe("sortRegions", () => {
  const regions: RegionInfo[] = [
    { region: "us-east-1", sdk_host: "us.x", is_eu: false },
    { region: "eu-north-1", sdk_host: "eu.x", is_eu: true },
    { region: "ap-south-1", sdk_host: "ap.x", is_eu: false },
  ];

  it("floats the current region, alpha for the rest", () => {
    expect(sortRegions(regions, "us-east-1").map((r) => r.region)).toEqual([
      "us-east-1",
      "ap-south-1",
      "eu-north-1",
    ]);
  });

  it("is plain alpha without a current region", () => {
    expect(sortRegions(regions).map((r) => r.region)).toEqual([
      "ap-south-1",
      "eu-north-1",
      "us-east-1",
    ]);
  });

  it("sorts rows with a missing region field without crashing", () => {
    // A row can arrive without `region`; the sort must not throw on
    // `undefined.localeCompare`.
    const partial = [
      { sdk_host: "x", is_eu: false },
      { region: "eu-north-1", sdk_host: "eu.x", is_eu: true },
    ] as unknown as RegionInfo[];
    expect(() => sortRegions(partial)).not.toThrow();
    expect(() => sortRegions(partial, "eu-north-1")).not.toThrow();
  });
});
