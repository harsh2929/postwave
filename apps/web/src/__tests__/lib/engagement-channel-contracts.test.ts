// SPDX-License-Identifier: AGPL-3.0-only
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ get: vi.fn() }));

vi.mock("@/lib/api", () => ({ api: mocks }));

const { listUtmTemplates } = await import("@/lib/scoring-taxonomy-api");

beforeEach(() => {
  mocks.get.mockReset();
});

describe("engagement channel wire contracts", () => {
  it("preserves all five UTM dimensions from a template", async () => {
    mocks.get.mockResolvedValue({
      templates: [
        {
          id: "utm-1",
          campaign_id: "campaign-1",
          is_default: true,
          utm_source: "newsletter",
          utm_medium: "email",
          utm_campaign: "launch",
          utm_term: "founders",
          utm_content: "hero-cta",
          enabled: true,
        },
      ],
    });

    await expect(listUtmTemplates()).resolves.toEqual([
      expect.objectContaining({
        utm_source: "newsletter",
        utm_medium: "email",
        utm_campaign: "launch",
        utm_term: "founders",
        utm_content: "hero-cta",
      }),
    ]);
    expect(mocks.get).toHaveBeenCalledWith("/api/v1/utm-templates");
  });
});
