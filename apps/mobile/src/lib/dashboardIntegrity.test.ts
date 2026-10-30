import { describe, expect, it, vi } from "vitest";

// useDashboard pulls in the RN-bound API client; only the pure picker below is
// exercised, so the client module is stubbed to let the import resolve.
vi.mock("@/api/client", () => ({ getClient: vi.fn() }));
vi.mock("@/hooks/useOnlineQueryGate", () => ({ useOnlineQueryGate: vi.fn() }));
// useDashboard's offline-snapshot path also reaches netinfo (via connectivity)
// and expo-secure-store, neither of which parses in the node environment.
vi.mock("@/lib/connectivity", () => ({ isProbablyOnline: () => true }));
vi.mock("@/lib/secureVault", () => ({
  vaultGetJSON: vi.fn(async () => null),
  vaultSetJSON: vi.fn(async () => undefined),
  vaultScopeForClient: vi.fn(() => "scope"),
}));

// eslint-disable-next-line import/first
import { pickOpenRate } from "@/hooks/useDashboard";
// eslint-disable-next-line import/first
import {
  ratioIsImpossible,
  unverifiableRates,
  unverifiableRatesNotice,
} from "./dashboardIntegrity";

describe("ratioIsImpossible", () => {
  it("is true only when both inputs are real and the ratio cannot be", () => {
    expect(ratioIsImpossible(120, 100)).toBe(true);
    expect(ratioIsImpossible(100, 100)).toBe(false);
    expect(ratioIsImpossible(1, 100)).toBe(false);
  });

  it("does not call an unmeasured denominator impossible", () => {
    // Zero recipients is "nothing was sent", not "the data is wrong".
    expect(ratioIsImpossible(5, 0)).toBe(false);
    expect(ratioIsImpossible(5, undefined)).toBe(false);
    expect(ratioIsImpossible(undefined, 100)).toBe(false);
    expect(ratioIsImpossible(5, Number.NaN)).toBe(false);
  });
});

describe("unverifiableRates", () => {
  const healthy = {
    unique_opens_30d: 300,
    unique_clicks_30d: 40,
    unique_bounces_30d: 5,
    unique_delivered_30d: 900,
    unique_sent_30d: 1000,
  };

  it("says nothing about a healthy payload", () => {
    expect(unverifiableRates(healthy)).toEqual([]);
    expect(unverifiableRatesNotice(healthy)).toBeNull();
    expect(unverifiableRates(undefined)).toEqual([]);
  });

  it("stays quiet when the fallback denominator still works", () => {
    // `delivered` is lagging behind opens, but `sent` is intact — the picker
    // falls back to it and produces an honest rate, so there is nothing to
    // disclose.
    const laggingDelivered = { ...healthy, unique_delivered_30d: 10 };
    expect(pickOpenRate(laggingDelivered)).toBeCloseTo(0.3, 10);
    expect(unverifiableRates(laggingDelivered)).toEqual([]);
  });

  it("names the rate the picker had to refuse", () => {
    const broken = {
      ...healthy,
      unique_opens_30d: 4000,
      unique_delivered_30d: 900,
      unique_sent_30d: 1000,
    };
    // The picker's em-dash and this notice have to agree: the whole point is
    // that a refusal stops being indistinguishable from "not reported".
    expect(pickOpenRate(broken)).toBeNull();
    expect(unverifiableRates(broken)).toEqual(["open rate"]);
    expect(unverifiableRatesNotice(broken)).toContain("open rate is shown as");
  });

  it("bounces are measured against SENT, never delivered", () => {
    // 950 bounces out of 1000 sent is high but possible; it is only impossible
    // against `delivered`, which is the wrong denominator for a bounce.
    const heavy = { ...healthy, unique_bounces_30d: 950 };
    expect(unverifiableRates(heavy)).toEqual([]);
    expect(unverifiableRates({ ...heavy, unique_bounces_30d: 1200 })).toEqual([
      "bounce rate",
    ]);
  });

  it("catches a legacy precomputed rate above 100%", () => {
    expect(unverifiableRates({ open_rate: { rate: 1.4 } })).toEqual([
      "open rate",
    ]);
    expect(unverifiableRates({ open_rate: { rate: 0.4 } })).toEqual([]);
  });

  it("lists several broken rates in one readable sentence", () => {
    const notice = unverifiableRatesNotice({
      unique_opens_30d: 5000,
      unique_clicks_30d: 5000,
      unique_bounces_30d: 5000,
      unique_delivered_30d: 900,
      unique_sent_30d: 1000,
    });
    expect(notice).toContain("open rate, click rate and bounce rate are shown");
  });
});
