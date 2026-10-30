// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ post: vi.fn() }));

vi.mock("@/lib/api", () => ({ api: { post: mocks.post } }));
vi.mock("@/lib/mock-mode", () => ({ isMockModeEnabled: () => false }));

import { normalizeRenderResponse, renderEmail } from "@/lib/render-api";

const render = {
  environment: {
    name: "outlook_2019_desktop",
    viewport_width: 900,
    viewport_height: 1200,
    user_agent: "Outlook 16",
    dark_mode: false,
  },
  image_url: "https://images.example.test/outlook.png",
  width: 900,
  height: 600,
  issues: ["border-radius is ignored"],
};

const response = { renders: [render], cache_hit: false };

beforeEach(() => {
  mocks.post.mockReset();
  mocks.post.mockResolvedValue(response);
});

describe("normalizeRenderResponse", () => {
  it("accepts the deliverability render contract", () => {
    expect(normalizeRenderResponse(response)).toEqual(response);
    expect(normalizeRenderResponse({ renders: [], cache_hit: true })).toEqual({
      renders: [],
      cache_hit: true,
    });
    expect(normalizeRenderResponse({ ...response, render_mode: "simulation" }))
      .toMatchObject({ render_mode: "simulation" });
  });

  it.each([
    null,
    {},
    { renders: null, cache_hit: false },
    { renders: [], cache_hit: "no" },
    { renders: [], cache_hit: false, render_mode: "real_client" },
    { renders: [null], cache_hit: false },
    { renders: [{ ...render, width: 0 }], cache_hit: false },
    {
      renders: [{ ...render, issues: [42] }],
      cache_hit: false,
    },
    {
      renders: [render, render],
      cache_hit: false,
    },
  ])(
    "rejects malformed success instead of rendering partial cards (%j)",
    (raw) => {
      expect(() => normalizeRenderResponse(raw)).toThrow(/malformed/i);
    },
  );
});

describe("renderEmail", () => {
  it("posts exact HTML online with cancellation and normalizes the receipt", async () => {
    const controller = new AbortController();
    await expect(
      renderEmail(
        "<p>Exact body</p>",
        ["outlook_2019_desktop"],
        controller.signal,
      ),
    ).resolves.toEqual(response);
    expect(mocks.post).toHaveBeenCalledWith(
      "/api/v1/render",
      {
        html: "<p>Exact body</p>",
        environments: ["outlook_2019_desktop"],
      },
      { signal: controller.signal, requireOnline: true },
    );
  });

  it("surfaces malformed API success as an error", async () => {
    mocks.post.mockResolvedValueOnce({ renders: null, cache_hit: false });
    await expect(renderEmail("<p>Broken</p>")).rejects.toThrow(/malformed/i);
  });
});
