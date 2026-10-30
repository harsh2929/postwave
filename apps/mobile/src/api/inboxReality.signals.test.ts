import { beforeEach, describe, expect, it, vi } from "vitest";

import { predictInboxPlacement } from "./inboxReality";

const mocks = vi.hoisted(() => ({ rawRequest: vi.fn() }));

vi.mock("./request", () => ({ rawRequest: mocks.rawRequest }));

const PREDICTION = {
  predicted: { primary: 0.72, promotions: 0.22, spam: 0.06 },
};

function pathsCalled(): string[] {
  return mocks.rawRequest.mock.calls.map((call) => String(call[1]));
}

describe("inbox-reality signal loading", () => {
  beforeEach(() => {
    mocks.rawRequest.mockReset();
    mocks.rawRequest.mockResolvedValue({ data: PREDICTION, error: null });
  });

  it("does not go to the network for signals a caller has already resolved", async () => {
    // The banner re-predicts on every debounced content change. Without this
    // flag each one re-fetched /api/v1/dashboard/stats — a payload the app
    // already holds in the query cache — plus /api/v1/reputation.
    await predictInboxPlacement({
      subject: "Launch",
      bodyHtml: "<p>Hi</p>",
      signalsResolved: true,
    });

    expect(pathsCalled()).toEqual(["/api/v1/predict"]);
  });

  it("treats 'resolved to nothing' as resolved", async () => {
    // A workspace with no send history has none. Re-asking cannot produce one,
    // and the old `reputation && history` guard would have re-fetched forever.
    await predictInboxPlacement({
      subject: "Launch",
      bodyHtml: "<p>Hi</p>",
      reputation: { domain: "example.com" },
      signalsResolved: true,
    });

    expect(pathsCalled()).toEqual(["/api/v1/predict"]);
  });

  it("still loads signals for a caller that cannot supply them", async () => {
    mocks.rawRequest.mockImplementation(async (_method, path: string) => {
      if (path === "/api/v1/reputation") {
        return { data: { domain: "example.com" }, error: null };
      }
      if (path.startsWith("/api/v1/dashboard/stats")) {
        return {
          data: { emails_sent_30d: 1000, opens_total_30d: 250 },
          error: null,
        };
      }
      return { data: PREDICTION, error: null };
    });

    await predictInboxPlacement({ subject: "Launch", bodyHtml: "<p>Hi</p>" });

    expect(pathsCalled()).toContain("/api/v1/reputation");
    expect(pathsCalled()).toContain("/api/v1/dashboard/stats");

    const predictCall = mocks.rawRequest.mock.calls.find(
      (call) => call[1] === "/api/v1/predict",
    );
    expect(predictCall?.[2]).toMatchObject({
      reputation: { domain: "example.com" },
      history: { OpenRate: 0.25, SendVolume: 1000 },
    });
  });
});
