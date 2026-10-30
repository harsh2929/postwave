import { describe, expect, it, vi } from "vitest";

// useAnalytics.ts imports @/api/client (RN-bound); the test exercises only the
// pure path builders, so stub the RN-bound modules so the import resolves.
vi.mock("@/api/client", () => ({ getClient: vi.fn() }));
vi.mock("@/hooks/useOnlineQueryGate", () => ({ useOnlineQueryGate: vi.fn() }));

// eslint-disable-next-line import/first
import {
  daysForRange,
  fatiguePath,
  rangeLabelFor,
  subscriberTimeseriesPath,
  templateLeaderboardPath,
} from "./useAnalytics";

describe("analytics request paths", () => {
  it("maps each reporting window onto the server's day budget", () => {
    // The fatigue and leaderboard endpoints take ?days= (1..365); the
    // subscriber timeseries takes the ?range= enum. Mixing them up silently
    // charts a different window than the picker claims.
    expect(daysForRange("7d")).toBe(7);
    expect(daysForRange("30d")).toBe(30);
    expect(daysForRange("90d")).toBe(90);
  });

  it("builds the verified analytics routes", () => {
    expect(subscriberTimeseriesPath("90d")).toBe(
      "/api/v1/analytics/subscribers/timeseries?range=90d",
    );
    expect(templateLeaderboardPath(30)).toBe(
      "/api/v1/analytics/template-leaderboard?days=30",
    );
    expect(fatiguePath(7)).toBe("/api/v1/analytics/fatigue?days=7");
  });

  it("spells the window out for chart captions and screen readers", () => {
    expect(rangeLabelFor("7d")).toBe("Last 7 days");
    expect(rangeLabelFor("90d")).toBe("Last 90 days");
  });
});
