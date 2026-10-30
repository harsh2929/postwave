/**
 * The offline write queue's release-health taxonomy had no test (NATIVE#51).
 *
 * It matters more than a mapping table usually would, because this is the ONLY
 * signal that a queued mutation ever replayed: the user is by definition not
 * watching (the write was made offline), and a mis-bucketed failure is the
 * difference between "the token expired, ask them to sign in" and "the server
 * is down, retry". The three cases that are easiest to get wrong — a
 * queue-policy `code` beating a co-present HTTP `status`, 409/412 being a
 * CONFLICT rather than a generic client error, and an unrecognised failure
 * landing in `unknown` rather than being dropped — are each pinned separately.
 *
 * `./telemetry` is mocked because it reaches for expo-secure-store at import
 * time, which cannot resolve in the node vitest environment (house rule 5). The
 * mock also lets the emitted event be asserted, which is the actual contract:
 * `trackOfflineReplay` is only useful if it emits the right property bag.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// `vi.mock` is hoisted above every top-level binding, so the spy has to be
// created inside the factory and read back afterwards — referencing an outer
// `const` here throws "Cannot access 'track' before initialization".
vi.mock("./telemetry", () => ({ track: vi.fn() }));

// eslint-disable-next-line import/first
import {
  offlineReplayErrorCode,
  trackOfflineReplay,
} from "./offlineReplayTelemetry";
// eslint-disable-next-line import/first
import { track as trackImpl } from "./telemetry";

const track = vi.mocked(trackImpl);

const AUTH = {
  queuedAt: 0,
} as unknown as Parameters<typeof trackOfflineReplay>[2];

describe("offlineReplayErrorCode", () => {
  it.each([
    "missing_scope",
    "expired",
    "identity_mismatch",
    "not_queueable",
  ])("passes the queue-policy code %s through unchanged", (code) => {
    expect(offlineReplayErrorCode({ code })).toBe(code);
  });

  it("prefers the queue-policy code over a co-present HTTP status", () => {
    // A replay rejected because the queued identity no longer matches often
    // ALSO carries a 401. Reporting that as "authorization" would hide the one
    // failure mode that means the queue is holding another account's write.
    expect(offlineReplayErrorCode({ code: "identity_mismatch", status: 401 }))
      .toBe("identity_mismatch");
  });

  it.each([
    [401, "authorization"],
    [403, "authorization"],
    [409, "conflict"],
    [412, "conflict"],
    [429, "rate_limit"],
    [500, "server"],
    [503, "server"],
    [599, "server"],
  ])("maps status %i to %s", (status, expected) => {
    expect(offlineReplayErrorCode({ status })).toBe(expected);
  });

  it.each([
    ["a bare network Error", new Error("Network request failed")],
    ["null", null],
    ["undefined", undefined],
    ["a string", "boom"],
    ["an unmapped 4xx", { status: 418 }],
    ["an unrecognised code", { code: "banana" }],
    ["a non-numeric status", { status: "500" }],
  ])("buckets %s as unknown rather than dropping it", (_name, error) => {
    expect(offlineReplayErrorCode(error)).toBe("unknown");
  });
});

describe("trackOfflineReplay", () => {
  beforeEach(() => {
    track.mockClear();
  });

  it("omits error_code on success", () => {
    vi.spyOn(Date, "now").mockReturnValue(5_000);
    trackOfflineReplay("subscriber_update", "success", {
      ...AUTH,
      queuedAt: 2_000,
    } as typeof AUTH);
    expect(track).toHaveBeenCalledTimes(1);
    const props = track.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(props).toMatchObject({
      source: "subscriber_update",
      outcome: "success",
      duration_ms: 3_000,
    });
    expect(props).not.toHaveProperty("error_code");
    vi.restoreAllMocks();
  });

  it("attaches the bucketed error_code on failure", () => {
    vi.spyOn(Date, "now").mockReturnValue(1_000);
    trackOfflineReplay(
      "campaign_schedule",
      "failure",
      { ...AUTH, queuedAt: 1_000 } as typeof AUTH,
      { status: 409 },
    );
    expect(track.mock.calls[0]?.[1]).toMatchObject({
      outcome: "failure",
      error_code: "conflict",
      duration_ms: 0,
    });
    vi.restoreAllMocks();
  });

  it("never reports a negative duration when the device clock moved backwards", () => {
    // NTP correction, or a queue record written on a phone whose clock was
    // ahead. A negative duration poisons every percentile on the dashboard.
    vi.spyOn(Date, "now").mockReturnValue(1_000);
    trackOfflineReplay("subscriber_update", "success", {
      ...AUTH,
      queuedAt: 9_000_000,
    } as typeof AUTH);
    expect(track.mock.calls[0]?.[1]).toMatchObject({ duration_ms: 0 });
    vi.restoreAllMocks();
  });

  it("clamps a write that sat in the queue for a week to 24h", () => {
    vi.spyOn(Date, "now").mockReturnValue(30 * 24 * 60 * 60 * 1000);
    trackOfflineReplay("subscriber_update", "success", {
      ...AUTH,
      queuedAt: 0,
    } as typeof AUTH);
    expect(track.mock.calls[0]?.[1]).toMatchObject({
      duration_ms: 24 * 60 * 60 * 1000,
    });
    vi.restoreAllMocks();
  });
});
