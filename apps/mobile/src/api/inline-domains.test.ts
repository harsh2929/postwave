import { beforeEach, describe, expect, it, vi } from "vitest";

import { predictInboxPlacement } from "./inboxReality";
import { getSegmentBestSendTime } from "./sendTime";

const mocks = vi.hoisted(() => ({
  rawRequest: vi.fn(),
}));

vi.mock("./request", () => ({
  rawRequest: mocks.rawRequest,
}));

describe("mobile inline domain API helpers", () => {
  beforeEach(() => {
    mocks.rawRequest.mockReset();
  });

  it("encodes send-time segment and campaign filters", async () => {
    const recommendation = {
      best_hour_utc: "14:00",
      computed_at: "2026-07-10T00:00:00Z",
      confidence: 0.82,
    };
    mocks.rawRequest.mockResolvedValueOnce({
      data: recommendation,
      error: null,
    });

    await expect(
      getSegmentBestSendTime({
        segmentId: "seg space",
        campaignId: "cmp/123",
      }),
    ).resolves.toEqual({ data: recommendation, error: null });
    expect(mocks.rawRequest).toHaveBeenCalledWith(
      "GET",
      "/api/v1/send-time-opt?segment_id=seg+space&campaign_id=cmp%2F123",
    );
  });

  it("posts normalized inbox prediction input", async () => {
    const prediction = {
      predicted: { primary: 0.7, promotions: 0.25, spam: 0.05 },
      risk: { level: "low" },
    };
    mocks.rawRequest.mockResolvedValueOnce({
      data: prediction,
      error: null,
    });

    await expect(
      predictInboxPlacement({
        subject: "Launch",
        bodyHtml: "<p>Hello</p>",
        reputation: { domain: "example.com", sender_score: 91 },
        history: { OpenRate: 0.3, SendVolume: 1200 },
      }),
    ).resolves.toEqual({ data: prediction, error: null });
    expect(mocks.rawRequest).toHaveBeenCalledWith(
      "POST",
      "/api/v1/predict",
      expect.objectContaining({
        html: "<p>Hello</p>",
        subject: "Launch",
        reputation: expect.objectContaining({
          domain: "example.com",
          sender_score: 91,
        }),
        history: expect.objectContaining({
          OpenRate: 0.3,
          SendVolume: 1200,
        }),
      }),
    );
  });

  it("fails closed when the predictor omits placement data", async () => {
    mocks.rawRequest
      .mockResolvedValueOnce({ data: null, error: { status: 503 } })
      .mockResolvedValueOnce({ data: null, error: { status: 503 } })
      .mockResolvedValueOnce({
        data: { risk: { level: "unknown" } },
        error: null,
      });

    await expect(
      predictInboxPlacement({ subject: "Launch", bodyHtml: "<p>Hello</p>" }),
    ).resolves.toEqual({
      data: null,
      error: { status: 0, message: "predictor returned no placement" },
    });
    expect(mocks.rawRequest).toHaveBeenLastCalledWith(
      "POST",
      "/api/v1/predict",
      {
        html: "<p>Hello</p>",
        subject: "Launch",
        links: [],
      },
    );
  });

  it("loads authoritative reputation and dashboard history when omitted", async () => {
    const prediction = {
      predicted: { primary: 0.6, promotions: 0.3, spam: 0.1 },
    };
    mocks.rawRequest
      .mockResolvedValueOnce({
        data: {
          domain: "sender.example",
          google_score: "low",
          sender_score: 41,
          blacklist_hits: ["example-rbl"],
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          opens_total_30d: 200,
          clicks_total_30d: 50,
          bounces_total_30d: 10,
          emails_sent_30d: 1000,
        },
        error: null,
      })
      .mockResolvedValueOnce({ data: prediction, error: null });

    await expect(
      predictInboxPlacement({ subject: "Launch", bodyHtml: "<p>Hello</p>" }),
    ).resolves.toEqual({ data: prediction, error: null });

    expect(mocks.rawRequest).toHaveBeenLastCalledWith(
      "POST",
      "/api/v1/predict",
      expect.objectContaining({
        reputation: expect.objectContaining({
          domain: "sender.example",
          sender_score: 41,
        }),
        history: {
          OpenRate: 0.2,
          ClickRate: 0.05,
          BounceRate: 0.01,
          SendVolume: 1000,
        },
      }),
    );
  });
});
