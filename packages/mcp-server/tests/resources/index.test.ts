// SPDX-License-Identifier: MIT
import { describe, expect, it, vi } from "vitest";

import { buildResources, safeResourceId } from "../../src/resources/index.js";

describe("safeResourceId", () => {
  it("accepts compact encoded resource identifiers", () => {
    expect(safeResourceId("cmp_123")).toBe("cmp_123");
    expect(safeResourceId("cmp%5F123")).toBe("cmp_123");
  });

  it("rejects malformed, traversal-like, or oversized identifiers", () => {
    expect(safeResourceId("%E0%A4%A")).toBeNull();
    expect(safeResourceId("%2e%2e")).toBeNull();
    expect(safeResourceId("cmp%2F123")).toBeNull();
    expect(safeResourceId("cmp_123\nx")).toBeNull();
    expect(safeResourceId("x".repeat(513))).toBeNull();
  });
});

describe("buildResources", () => {
  it("reads latest Campaign Assurance through a safe campaign resource id", async () => {
    const getLatest = vi.fn().mockResolvedValue({
      measurement: { name: "Predicted Agent Comprehension" },
    });
    const { templates } = buildResources({
      campaignAssurance: { getLatest },
      events: { stream: async function* () {} },
    } as never);
    const assurance = templates.find((template) =>
      template.uriTemplate.startsWith("moosewave://campaign-assurance/"),
    );
    const match = "moosewave://campaign-assurance/cmp%5F123".match(
      assurance!.pattern,
    );

    await expect(assurance!.read(match!)).resolves.toMatchObject({
      measurement: { name: "Predicted Agent Comprehension" },
    });
    expect(getLatest).toHaveBeenCalledWith("cmp_123");
  });

  it("does not call Campaign Assurance for an unsafe resource id", async () => {
    const getLatest = vi.fn();
    const { templates } = buildResources({
      campaignAssurance: { getLatest },
      events: { stream: async function* () {} },
    } as never);
    const assurance = templates.find((template) =>
      template.uriTemplate.startsWith("moosewave://campaign-assurance/"),
    );
    const match = "moosewave://campaign-assurance/%2e%2e".match(
      assurance!.pattern,
    );

    await expect(assurance!.read(match!)).rejects.toThrow(/missing campaign_id/);
    expect(getLatest).not.toHaveBeenCalled();
  });

  it("passes safe inbox report campaign ids to the SDK", async () => {
    const getCampaignReport = vi.fn().mockResolvedValue({ ok: true });
    const { templates } = buildResources({
      inboxReality: { getCampaignReport },
      events: { stream: async function* () {} },
    } as never);
    const inbox = templates.find((t) => t.uriTemplate.startsWith("moosewave://inbox-reality/"));
    const match = "moosewave://inbox-reality/cmp%5F123".match(inbox!.pattern);

    await expect(inbox!.read(match!)).resolves.toEqual({ ok: true });
    expect(getCampaignReport).toHaveBeenCalledWith("cmp_123");
  });

  it("fails closed for unsafe inbox report ids", async () => {
    const getCampaignReport = vi.fn();
    const { templates } = buildResources({
      inboxReality: { getCampaignReport },
      events: { stream: async function* () {} },
    } as never);
    const inbox = templates.find((t) => t.uriTemplate.startsWith("moosewave://inbox-reality/"));
    const match = "moosewave://inbox-reality/%E0%A4%A".match(inbox!.pattern);

    await expect(inbox!.read(match!)).rejects.toThrow(/missing campaign_id/);
    expect(getCampaignReport).not.toHaveBeenCalled();
  });
});
