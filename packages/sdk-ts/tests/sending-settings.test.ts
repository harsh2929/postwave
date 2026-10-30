import { describe, expect, it, vi } from "vitest";

import {
  NetworkError,
  ParseError,
  PostwaveClient,
  SENDING_SETTINGS_RECONCILIATION_WAIT_MS,
} from "../src/index.js";

const apiKey = `pw_${"a".repeat(20)}`;
const input = {
  max_sends_per_hour: 2_500,
  quiet_hours_start: "22:00",
  quiet_hours_end: "07:00",
  quiet_hours_tz: "America/New_York",
  quiet_hours_per_recipient: true,
  fallback_hour_utc: null,
  expected_updated_at: "2026-08-30T08:00:00Z",
};
const committedSettings = {
  tenant_id: "11111111-1111-4111-8111-111111111111",
  max_sends_per_hour: 2_500,
  quiet_hours_start: "22:00",
  quiet_hours_end: "07:00",
  quiet_hours_tz: "America/New_York",
  quiet_hours_per_recipient: true,
  fallback_hour_utc: null,
  updated_at: "2026-08-30T08:01:00Z",
};

function json(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "retry-after": "0",
      ...headers,
    },
  });
}

describe("SendingSettingsResource write reconciliation boundary", () => {
  it("publishes the causal-quiescence wait required before absence reconciliation", () => {
    expect(SENDING_SETTINGS_RECONCILIATION_WAIT_MS).toBe(35_000);
  });

  it("turns a one-attempt transport failure into explicit reconciliation", async () => {
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.redirect).toBe("error");
      throw new TypeError("socket closed after upload");
    });
    const client = new PostwaveClient({
      apiKey,
      baseUrl: "https://api.test",
      retries: 10,
      fetch: fetch as unknown as typeof globalThis.fetch,
    });

    await expect(client.sendingSettings.set(input)).rejects.toMatchObject({
      status: 0,
      code: "invalid_json",
      message: expect.stringMatching(/reconcile canonical settings/),
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]?.[0]).toBe(
      "https://api.test/api/v1/settings/sending",
    );
  });

  it("makes exactly one wire attempt for an outcome-bearing 503", async () => {
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) =>
      json(
        {
          error: {
            code: "sending_cap_convergence_pending",
            message: "settings committed; cap convergence remains fenced",
          },
        },
        503,
        {
          "x-postwave-sending-cap-outcome": "committed-conservatively-fenced",
        },
      ),
    );
    const client = new PostwaveClient({
      apiKey,
      baseUrl: "https://api.test",
      retries: 10,
      defaultHeaders: { "Idempotency-Key": "must-be-stripped" },
      fetch,
    });

    await expect(client.sendingSettings.set(input)).rejects.toMatchObject({
      status: 503,
      code: "invalid_json",
      responseMetadata: {
        sendingCapOutcome: "committed-conservatively-fenced",
      },
      payload: {
        error: {
          code: "sending_cap_convergence_pending",
          message: "settings committed; cap convergence remains fenced",
        },
      },
      message: expect.stringMatching(/reconcile canonical settings/),
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["missing", {}],
    ["malformed", { "x-postwave-sending-cap-outcome": "probably-not" }],
    [
      "contradictory committed",
      { "x-postwave-sending-cap-outcome": "committed" },
    ],
    [
      "contradictory fenced",
      { "x-postwave-sending-cap-outcome": "committed-conservatively-fenced" },
    ],
    [
      "contradictory unknown",
      {
        "x-postwave-sending-cap-outcome":
          "commit-outcome-unknown-conservatively-fenced",
      },
    ],
  ])(
    "holds a 409 with a %s outcome receipt for reconciliation",
    async (_label, headers) => {
      const fetch = vi.fn(async () =>
        json(
          {
            error: {
              code: "settings_conflict",
              message: "settings changed",
            },
          },
          409,
          headers,
        ),
      );
      const client = new PostwaveClient({
        apiKey,
        baseUrl: "https://api.test",
        retries: 10,
        fetch,
      });

      await expect(client.sendingSettings.set(input)).rejects.toMatchObject({
        status: 409,
        code: "invalid_json",
        message: expect.stringMatching(/reconcile canonical settings/),
      });
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );

  it("preserves an exact not-committed 409 as the original safe failure", async () => {
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) =>
      json(
        {
          error: {
            code: "settings_conflict",
            message: "settings changed",
          },
        },
        409,
        { "x-postwave-sending-cap-outcome": "not-committed" },
      ),
    );
    const client = new PostwaveClient({
      apiKey,
      baseUrl: "https://api.test",
      retries: 10,
      fetch,
    });

    await expect(client.sendingSettings.set(input)).rejects.toMatchObject({
      status: 409,
      code: "settings_conflict",
      responseMetadata: { sendingCapOutcome: "not-committed" },
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("holds a headerless redirect for explicit reconciliation", async () => {
    const fetch = vi.fn(async () =>
      json({ error: { code: "redirected", message: "proxy redirect" } }, 302),
    );
    const client = new PostwaveClient({
      apiKey,
      baseUrl: "https://api.test",
      retries: 10,
      fetch,
    });

    await expect(client.sendingSettings.set(input)).rejects.toMatchObject({
      status: 302,
      code: "invalid_json",
      message: expect.stringMatching(/reconcile canonical settings/),
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("holds even an outcome-bearing redirect for reconciliation", async () => {
    const fetch = vi.fn(async () =>
      json({ error: { code: "redirected", message: "proxy redirect" } }, 302, {
        "x-postwave-sending-cap-outcome": "not-committed",
      }),
    );
    const client = new PostwaveClient({
      apiKey,
      baseUrl: "https://api.test",
      retries: 10,
      fetch,
    });

    await expect(client.sendingSettings.set(input)).rejects.toMatchObject({
      status: 302,
      code: "invalid_json",
      responseMetadata: { sendingCapOutcome: "not-committed" },
      message: expect.stringMatching(/reconcile canonical settings/),
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("rejects a valid 200 without recognized committed outcome proof", async () => {
    const fetch = vi.fn(async () => json(committedSettings));
    const client = new PostwaveClient({
      apiKey,
      baseUrl: "https://api.test",
      retries: 10,
      fetch,
    });

    await expect(client.sendingSettings.set(input)).rejects.toMatchObject({
      status: 200,
      responseMetadata: undefined,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("accepts only a structurally valid exact 200 committed response", async () => {
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) =>
      json(committedSettings, 200, {
        "x-postwave-sending-cap-outcome": "committed",
      }),
    );
    const client = new PostwaveClient({
      apiKey,
      baseUrl: "https://api.test",
      retries: 10,
      defaultHeaders: { "Idempotency-Key": "must-be-stripped" },
      fetch,
    });

    await expect(client.sendingSettings.set(input)).resolves.toEqual(
      committedSettings,
    );
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual(input);
    expect(
      new Headers(fetch.mock.calls[0]?.[1]?.headers).has("Idempotency-Key"),
    ).toBe(false);
  });

  it("does not compare the local-development tenant slug with the response UUID", async () => {
    const fetch = vi.fn(async () =>
      json(committedSettings, 200, {
        "x-postwave-sending-cap-outcome": "committed",
      }),
    );
    const client = new PostwaveClient({
      apiKey,
      tenantId: "acme",
      baseUrl: "https://api.test",
      retries: 10,
      fetch,
    });

    await expect(client.sendingSettings.set(input)).resolves.toEqual(
      committedSettings,
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("proves omitted replacement fields against server defaults while leaving fallback preserved", async () => {
    const minimalInput = { expected_updated_at: input.expected_updated_at };
    const defaultSettings = {
      tenant_id: committedSettings.tenant_id,
      quiet_hours_per_recipient: true,
      fallback_hour_utc: 17,
      updated_at: committedSettings.updated_at,
    };
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) =>
      json(defaultSettings, 200, {
        "x-postwave-sending-cap-outcome": "committed",
      }),
    );
    const client = new PostwaveClient({
      apiKey,
      baseUrl: "https://api.test",
      retries: 10,
      fetch,
    });

    await expect(client.sendingSettings.set(minimalInput)).resolves.toEqual(
      defaultSettings,
    );
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual(
      minimalInput,
    );
  });

  it("rejects a non-default committed row when replacement fields were omitted", async () => {
    const fetch = vi.fn(async () =>
      json(committedSettings, 200, {
        "x-postwave-sending-cap-outcome": "committed",
      }),
    );
    const client = new PostwaveClient({
      apiKey,
      baseUrl: "https://api.test",
      retries: 10,
      fetch,
    });

    await expect(
      client.sendingSettings.set({
        expected_updated_at: input.expected_updated_at,
      }),
    ).rejects.toBeInstanceOf(ParseError);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      "partial quiet tuple",
      {
        quiet_hours_start: "22:00",
        quiet_hours_end: "",
        quiet_hours_tz: "",
      },
    ],
    [
      "invalid quiet time",
      {
        quiet_hours_start: "25:00",
        quiet_hours_end: "07:00",
        quiet_hours_tz: "UTC",
      },
    ],
    [
      "equal quiet endpoints",
      {
        quiet_hours_start: "07:00",
        quiet_hours_end: "07:00",
        quiet_hours_tz: "UTC",
      },
    ],
    [
      "unknown timezone",
      {
        quiet_hours_start: "22:00",
        quiet_hours_end: "07:00",
        quiet_hours_tz: "Mars/Olympus_Mons",
      },
    ],
  ])("rejects a committed row echoing a %s", async (_label, quietPolicy) => {
    const candidate = { ...committedSettings, ...quietPolicy };
    const submitted = { ...input, ...quietPolicy };
    const fetch = vi.fn(async () =>
      json(candidate, 200, {
        "x-postwave-sending-cap-outcome": "committed",
      }),
    );
    const client = new PostwaveClient({
      apiKey,
      baseUrl: "https://api.test",
      retries: 10,
      fetch,
    });

    await expect(client.sendingSettings.set(submitted)).rejects.toBeInstanceOf(
      ParseError,
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["mismatched policy", { ...committedSettings, max_sends_per_hour: 9_999 }],
    ["invalid tenant UUID", { ...committedSettings, tenant_id: "tenant-1" }],
    ["unknown top-level property", { ...committedSettings, surprise: true }],
    [
      "invalid IP projection",
      { ...committedSettings, ip_pool: { name: "", dedicated: true } },
    ],
    [
      "unknown IP projection property",
      {
        ...committedSettings,
        ip_pool: { name: "shared", dedicated: false, surprise: true },
      },
    ],
    [
      "invalid user attribution",
      { ...committedSettings, updated_by_user_id: "user-1" },
    ],
    [
      "mismatched explicit fallback",
      { ...committedSettings, fallback_hour_utc: 17 },
    ],
    [
      "zero revision",
      { ...committedSettings, updated_at: "0001-01-01T00:00:00Z" },
    ],
    [
      "fractional zero revision",
      { ...committedSettings, updated_at: "0001-01-01T00:00:00.0Z" },
    ],
    [
      "normalized invalid calendar revision",
      { ...committedSettings, updated_at: "2026-02-30T08:01:00Z" },
    ],
    [
      "offset beyond positive 14:00",
      { ...committedSettings, updated_at: "2026-08-30T08:01:00+14:01" },
    ],
    [
      "offset beyond negative 14:00",
      { ...committedSettings, updated_at: "2026-08-30T08:01:00-23:59" },
    ],
    [
      "invalid offset minutes",
      { ...committedSettings, updated_at: "2026-08-30T08:01:00+12:99" },
    ],
    [
      "unchanged baseline revision",
      { ...committedSettings, updated_at: input.expected_updated_at },
    ],
    [
      "older revision",
      { ...committedSettings, updated_at: "2026-08-30T07:59:59.999999999Z" },
    ],
    [
      "equal instant in another offset",
      { ...committedSettings, updated_at: "2026-08-30T09:00:00+01:00" },
    ],
  ])("rejects a committed 200 with a %s", async (_label, body) => {
    const fetch = vi.fn(async () =>
      json(body, 200, {
        "x-postwave-sending-cap-outcome": "committed",
      }),
    );
    const client = new PostwaveClient({
      apiKey,
      baseUrl: "https://api.test",
      retries: 10,
      fetch,
    });

    await expect(client.sendingSettings.set(input)).rejects.toBeInstanceOf(
      ParseError,
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("retains nanosecond precision when proving the committed revision advanced", async () => {
    const preciseInput = {
      ...input,
      expected_updated_at: "2026-08-30T08:00:00.000000001Z",
    };
    const preciseCommitted = {
      ...committedSettings,
      updated_at: "2026-08-30T08:00:00.000000002Z",
    };
    const fetch = vi.fn(async () =>
      json(preciseCommitted, 200, {
        "x-postwave-sending-cap-outcome": "committed",
      }),
    );
    const client = new PostwaveClient({
      apiKey,
      baseUrl: "https://api.test",
      retries: 10,
      fetch,
    });

    await expect(client.sendingSettings.set(preciseInput)).resolves.toEqual(
      preciseCommitted,
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each(["empty", "omitted"])(
    "accepts a fresh committed revision when expected_updated_at is %s",
    async (mode) => {
      const { expected_updated_at: _expected, ...legacyInput } = input;
      const firstWriteInput =
        mode === "empty" ? { ...input, expected_updated_at: "" } : legacyInput;
      const fetch = vi.fn(async () =>
        json(committedSettings, 200, {
          "x-postwave-sending-cap-outcome": "committed",
        }),
      );
      const client = new PostwaveClient({
        apiKey,
        baseUrl: "https://api.test",
        retries: 10,
        fetch,
      });

      await expect(
        client.sendingSettings.set(firstWriteInput),
      ).resolves.toEqual(committedSettings);
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );

  it("does not report HTTP 204 as a successful settings write", async () => {
    const fetch = vi.fn(
      async () =>
        new Response(null, {
          status: 204,
          headers: { "x-postwave-sending-cap-outcome": "committed" },
        }),
    );
    const client = new PostwaveClient({
      apiKey,
      baseUrl: "https://api.test",
      retries: 10,
      fetch,
    });

    await expect(client.sendingSettings.set(input)).rejects.toMatchObject({
      status: 204,
      responseMetadata: { sendingCapOutcome: "committed" },
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["empty", () => new Response(null, { status: 200 })],
    [
      "malformed",
      () =>
        new Response("{nope", {
          status: 200,
          headers: {
            "content-type": "application/json",
            "x-postwave-sending-cap-outcome": "committed",
          },
        }),
    ],
  ])("treats an %s HTTP 200 body as a parse failure", async (_label, reply) => {
    const fetch = vi.fn(async () => reply());
    const client = new PostwaveClient({
      apiKey,
      baseUrl: "https://api.test",
      retries: 10,
      fetch,
    });

    await expect(client.sendingSettings.set(input)).rejects.toBeInstanceOf(
      ParseError,
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("keeps ordinary PUT requests on the client-wide retry policy", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        json({ error: { code: "temporary", message: "try again" } }, 503),
      )
      .mockResolvedValueOnce(json({ ok: true }));
    const client = new PostwaveClient({
      apiKey,
      baseUrl: "https://api.test",
      retries: 2,
      fetch,
    });

    await expect(
      client.request("PUT", "/api/v1/ordinary-resource", { body: {} }),
    ).resolves.toEqual({ ok: true });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([0, -4, Number.NaN, Number.POSITIVE_INFINITY, 1.9])(
    "normalizes explicit maxAttempts=%s to the conservative one-attempt floor",
    async (maxAttempts) => {
      const fetch = vi.fn(async () => {
        throw new TypeError("network down");
      });
      const client = new PostwaveClient({
        apiKey,
        baseUrl: "https://api.test",
        retries: 10,
        fetch: fetch as unknown as typeof globalThis.fetch,
      });

      await expect(
        client.request("PUT", "/api/v1/ordinary-resource", {
          body: {},
          maxAttempts,
        }),
      ).rejects.toBeInstanceOf(NetworkError);
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );

  it("reads the qualified coordination status from its canonical endpoint", async () => {
    const status = {
      tenant_id: "11111111-1111-4111-8111-111111111111",
      max_sends_per_hour: 2_500,
      quiet_hours_per_recipient: true,
      counter_authoritative: false as const,
      counter_source: "unavailable" as const,
      counter_scope: "unavailable" as const,
      cap_coordination_state: "ready" as const,
      cap_coordination_ready: true,
      cap_coordination_cap: 2_500,
      cap_coordination_matches_settings: true,
    };
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) =>
      json(status),
    );
    const client = new PostwaveClient({
      apiKey,
      baseUrl: "https://api.test",
      retries: 2,
      fetch,
    });

    await expect(client.sendingSettings.status()).resolves.toEqual(status);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]?.[0]).toBe(
      "https://api.test/api/v1/settings/sending/status",
    );
  });
});
