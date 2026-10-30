/** Transport seam for the signup firewall's admin surface. */
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  getFirewallEvents,
  getFirewallStats,
  putFirewallSettings,
  runFirewallDetect,
} from "./firewallAdmin";
import { PlatformConfigError } from "./platformConfig";

const { rawRequest } = vi.hoisted(() => ({ rawRequest: vi.fn() }));
vi.mock("./request", () => ({ rawRequest }));

beforeEach(() => rawRequest.mockReset());

describe("putFirewallSettings", () => {
  it("PUTs only the fields it was given and normalizes the stored row", async () => {
    rawRequest.mockResolvedValue({
      data: {
        tenant_id: "t",
        attack_mode_enabled: true,
        auto_attack_mode: true,
        fingerprint_required: false,
        attack_mode_threshold: 70,
        surge_multiplier: 5,
        surge_min_per_hour: 50,
        attack_mode_auto_enabled_at: null,
      },
      error: null,
    });
    const res = await putFirewallSettings({ attack_mode_threshold: 70 });
    expect(rawRequest).toHaveBeenCalledWith(
      "PUT",
      "/api/v1/firewall/settings",
      { attack_mode_threshold: 70 },
    );
    expect(res).toEqual({
      attackModeEnabled: true,
      autoAttackMode: true,
      fingerprintRequired: false,
      attackModeThreshold: 70,
      surgeMultiplier: 5,
      surgeMinPerHour: 50,
      autoEnabledAt: null,
    });
  });

  it("throws a status-typed error carrying the server's validation sentence", async () => {
    rawRequest.mockResolvedValue({
      data: null,
      error: {
        status: 422,
        code: "validation_failed",
        message: "attack_mode_threshold must be 0..100",
      },
    });
    const failure = await putFirewallSettings({ attack_mode_threshold: 101 }).catch(
      (e) => e,
    );
    expect(failure).toBeInstanceOf(PlatformConfigError);
    expect(failure.status).toBe(422);
    expect(failure.message).toBe("attack_mode_threshold must be 0..100");
  });
});

describe("getFirewallEvents", () => {
  it("GETs with the limit on the query string and reads {events}", async () => {
    rawRequest.mockResolvedValue({
      data: {
        events: [
          { id: "e1", action: "rejected", risk_score: 72, ip: "203.0.113.4", form_id: "f1", at: "2026-09-01T10:00:00Z" },
        ],
        count: 1,
      },
      error: null,
    });
    const res = await getFirewallEvents(20);
    expect(rawRequest).toHaveBeenCalledWith(
      "GET",
      "/api/v1/firewall/events?limit=20",
    );
    expect(res).toEqual([
      { id: "e1", action: "rejected", riskScore: 72, ip: "203.0.113.4", formId: "f1", at: "2026-09-01T10:00:00Z" },
    ]);
  });

  it("defaults the limit to 20 and answers [] for a non-list body", async () => {
    rawRequest.mockResolvedValue({ data: "<!DOCTYPE html>", error: null });
    expect(await getFirewallEvents()).toEqual([]);
    expect(rawRequest).toHaveBeenCalledWith(
      "GET",
      "/api/v1/firewall/events?limit=20",
    );
  });

  it("throws a status-typed error on 403", async () => {
    rawRequest.mockResolvedValue({
      data: null,
      error: { status: 403, message: "" },
    });
    await expect(getFirewallEvents()).rejects.toMatchObject({
      status: 403,
      message: "Couldn't load firewall events.",
    });
  });
});

describe("getFirewallStats", () => {
  it("GETs the stats route and reads both windows", async () => {
    rawRequest.mockResolvedValue({
      data: {
        last_24h: { accepted: 10, rejected: 3, observed: 1 },
        last_7d: { accepted: 90, rejected: 20, observed: 4 },
      },
      error: null,
    });
    expect(await getFirewallStats()).toEqual({
      last24h: { accepted: 10, rejected: 3, observed: 1 },
      last7d: { accepted: 90, rejected: 20, observed: 4 },
    });
    expect(rawRequest).toHaveBeenCalledWith("GET", "/api/v1/firewall/stats");
  });
});

describe("runFirewallDetect", () => {
  it("POSTs an empty object and reports {flipped} verbatim", async () => {
    rawRequest.mockResolvedValue({ data: { flipped: true }, error: null });
    expect(await runFirewallDetect()).toEqual({ flipped: true });
    expect(rawRequest).toHaveBeenCalledWith("POST", "/api/v1/firewall/detect", {});
    rawRequest.mockResolvedValue({ data: { flipped: false }, error: null });
    expect(await runFirewallDetect()).toEqual({ flipped: false });
  });

  it("never reads a malformed answer as a flip", async () => {
    rawRequest.mockResolvedValue({ data: { flipped: "true" }, error: null });
    expect(await runFirewallDetect()).toEqual({ flipped: false });
  });

  it("throws a status-typed error on failure", async () => {
    rawRequest.mockResolvedValue({
      data: null,
      error: { status: 500, message: "" },
    });
    await expect(runFirewallDetect()).rejects.toMatchObject({
      status: 500,
      message: "Couldn't run the surge check.",
    });
  });
});
