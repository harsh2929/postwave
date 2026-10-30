import { describe, expect, it } from "vitest";

import type { OmniCatalogItem } from "../../lib/api-client";
import {
  basisPointsToPercent,
  normalizeOmniCampaign,
  normalizeOmniCampaignList,
  normalizeOmniCatalog,
} from "../../components/automations/omnichannel-helpers";

const EMAIL_CHANNEL: OmniCatalogItem = {
  key: "email",
  label: "Email",
  runtime_status: "supported",
  fields: [{ key: "sender", type: "string", required: true }],
};

describe("basisPointsToPercent", () => {
  it("formats bounded definition weights without inventing a value", () => {
    expect(basisPointsToPercent(5000)).toBe("50%");
    expect(basisPointsToPercent(25)).toBe("0.25%");
    expect(basisPointsToPercent(undefined)).toBe("—");
  });
});

describe("untrusted omnichannel response normalization", () => {
  it("accepts a complete catalog without treating declarations as readiness", () => {
    const result = normalizeOmniCatalog({
      schema_version: "1",
      channels: [EMAIL_CHANNEL],
      send_strategies: [
        { key: "waterfall", label: "Waterfall", runtime_status: "supported" },
      ],
      recipient_snapshot_modes: [
        { key: "frozen", label: "Frozen", runtime_status: "supported" },
      ],
      path_statuses: ["draft"],
    });
    expect(result.ok).toBe(true);
  });

  it("fails closed for malformed or duplicate catalog identities", () => {
    expect(normalizeOmniCatalog({ schema_version: "1" }).ok).toBe(false);
    expect(
      normalizeOmniCatalog({
        schema_version: "1",
        channels: [EMAIL_CHANNEL, EMAIL_CHANNEL],
        send_strategies: [],
        recipient_snapshot_modes: [],
        path_statuses: [],
      }).ok,
    ).toBe(false);
  });

  it("uses campaign ids as identity while allowing duplicate display names", () => {
    const first = { id: "campaign-1", name: "Launch", paths: [] };
    const second = { id: "campaign-2", name: "Launch", paths: [] };
    expect(normalizeOmniCampaignList([first, second]).ok).toBe(true);
    expect(normalizeOmniCampaignList([first, { ...first }]).ok).toBe(false);
  });

  it("rejects duplicate or malformed path identities", () => {
    const campaign = {
      id: "campaign-1",
      name: "Launch",
      status: "draft",
      paths: [
        { id: "path-1", path_key: "email", name: "Email", channel: "email" },
      ],
    };
    expect(normalizeOmniCampaign(campaign).ok).toBe(true);
    expect(
      normalizeOmniCampaign({
        ...campaign,
        paths: [
          ...campaign.paths,
          { id: "path-2", path_key: "email", name: "Again", channel: "sms" },
        ],
      }).ok,
    ).toBe(false);
    expect(
      normalizeOmniCampaign({ ...campaign, paths: "not-an-array" }).ok,
    ).toBe(false);
  });
});
