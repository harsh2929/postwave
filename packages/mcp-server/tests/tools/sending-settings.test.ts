// SPDX-License-Identifier: MIT
import { describe, expect, it, vi } from "vitest";
import {
  NetworkError,
  ParseError,
  PostwaveError,
  ServerError,
} from "@postwave/sdk";

import { sendingSettingsTools } from "../../src/tools/sending-settings.js";

function withOutcome<T extends Error>(
  error: T,
  sendingCapOutcome:
    | "not-committed"
    | "committed"
    | "committed-conservatively-fenced"
    | "commit-outcome-unknown-conservatively-fenced",
): T & {
  responseMetadata: { sendingCapOutcome: typeof sendingCapOutcome };
} {
  return Object.assign(error, { responseMetadata: { sendingCapOutcome } });
}

function makeClient() {
  const sendingSettings = {
    get: vi.fn().mockResolvedValue({
      tenant_id: "11111111-1111-4111-8111-111111111111",
      max_sends_per_hour: 5000,
      quiet_hours_per_recipient: true,
      updated_at: "2026-08-30T08:00:00Z",
    }),
    set: vi.fn().mockResolvedValue({
      tenant_id: "11111111-1111-4111-8111-111111111111",
      max_sends_per_hour: null,
      quiet_hours_per_recipient: true,
      updated_at: "2026-08-30T08:01:00Z",
    }),
    status: vi.fn().mockResolvedValue({
      tenant_id: "11111111-1111-4111-8111-111111111111",
      max_sends_per_hour: null,
      quiet_hours_per_recipient: true,
      counter_authoritative: false,
      counter_source: "unavailable",
      counter_scope: "unavailable",
      cap_coordination_state: "ready",
      cap_coordination_ready: true,
      cap_coordination_matches_settings: true,
    }),
  };
  return { client: { sendingSettings }, sendingSettings };
}

describe("sendingSettingsTools", () => {
  it("describes a null cap without promising unlimited delivery", () => {
    const { client } = makeClient();
    const get = sendingSettingsTools(client as any).find(
      (tool) => tool.name === "sending_settings_get",
    )!;

    expect(get.description).toContain("no workspace-specific hourly ceiling");
    expect(get.description).toContain(
      "provider, quota, and safety controls still apply",
    );
    expect(get.description.toLowerCase()).not.toContain("unlimited");
  });

  it("keeps the default settings read backward compatible", async () => {
    const c = makeClient();
    const get = sendingSettingsTools(c.client as any).find(
      (tool) => tool.name === "sending_settings_get",
    )!;

    await expect(get.handler({})).resolves.toMatchObject({
      tenant_id: "11111111-1111-4111-8111-111111111111",
      max_sends_per_hour: 5000,
    });
    expect(c.sendingSettings.get).toHaveBeenCalledTimes(1);
    expect(c.sendingSettings.status).not.toHaveBeenCalled();
    expect(c.sendingSettings.set).not.toHaveBeenCalled();
  });

  it("requires the complete replacement and exact loaded revision", () => {
    const { client } = makeClient();
    const set = sendingSettingsTools(client as any).find(
      (tool) => tool.name === "sending_settings_set",
    )!;

    expect(set.schema.safeParse({ max_sends_per_hour: null }).success).toBe(
      false,
    );
    expect(
      set.schema.safeParse({
        max_sends_per_hour: null,
        quiet_hours_start: "",
        quiet_hours_end: "",
        quiet_hours_tz: "",
        quiet_hours_per_recipient: true,
        expected_updated_at: "2026-08-30T08:00:00Z",
      }).success,
    ).toBe(true);
    expect(
      set.schema.safeParse({
        max_sends_per_hour: null,
        quiet_hours_start: "22:00",
        quiet_hours_end: "07:00",
        quiet_hours_tz: "Mars/Olympus_Mons",
        quiet_hours_per_recipient: true,
        expected_updated_at: "2026-08-30T08:00:00Z",
      }).success,
    ).toBe(false);
    expect(
      set.schema.safeParse({
        max_sends_per_hour: null,
        quiet_hours_start: "22:00",
        quiet_hours_end: "",
        quiet_hours_tz: "",
        quiet_hours_per_recipient: true,
        expected_updated_at: "2026-08-30T08:00:00Z",
      }).success,
    ).toBe(false);
    expect(
      set.schema.safeParse({
        max_sends_per_hour: null,
        quiet_hours_start: "07:00",
        quiet_hours_end: "07:00",
        quiet_hours_tz: "UTC",
        quiet_hours_per_recipient: true,
        expected_updated_at: "2026-08-30T08:00:00Z",
      }).success,
    ).toBe(false);
    expect(
      set.schema.safeParse({
        max_sends_per_hour: null,
        quiet_hours_start: "",
        quiet_hours_end: "",
        quiet_hours_tz: "",
        quiet_hours_per_recipient: true,
        expected_updated_at: "2026-08-30T08:00:00Z",
        fallback_hour_utc: null,
      }).success,
    ).toBe(false);
    expect(set.description).toContain("exactly one wire attempt");
    expect(set.description).toContain("no fallback route");
    expect(set.description).toContain("do not repeat this tool");
    expect(set.description).toContain("wait at least 35 seconds");
    expect(set.annotations?.idempotentHint).toBe(false);
    expect(set.requiredScopes).toEqual(["admin"]);
  });

  it("exposes the qualified status read needed for reconciliation", async () => {
    const c = makeClient();
    const get = sendingSettingsTools(c.client as any).find(
      (tool) => tool.name === "sending_settings_get",
    )!;

    await expect(
      get.handler({ include_coordination_status: true }),
    ).resolves.toMatchObject({
      settings: { max_sends_per_hour: 5000 },
      cap_coordination_status: {
        cap_coordination_ready: true,
        cap_coordination_matches_settings: true,
      },
    });
    expect(c.sendingSettings.get).toHaveBeenCalledTimes(1);
    expect(c.sendingSettings.status).toHaveBeenCalledTimes(1);
    expect(c.sendingSettings.set).not.toHaveBeenCalled();
    expect(get.annotations?.readOnlyHint).toBe(true);
    expect(get.requiredScopes).toEqual(["admin"]);
  });

  it("forwards the exact compare-and-set payload unchanged", async () => {
    const c = makeClient();
    const set = sendingSettingsTools(c.client as any).find(
      (tool) => tool.name === "sending_settings_set",
    )!;
    const input = {
      max_sends_per_hour: 2500,
      quiet_hours_start: "22:00",
      quiet_hours_end: "07:00",
      quiet_hours_tz: "America/New_York",
      quiet_hours_per_recipient: true,
      expected_updated_at: "2026-08-30T08:00:00Z",
    };

    await set.handler(input);

    expect(c.sendingSettings.set).toHaveBeenCalledWith(input);
    expect(c.sendingSettings.set).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      "503",
      withOutcome(
        new ServerError({
          status: 503,
          code: "sending_cap_convergence_pending",
          message: "settings committed; cap convergence remains fenced",
        }),
        "committed-conservatively-fenced",
      ),
    ],
    [
      "transport failure",
      new NetworkError({ message: "socket closed after upload" }),
    ],
    [
      "headerless HTTP 500",
      new ServerError({
        status: 500,
        code: "internal_error",
        message: "upstream response lost",
      }),
    ],
    [
      "headerless HTTP 502",
      new ServerError({
        status: 502,
        code: "http_502",
        message: "bad gateway",
      }),
    ],
    [
      "headerless HTTP 504",
      new ServerError({
        status: 504,
        code: "http_504",
        message: "gateway timeout",
      }),
    ],
    [
      "malformed HTTP 200",
      withOutcome(new ParseError({ status: 200 }), "committed"),
    ],
    ["unproven HTTP 200", new ParseError({ status: 200 })],
    [
      "headerless HTTP 409",
      new PostwaveError("proxy conflict", {
        status: 409,
        code: "http_409",
      }),
    ],
    [
      "empty HTTP 204",
      withOutcome(new ParseError({ status: 204 }), "committed"),
    ],
    [
      "contradictory not-committed HTTP 202",
      withOutcome(new ParseError({ status: 202 }), "not-committed"),
    ],
  ])(
    "fails with explicit reconciliation instructions after an ambiguous %s",
    async (_label, failure) => {
      const c = makeClient();
      c.sendingSettings.set.mockRejectedValueOnce(failure);
      const set = sendingSettingsTools(c.client as any).find(
        (tool) => tool.name === "sending_settings_set",
      )!;
      const payload = {
        max_sends_per_hour: 2_500,
        quiet_hours_start: "22:00",
        quiet_hours_end: "07:00",
        quiet_hours_tz: "America/New_York",
        quiet_hours_per_recipient: true,
        expected_updated_at: "2026-08-30T08:00:00Z",
      };

      await expect(set.handler(payload)).rejects.toThrow(
        /one wire attempt was made and was not retried/,
      );
      expect(c.sendingSettings.set).toHaveBeenCalledTimes(1);
    },
  );

  it("reports an explicit not-committed outcome without labeling it success", async () => {
    const c = makeClient();
    c.sendingSettings.set.mockRejectedValueOnce(
      withOutcome(
        new ServerError({
          status: 503,
          code: "sending_cap_coordination_unavailable",
          message: "settings were not changed",
        }),
        "not-committed",
      ),
    );
    const set = sendingSettingsTools(c.client as any).find(
      (tool) => tool.name === "sending_settings_set",
    )!;

    await expect(
      set.handler({
        max_sends_per_hour: null,
        quiet_hours_start: "",
        quiet_hours_end: "",
        quiet_hours_tz: "",
        quiet_hours_per_recipient: true,
        expected_updated_at: "2026-08-30T08:00:00Z",
      }),
    ).rejects.toThrow(/server confirmed not-committed/);
    expect(c.sendingSettings.set).toHaveBeenCalledTimes(1);
  });
});
