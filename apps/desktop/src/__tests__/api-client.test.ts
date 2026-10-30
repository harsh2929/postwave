// Tests for the desktop api-client request shape. The full client
// drags in `window` access (localStorage), so we exercise it via the
// `requestWithConfig` path through the public `validateApiConnection`
// surface. We mock `globalThis.fetch` and assert:
//
//   - 4xx returns { error } with the body's error.message extracted
//   - 5xx returns { error } with the status preserved
//   - network failure surfaces a clean { error } envelope (no throw)
//
// Why not test retries? The desktop client deliberately doesn't retry
// HTTP calls — every method returns a discriminated `{ data | error }`
// so the UI can show a friendly fallback. The tests here pin that
// behavior so a future "auto-retry" change is intentional, not
// accidental.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DENIAL_REASONS,
  denialRetryable,
  type DenialReason,
} from "@postwave/errors";

// Stub a minimal `window` so `validateApiConnection` (which reads
// localStorage via getApiUrl/getApiKey) doesn't crash under node env.
const stubLocalStorage: Storage = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
  clear: () => {},
  key: () => null,
  length: 0,
};

beforeEach(() => {
  // @ts-expect-error — installing a tiny stub on globalThis
  globalThis.window = {
    localStorage: stubLocalStorage,
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
  };
});

afterEach(() => {
  resetApiIdentityTransitionForTests();
  // @ts-expect-error — clean up
  delete globalThis.window;
  vi.restoreAllMocks();
});

import {
  api,
  apiAuth,
  apiRequest,
  audienceSyncsApi,
  blocklistAutoSuppressApi,
  buildStreamUrl,
  clearApiConfig,
  commerceApi,
  controlGroupsApi,
  conversionsApi,
  crmIntegrationsApi,
  diagnosticianApi,
  emailBlocksApi,
  featureFlagsApi,
  frequencyCapsApi,
  getApiUrl,
  getApiKey,
  getRememberedSession,
  holdoutApi,
  hydrateSecureApiConfig,
  invalidateApiUrlCache,
  isSequenceParticipantsUnavailable,
  intelligentRetryApi,
  linkCheckerApi,
  listsExtendedApi,
  NATIVE_CLIENT_HEADERS,
  omnichannelApi,
  regionsApi,
  rememberSession,
  reviewIntegrationsApi,
  safeOAuthRedirectTo,
  safeSlackOAuthStartUrl,
  searchApi,
  sendWindowApi,
  sendingSettingsApi,
  setApiConfig,
  subscriptionIntegrationsApi,
  subscriberNotesApi,
  suppressionsApi,
  suppressionsConvergedApi,
  translationsApi,
  updateSequenceEmails,
  utmTemplatesApi,
  validateApiConnection,
  warehouseApi,
  zeroCopyTriggersApi,
} from "../lib/api-client";
import {
  beginApiIdentityTransition,
  releaseApiIdentityTransition,
  resetApiIdentityTransitionForTests,
} from "../lib/api-identity-transition";
import { sunsetApi } from "../lib/api/sunset";

describe("sending-settings one-attempt transport", () => {
  const input = {
    max_sends_per_hour: 5000,
    quiet_hours_start: "22:00",
    quiet_hours_end: "06:00",
    quiet_hours_tz: "UTC",
    quiet_hours_per_recipient: true,
    expected_updated_at: "2026-08-31T11:00:00Z",
  };

  it("never sends the forbidden Idempotency-Key on save or clear", async () => {
    const calls: Array<{ body: string | null; idempotencyKey: string | null }> =
      [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({
          body: typeof init?.body === "string" ? init.body : null,
          idempotencyKey: new Headers(init?.headers).get("Idempotency-Key"),
        });
        return new Response(
          JSON.stringify({
            tenant_id: "tenant-1",
            max_sends_per_hour: null,
            quiet_hours_start: "",
            quiet_hours_end: "",
            quiet_hours_tz: "",
            quiet_hours_per_recipient: true,
            updated_at:
              calls.length === 1
                ? "2026-08-31T12:00:00Z"
                : "2026-08-31T12:00:01Z",
          }),
          {
            status: 200,
            headers: {
              "Content-Type": "application/json",
              "X-Postwave-Sending-Cap-Outcome": "committed",
            },
          },
        );
      }),
    );

    await sendingSettingsApi.put({
      max_sends_per_hour: 5000,
      quiet_hours_start: "22:00",
      quiet_hours_end: "06:00",
      quiet_hours_tz: "UTC",
      quiet_hours_per_recipient: false,
      expected_updated_at: "2026-08-31T11:00:00Z",
    });
    await sendingSettingsApi.clear("2026-08-31T12:00:00Z");

    expect(calls).toHaveLength(2);
    expect(calls.every((call) => call.idempotencyKey === null)).toBe(true);
    expect(JSON.parse(calls[1]?.body ?? "{}")).toEqual({
      max_sends_per_hour: null,
      quiet_hours_start: "",
      quiet_hours_end: "",
      quiet_hours_tz: "",
      quiet_hours_per_recipient: true,
      expected_updated_at: "2026-08-31T12:00:00Z",
    });
  });

  it("does not replay an ambiguous server failure", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: { code: "commit_unknown" } }), {
          status: 503,
          headers: {
            "Content-Type": "application/json",
            "X-Postwave-Sending-Cap-Outcome":
              "commit-outcome-unknown-conservatively-fenced",
          },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await sendingSettingsApi.put({
      max_sends_per_hour: 5000,
      quiet_hours_start: "22:00",
      quiet_hours_end: "06:00",
      quiet_hours_tz: "UTC",
      quiet_hours_per_recipient: true,
      expected_updated_at: "2026-08-31T11:00:00Z",
    });

    expect(result.error?.status).toBe(503);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["missing", undefined],
    ["malformed", "probably-not-committed"],
  ])(
    "holds a 409 with a %s outcome receipt for reconciliation",
    async (_label, outcome) => {
      const fetchMock = vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error: { code: "settings_conflict", message: "changed" },
            }),
            {
              status: 409,
              headers: {
                "Content-Type": "application/json",
                ...(outcome
                  ? { "X-Postwave-Sending-Cap-Outcome": outcome }
                  : {}),
              },
            },
          ),
      );
      vi.stubGlobal("fetch", fetchMock);

      const result = await sendingSettingsApi.put(input);

      expect(result.error).toMatchObject({
        kind: "parse",
        status: 409,
        code: "sending_settings_mutation_unproven",
      });
      expect(result.error?.message).toMatch(/authoritative settings/);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  it("preserves an exact not-committed 409 as the original safe failure", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            error: { code: "settings_conflict", message: "changed" },
          }),
          {
            status: 409,
            headers: {
              "Content-Type": "application/json",
              "X-Postwave-Sending-Cap-Outcome": "not-committed",
            },
          },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await sendingSettingsApi.put(input);

    expect(result.error).toMatchObject({
      kind: "http",
      status: 409,
      code: "settings_conflict",
    });
    expect(result.responseMetadata?.sendingCapOutcome).toBe("not-committed");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("holds a headerless redirect response for reconciliation", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            error: { code: "redirected", message: "proxy redirect" },
          }),
          { status: 302, headers: { "Content-Type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await sendingSettingsApi.put(input);

    expect(result.error).toMatchObject({
      kind: "parse",
      status: 302,
      code: "sending_settings_mutation_unproven",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("holds an outcome-bearing redirect response for reconciliation", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            error: { code: "redirected", message: "proxy redirect" },
          }),
          {
            status: 302,
            headers: {
              "Content-Type": "application/json",
              "X-Postwave-Sending-Cap-Outcome": "not-committed",
            },
          },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await sendingSettingsApi.put(input);

    expect(result.error).toMatchObject({
      kind: "parse",
      status: 302,
      code: "sending_settings_mutation_unproven",
    });
    expect(result.responseMetadata?.sendingCapOutcome).toBe("not-committed");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refuses fetch redirects beneath the one-attempt sending write", async () => {
    const fetchMock = vi.fn(
      async (_url: RequestInfo | URL, init?: RequestInit) => {
        expect(init?.redirect).toBe("error");
        throw new TypeError("redirect mode refused a 307 response");
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await sendingSettingsApi.put(input);

    expect(result.error).toMatchObject({ kind: "network" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["missing", undefined],
    ["Go-zero", "0001-01-01T00:00:00Z"],
    ["fractional Go-zero", "0001-01-01T00:00:00.0Z"],
    ["malformed", "not-a-time"],
    ["unchanged", input.expected_updated_at],
    ["older", "2026-08-31T10:59:59.999999999Z"],
    ["equal instant in another offset", "2026-08-31T12:00:00+01:00"],
  ])(
    "rejects a committed response with a %s revision",
    async (_label, revision) => {
      const fetchMock = vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              tenant_id: "tenant-1",
              max_sends_per_hour: input.max_sends_per_hour,
              quiet_hours_start: input.quiet_hours_start,
              quiet_hours_end: input.quiet_hours_end,
              quiet_hours_tz: input.quiet_hours_tz,
              quiet_hours_per_recipient: input.quiet_hours_per_recipient,
              ...(revision === undefined ? {} : { updated_at: revision }),
            }),
            {
              status: 200,
              headers: {
                "Content-Type": "application/json",
                "X-Postwave-Sending-Cap-Outcome": "committed",
              },
            },
          ),
      );
      vi.stubGlobal("fetch", fetchMock);

      const result = await sendingSettingsApi.put(input);

      expect(result.error).toMatchObject({
        kind: "parse",
        code: "sending_settings_mutation_unproven",
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  it("preserves sub-millisecond precision when proving a later revision", async () => {
    const expected = "2026-08-31T11:00:00.000000001Z";
    const committed = "2026-08-31T11:00:00.000000002Z";
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            tenant_id: "tenant-1",
            max_sends_per_hour: input.max_sends_per_hour,
            quiet_hours_start: input.quiet_hours_start,
            quiet_hours_end: input.quiet_hours_end,
            quiet_hours_tz: input.quiet_hours_tz,
            quiet_hours_per_recipient: input.quiet_hours_per_recipient,
            updated_at: committed,
          }),
          {
            status: 200,
            headers: {
              "Content-Type": "application/json",
              "X-Postwave-Sending-Cap-Outcome": "committed",
            },
          },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await sendingSettingsApi.put({
      ...input,
      expected_updated_at: expected,
    });

    expect(result.data?.updated_at).toBe(committed);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("accepts a fresh committed revision for an empty first-write assertion", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            tenant_id: "tenant-1",
            max_sends_per_hour: input.max_sends_per_hour,
            quiet_hours_start: input.quiet_hours_start,
            quiet_hours_end: input.quiet_hours_end,
            quiet_hours_tz: input.quiet_hours_tz,
            quiet_hours_per_recipient: input.quiet_hours_per_recipient,
            updated_at: "2026-08-31T12:00:00Z",
          }),
          {
            status: 200,
            headers: {
              "Content-Type": "application/json",
              "X-Postwave-Sending-Cap-Outcome": "committed",
            },
          },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await sendingSettingsApi.put({
      ...input,
      expected_updated_at: "",
    });

    expect(result.data?.updated_at).toBe("2026-08-31T12:00:00Z");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("API identity transition barrier", () => {
  it("rejects new API and stream dispatch while identity is changing", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const token = beginApiIdentityTransition();

    const result = await apiRequest<{ ok: boolean }>("/api/v1/barrier-test");
    const upload = await api.uploadMigrationFile(
      "mailchimp",
      new File(["email\na@example.com\n"], "contacts.csv"),
    );
    const receipt = await audienceSyncsApi.downloadExclusionReceipt("run-1");
    const oauthAvailable = await apiAuth.oauthIsAvailable("google");
    await expect(buildStreamUrl("/api/v1/events")).rejects.toThrow(
      /identity is changing/i,
    );

    expect(result.error?.code).toBe("identity_transition");
    expect(upload.error?.code).toBe("identity_transition");
    expect(receipt.error?.code).toBe("identity_transition");
    expect(oauthAvailable).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    releaseApiIdentityTransition(token);
  });

  it("discards a late response from the old identity generation", async () => {
    let resolveFetch!: (response: Response) => void;
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const pending = apiRequest<{ workspace: string }>(
      "/api/v1/late-identity-test",
    );
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const token = beginApiIdentityTransition();
    resolveFetch(
      new Response(JSON.stringify({ workspace: "source" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const result = await pending;
    expect(result.data).toBeUndefined();
    expect(result.error?.code).toBe("identity_changed");
    releaseApiIdentityTransition(token);
  });

  it("discards a late direct OAuth probe verdict", async () => {
    let resolveFetch!: (response: Response) => void;
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const pending = apiAuth.oauthIsAvailable("google");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const token = beginApiIdentityTransition();
    resolveFetch(new Response("{}", { status: 404 }));

    await expect(pending).resolves.toBe(true);
    releaseApiIdentityTransition(token);
  });
});

describe("API response boundaries", () => {
  it("guards legacy sequence email updates with a confirmed strong revision", async () => {
    const calls: Array<{ url: string; ifMatch: string | null }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({
          url,
          ifMatch: new Headers(init.headers).get("If-Match"),
        });
        return new Response(
          JSON.stringify({ id: "seq/a", status: "draft", version: 8 }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }),
    );

    const emails = [
      {
        position: 1,
        delay_seconds: 0,
        subject: "Welcome",
        body: "Hello",
      },
    ];
    const saved = await updateSequenceEmails("seq/a", emails, 7);
    const blocked = await updateSequenceEmails("seq/a", emails, 0);

    expect(saved.data?.version).toBe(8);
    expect(blocked.error?.kind).toBe("invalid_config");
    expect(calls).toEqual([
      {
        url: "http://localhost:8080/api/v1/voice/sequences/seq%2Fa",
        ifMatch: '"7"',
      },
    ]);
  });

  it("preserves a malformed frequency-cap success envelope for UI rejection", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("{}", {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      ),
    );

    const result = await frequencyCapsApi.list();

    expect(result.error).toBeUndefined();
    expect(result.data).toEqual({ items: undefined });
  });

  it("sends the canonical frequency-cap revision and receipt on update", async () => {
    const calls: Array<{
      url: string;
      method: string | undefined;
      body: string | null;
      idempotencyKey: string | null;
    }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({
          url: String(input),
          method: init?.method,
          body: typeof init?.body === "string" ? init.body : null,
          idempotencyKey: new Headers(init?.headers).get("Idempotency-Key"),
        });
        return new Response(
          JSON.stringify({
            rule: {
              id: "cap/1",
              label: "Daily lifecycle",
              max_sends: 3,
              window_hours: 24,
              active: true,
              channels: ["email"],
              updated_at: "2026-08-30T06:01:00Z",
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }),
    );

    const result = await frequencyCapsApi.update(
      "cap/1",
      { label: "Daily lifecycle" },
      "2026-08-30T06:00:00Z",
      { idempotencyKey: "frequency-update-receipt" },
    );

    expect(result.data?.updated_at).toBe("2026-08-30T06:01:00Z");
    expect(calls).toEqual([
      {
        url: "http://localhost:8080/api/v1/sending/frequency-caps/cap%2F1",
        method: "PATCH",
        body: JSON.stringify({
          label: "Daily lifecycle",
          expected_updated_at: "2026-08-30T06:00:00Z",
        }),
        idempotencyKey: "frequency-update-receipt",
      },
    ]);
  });

  it("accepts the canonical bodyless frequency-cap delete response", async () => {
    const calls: Array<{
      url: string;
      method: string | undefined;
      body: string | null;
      idempotencyKey: string | null;
    }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({
          url: String(input),
          method: init?.method,
          body: typeof init?.body === "string" ? init.body : null,
          idempotencyKey: new Headers(init?.headers).get("Idempotency-Key"),
        });
        return new Response(null, { status: 204 });
      }),
    );

    const result = await frequencyCapsApi.remove(
      "cap/1",
      "2026-08-30T06:00:00Z",
      { idempotencyKey: "frequency-delete-receipt" },
    );

    expect(result.error).toBeUndefined();
    expect(result.data).toBeUndefined();
    expect(calls).toEqual([
      {
        url: "http://localhost:8080/api/v1/sending/frequency-caps/cap%2F1",
        method: "DELETE",
        body: JSON.stringify({
          expected_updated_at: "2026-08-30T06:00:00Z",
        }),
        idempotencyKey: "frequency-delete-receipt",
      },
    ]);
  });

  it("sends exact intelligent-retry revisions for both admin mutations", async () => {
    const calls: Array<{
      url: string;
      method: string | undefined;
      body: string | null;
    }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({
          url: String(input),
          method: init?.method,
          body: typeof init?.body === "string" ? init.body : null,
        });
        return new Response(
          JSON.stringify({
            id: "retry/1",
            tenant_id: "tenant-1",
            campaign_id: "campaign-1",
            subscriber_email: "held@example.test",
            reason: "frequency_cap",
            status: "ready",
            retry_after: "2026-08-30T07:00:00Z",
            attempts: 0,
            created_at: "2026-08-30T06:00:00Z",
            updated_at: "2026-08-30T06:01:00Z",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }),
    );

    await intelligentRetryApi.markReady(
      "retry/1",
      "2026-08-30T06:00:00.123456Z",
    );
    await intelligentRetryApi.dismiss("retry/1", "2026-08-30T06:01:00.654321Z");

    expect(calls).toEqual([
      {
        url: "http://localhost:8080/api/v1/intelligent-retry/events/retry%2F1/mark-ready",
        method: "POST",
        body: JSON.stringify({
          expected_updated_at: "2026-08-30T06:00:00.123456Z",
        }),
      },
      {
        url: "http://localhost:8080/api/v1/intelligent-retry/events/retry%2F1/dismiss",
        method: "POST",
        body: JSON.stringify({
          expected_updated_at: "2026-08-30T06:01:00.654321Z",
        }),
      },
    ]);
  });
});

describe("api-client validateApiConnection", () => {
  it("reads the authenticated API key tenant and scopes for desktop identity", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      expect(new URL(String(input)).pathname).toBe("/api/v1/api-keys/me");
      return new Response(
        JSON.stringify({
          tenant_id: "tenant_1",
          tenant_slug: "demo",
          scopes: ["admin"],
          actor: "Local desktop demo",
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await api.getApiKeySelfInfo();

    expect(result.data).toEqual({
      tenant_id: "tenant_1",
      tenant_slug: "demo",
      scopes: ["admin"],
      actor: "Local desktop demo",
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("validates bearer credentials through the API-key self-info route", async () => {
    const requestedPaths: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input));
        requestedPaths.push(url.pathname);
        const body =
          url.pathname === "/api/health"
            ? { status: "ok", version: "test", service: "api" }
            : { api_key_id: "key_1", scopes: ["admin"] };
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );

    const result = await validateApiConnection(
      "http://localhost:8080",
      "pw_live_demo_key",
    );

    expect(result.error).toBeUndefined();
    expect(result.data?.authenticated).toBe(true);
    expect(requestedPaths).toEqual(["/api/health", "/api/v1/api-keys/me"]);
  });

  it("keeps browser/dev API keys memory-only outside Tauri", async () => {
    const storage = new Map<string, string>();
    const localStorage: Storage = {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => {
        storage.set(key, value);
      },
      removeItem: (key: string) => {
        storage.delete(key);
      },
      clear: () => storage.clear(),
      key: (index: number) => Array.from(storage.keys())[index] ?? null,
      get length() {
        return storage.size;
      },
    };
    globalThis.window.localStorage = localStorage;

    await setApiConfig("http://localhost:8080", "pw_secret");

    expect(storage.get("postwave_api_key")).toBeUndefined();
    expect(getApiKey()).toBe("pw_secret");
    await clearApiConfig();
  });

  it("drops oversized stored API URLs and API keys", async () => {
    const storage = new Map<string, string>();
    const localStorage: Storage = {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => {
        storage.set(key, value);
      },
      removeItem: (key: string) => {
        storage.delete(key);
      },
      clear: () => storage.clear(),
      key: () => null,
      get length() {
        return storage.size;
      },
    };
    globalThis.window.localStorage = localStorage;
    storage.set(
      "postwave_api_url",
      `https://api.example.com/${"x".repeat(3000)}`,
    );
    storage.set("postwave_api_key", `pw_${"x".repeat(9000)}`);
    // The production client intentionally caches the validated authority.
    // Simulate startup/reconfiguration before asserting against injected
    // persisted state instead of inheriting another test's in-memory cache.
    invalidateApiUrlCache();

    expect(getApiUrl()).toBe("http://localhost:8080");
    expect(storage.has("postwave_api_url")).toBe(false);
    await hydrateSecureApiConfig();
    expect(getApiKey()).toBeNull();
    expect(storage.has("postwave_api_key")).toBe(false);
    expect(() =>
      setApiConfig("http://localhost:8080", `pw_${"x".repeat(9000)}`),
    ).toThrow(/too large/i);
  });

  it("bounds the remembered desktop session hint", () => {
    const storage = new Map<string, string>();
    const localStorage: Storage = {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => {
        storage.set(key, value);
      },
      removeItem: (key: string) => {
        storage.delete(key);
      },
      clear: () => storage.clear(),
      key: () => null,
      get length() {
        return storage.size;
      },
    };
    globalThis.window.localStorage = localStorage;

    rememberSession({
      user_id: "user_1",
      tenant_id: "tenant_1",
      email: "owner@example.com",
      role: "owner",
      auth_provider: "password",
      email_verified: true,
    });
    expect(getRememberedSession()).toMatchObject({
      user_id: "user_1",
      tenant_id: "tenant_1",
      role: "owner",
    });

    storage.set("postwave_session_user", "x".repeat(9 * 1024));
    expect(getRememberedSession()).toBeNull();
    expect(storage.has("postwave_session_user")).toBe(false);
  });

  it("returns ok=false when health endpoint 5xxs", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response("upstream broken", {
          status: 503,
          headers: { "Content-Type": "text/plain" },
        });
      }),
    );
    const r = await validateApiConnection("http://localhost:8080", null);
    expect(r.error).toBeTruthy();
    if (r.error) {
      expect(r.error.status).toBe(503);
    }
  });

  it("returns ok=false when health endpoint 4xxs with a JSON error body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(
          JSON.stringify({ error: { message: "bad token" } }),
          {
            status: 401,
            headers: { "Content-Type": "application/json" },
          },
        );
      }),
    );
    const r = await validateApiConnection("http://localhost:8080", "pw_xxx");
    expect(r.error).toBeTruthy();
    if (r.error) {
      expect(r.error.status).toBe(401);
      expect(r.error.code).toBe("http_401");
      expect(r.error.message).toContain("bad token");
    }
  });

  it("preserves structured error code, request id, and retry-after", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(
          JSON.stringify({
            error: {
              code: "rate_limited",
              message: "Slow down",
              request_id: "req_body",
              retry_after_seconds: 4,
            },
          }),
          {
            status: 429,
            headers: {
              "Content-Type": "application/json",
              "x-request-id": "req_header",
            },
          },
        );
      }),
    );

    const r = await validateApiConnection("http://localhost:8080", null);
    expect(r.error).toBeTruthy();
    expect(r.error?.status).toBe(429);
    expect(r.error?.code).toBe("rate_limited");
    expect(r.error?.requestId).toBe("req_header");
    expect(r.error?.retryAfterSeconds).toBe(4);
    expect(r.error?.message).toContain("request req_header");
  });

  // The denial vocabulary (apps/api/internal/entitlement) exists so a client can
  // tell a role refusal from a paywall from a quota window — three refusals with
  // three different remedies. Desktop lifted the fields into an untyped
  // `details` bag and then ignored them: every one of them reached the user as
  // the server's bare sentence. These pin the transport-level fix, which is
  // where it has to live: `errorFromResponse` is the chokepoint every `api.*`
  // call funnels through, so no screen has to opt in.
  /** entitlement.Reason.httpStatus(), mirrored so a fixture cannot drift from
   *  the status the server would really have sent for that reason. */
  const DENIAL_STATUS: Record<DenialReason, number> = {
    plan: 402,
    role: 403,
    flag: 403,
    policy: 403,
    quota: 429,
    runtime: 503,
  };

  const denialResponse = (status: number, error: Record<string, unknown>) =>
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error }), {
            status,
            headers: { "Content-Type": "application/json" },
          }),
      ),
    );

  it("tells a role-denied user who can unblock them, and classifies the refusal", async () => {
    // Byte-for-byte what internal/rbac/rbac.go writes at the permission
    // chokepoint — the single most-hit denial in the API.
    denialResponse(403, {
      subject: "campaigns.write",
      reason: "role",
      code: "insufficient_permission",
      message: "your role does not have the campaigns.write permission",
      required_role: "editor",
    });

    const r = await validateApiConnection("http://localhost:8080", null);
    expect(r.error?.message).toContain("Ask a workspace editor");
    expect(r.error?.message.toLowerCase()).not.toContain("upgrade");
    expect(r.error?.denial).toEqual({
      reason: "role",
      code: "insufficient_permission",
      subject: "campaigns.write",
      requiredRole: "editor",
    });
  });

  it("offers the upgrade only when the server asserted that remedy", async () => {
    denialResponse(402, {
      subject: "plan.contacts",
      reason: "plan",
      code: "plan_limit_exceeded",
      message: "plan limit reached for contacts",
      resource: "contacts",
      tier: "studio",
      limit: 5000,
      current: 5000,
      remedy: "upgrade_plan",
    });
    const paid = await validateApiConnection("http://localhost:8080", null);
    expect(paid.error?.message).toContain("Upgrade your plan");
    expect(paid.error?.denial?.reason).toBe("plan");

    // Top tier: entitlement.Write strips the remedy because there is nothing
    // above `pro` to buy. Desktop must not re-derive one from the code.
    denialResponse(402, {
      reason: "plan",
      code: "plan_limit_exceeded",
      message: "plan limit reached for monthly_sends",
      tier: "pro",
    });
    const topTier = await validateApiConnection("http://localhost:8080", null);
    expect(topTier.error?.message).not.toContain("Upgrade your plan");
    expect(topTier.error?.denial?.tier).toBe("pro");
  });

  it("says nothing extra for a policy refusal, which neither money nor a role fixes", async () => {
    // routeauth's unclassified-route denial: a deployment gap, not the caller's
    // problem. Offering an action here sends someone hunting a permission that
    // was never the issue.
    denialResponse(403, {
      subject: "route",
      reason: "policy",
      code: "route_authorization_unclassified",
      message: "this route has no approved authorization policy",
    });
    const r = await validateApiConnection("http://localhost:8080", null);
    expect(r.error?.message).toBe(
      "this route has no approved authorization policy",
    );
    expect(r.error?.denial?.reason).toBe("policy");
  });

  it("says when a quota window reopens — the one refusal waiting resolves", async () => {
    // Body-only on purpose: a `Retry-After` HEADER makes httpFetch actually
    // sleep for that long before giving up on the 429, so asserting the header
    // path here would mean a multi-minute (or flaky one-second) test. The
    // body field is the authoritative half anyway — entitlement.Write mirrors
    // it INTO the header, not the other way round.
    denialResponse(429, {
      reason: "quota",
      code: "rate_limited",
      message: "too many requests",
      retry_after_seconds: 120,
    });
    const r = await validateApiConnection("http://localhost:8080", null);
    expect(r.error?.message).toContain("Try again in 2 minutes");
    expect(r.error?.denial).toEqual({
      reason: "quota",
      code: "rate_limited",
      retryAfterSeconds: 120,
    });
  });

  it("leaves an ordinary error untouched and unclassified", async () => {
    denialResponse(404, { code: "not_found", message: "campaign not found" });
    const r = await validateApiConnection("http://localhost:8080", null);
    expect(r.error?.message).toBe("campaign not found");
    expect(r.error?.denial).toBeUndefined();
  });

  it("classifies every reason in the vocabulary, not just the ones with copy", async () => {
    // Exhaustive over DENIAL_REASONS rather than the four spelled out above, so
    // adding a reason to the server (and to @postwave/errors) cannot leave
    // desktop silently unable to classify it. `flag` and `policy` get the
    // message alone on purpose — neither money nor permissions resolve them.
    for (const reason of DENIAL_REASONS) {
      denialResponse(DENIAL_STATUS[reason], {
        reason,
        code: `${reason}_denied`,
        message: `refused: ${reason}`,
      });
      const r = await validateApiConnection("http://localhost:8080", null);
      expect(r.error?.denial?.reason).toBe(reason);
      // Including `runtime`, whose 503 used to trip the blanket 5xx redaction
      // and reach the user as "Server error. Please try again." — reporting an
      // outage for a boundary the server had just explained in a message it
      // documents as safe to show.
      expect(r.error?.message).toContain(`refused: ${reason}`);
    }
  });

  it("still redacts a 5xx that is NOT a classified denial", async () => {
    // The denial exemption must not become a general 5xx exemption: an
    // anonymous server error can be an incident leaking a driver string.
    denialResponse(503, { code: "boom", message: "pq: connection refused" });
    const anonymous = await validateApiConnection(
      "http://localhost:8080",
      null,
    );
    expect(anonymous.error?.message).toBe("Server error. Please try again.");
    expect(anonymous.error?.denial).toBeUndefined();

    // …and a denial carrying one is redacted too — the exemption is from the
    // blanket status rule, not from the internals check.
    denialResponse(503, {
      reason: "runtime",
      code: "permission_check_failed",
      message: "pq: could not connect to grants store",
    });
    const leaky = await validateApiConnection("http://localhost:8080", null);
    expect(leaky.error?.message).toBe("Server error. Please try again.");
    expect(leaky.error?.denial?.reason).toBe("runtime");
  });

  it("offers recovery on exactly the refusals @postwave/errors calls retryable", async () => {
    // Desktop derives `retryability` from the STATUS; mobile's ErrorState
    // derives its Retry button from `denialRetryable(denial)`. Two independent
    // answers to one question, and nothing checked they agreed — so the same
    // refusal could offer recovery on one surface and withhold it on the other,
    // which is precisely the drift this contract exists to stop. Both are
    // anchored to entitlement.Reason.httpStatus, so this pins them to each
    // other rather than to a third hand-written table.
    //
    // Through `apiRequest`, not `validateApiConnection`: the latter is the
    // connection-setup probe (`requestWithConfig`) and returns a bare
    // `{ error }` with no `retryability` at all, so asserting it there would
    // have compared against undefined and passed for the wrong reason.
    for (const reason of DENIAL_REASONS) {
      // Body-only retry_after_seconds: a `Retry-After` HEADER would make
      // httpFetch sleep for it, as the quota test above explains.
      denialResponse(DENIAL_STATUS[reason], {
        reason,
        code: `${reason}_denied`,
        message: `refused: ${reason}`,
      });
      const r = await apiRequest("/api/v1/forms");
      expect(r.error?.denial?.reason).toBe(reason);
      // Narrows ApiResult to ApiErr — `retryability` only exists on the error
      // arm, which is the point: a success has no recovery to offer.
      if (!r.error) throw new Error(`expected a ${reason} denial`);
      expect({
        reason,
        offersRecovery: r.retryability !== "not-retryable",
      }).toEqual({
        reason,
        offersRecovery: denialRetryable({ reason }),
      });
    }
  });

  it("redacts backend internals from server errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(
          JSON.stringify({
            error: {
              code: "insert_failed",
              message: 'pq: duplicate key value violates unique constraint "x"',
            },
          }),
          {
            status: 500,
            headers: { "Content-Type": "application/json" },
          },
        );
      }),
    );

    const r = await validateApiConnection("http://localhost:8080", null);
    expect(r.error?.message).toBe("Server error. Please try again.");
  });

  it("does not throw on network failure — returns clean error envelope", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );
    const r = await validateApiConnection("http://localhost:8080", null);
    expect(r.error).toBeTruthy();
    if (r.error) {
      expect(r.error.message).toMatch(/fetch|Network/i);
      expect(r.error.kind).toBe("network");
    }
  });

  it("returns a parse error envelope for invalid success JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response("{not json", {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );

    const r = await validateApiConnection("http://localhost:8080", null);
    expect(r.error?.kind).toBe("parse");
  });

  it("returns a parse error envelope for oversized success bodies", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(JSON.stringify({ status: "ok" }), {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "Content-Length": String(3 * 1024 * 1024),
          },
        });
      }),
    );

    const r = await validateApiConnection("http://localhost:8080", null);
    expect(r.error).toMatchObject({
      kind: "parse",
      code: "response_too_large",
    });
  });

  it("returns a parse error envelope for invalid auth JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response("{not json", {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );

    const r = await apiAuth.getAuthMe();
    expect(r.error?.kind).toBe("parse");
  });

  it("returns a parse error envelope for oversized auth JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(JSON.stringify({ user_id: "u" }), {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "Content-Length": String(3 * 1024 * 1024),
          },
        });
      }),
    );

    const r = await apiAuth.getAuthMe();
    expect(r.error).toMatchObject({
      kind: "parse",
      code: "response_too_large",
    });
  });

  it("sends the complete signed-v1 contract for desktop magic and reset", async () => {
    const requests: RequestInit[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        requests.push(init ?? {});
        return new Response(JSON.stringify({ sent: true, reset: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );
    const state = "native_state_123456";
    const signature = "A".repeat(43);
    const magicProof = {
      token: "magic-token",
      link_version: 1 as const,
      link_flow: "magic" as const,
      link_audience: "mobile" as const,
      state,
      link_signature: signature,
    };
    const resetProof = {
      ...magicProof,
      token: "reset-token",
      link_flow: "reset" as const,
    };

    await apiAuth.magicLinkStart("user@example.com", state);
    await apiAuth.magicLinkConsume(magicProof);
    await apiAuth.passwordResetStart("user@example.com", state);
    await apiAuth.passwordResetConfirm(resetProof, "LongerPassword1!");

    expect(requests.map((request) => JSON.parse(String(request.body)))).toEqual(
      [
        {
          email: "user@example.com",
          link_version: 1,
          link_audience: "mobile",
          state,
        },
        magicProof,
        {
          email: "user@example.com",
          link_version: 1,
          link_audience: "mobile",
          state,
        },
        { ...resetProof, new_password: "LongerPassword1!" },
      ],
    );
  });

  it("returns data when health responds 200 OK", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls++;
        return new Response(
          JSON.stringify({ status: "ok", version: "test", service: "api" }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }),
    );
    const r = await validateApiConnection("http://localhost:8080", null);
    expect(calls).toBeGreaterThan(0);
    expect(r.error).toBeUndefined();
    expect(r.data?.health.status).toBe("ok");
  });

  it("builds stream URLs with short-lived stream tokens", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          token: "pws_payload.sig",
          expires_at: "2026-05-11T00:00:00Z",
          ttl_seconds: 120,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const url = await buildStreamUrl("/api/v1/events?topics=campaign.*");

    expect(url).toBe(
      "http://localhost:8080/api/v1/events?topics=campaign.*&stream_token=pws_payload.sig",
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:8080/api/v1/streams/token",
      expect.objectContaining({
        method: "POST",
        credentials: "include",
      }),
    );
  });

  it("never reuses a cached stream token after the signed-in tenant changes", async () => {
    const tokens = ["pws_tenant_a.sig", "pws_tenant_b.sig"];
    const fetchMock = vi.fn(async () => {
      const token = tokens[fetchMock.mock.calls.length - 1];
      return new Response(
        JSON.stringify({
          token,
          expires_at: "2026-07-24T12:00:00Z",
          ttl_seconds: 120,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    rememberSession({
      user_id: "user-a",
      tenant_id: "tenant-a",
      email: "a@example.com",
      role: "admin",
      auth_provider: "password",
      email_verified: true,
    });
    const first = await buildStreamUrl("/api/v1/track/stream");

    rememberSession({
      user_id: "user-b",
      tenant_id: "tenant-b",
      email: "b@example.com",
      role: "admin",
      auth_provider: "password",
      email_verified: true,
    });
    const second = await buildStreamUrl("/api/v1/track/events.csv");

    expect(new URL(first).searchParams.get("stream_token")).toBe(
      "pws_tenant_a.sig",
    );
    expect(new URL(second).searchParams.get("stream_token")).toBe(
      "pws_tenant_b.sig",
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await clearApiConfig();
  });

  it("discards a late token response after session identity invalidation", async () => {
    let resolveFirst!: (response: Response) => void;
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            token: "pws_tenant_b.sig",
            expires_at: "2026-07-24T12:00:00Z",
            ttl_seconds: 120,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    rememberSession({
      user_id: "user-a",
      tenant_id: "tenant-a",
      email: "a@example.com",
      role: "admin",
      auth_provider: "password",
      email_verified: true,
    });
    const stale = buildStreamUrl("/api/v1/track/stream");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    rememberSession({
      user_id: "user-b",
      tenant_id: "tenant-b",
      email: "b@example.com",
      role: "admin",
      auth_provider: "password",
      email_verified: true,
    });
    resolveFirst(
      new Response(
        JSON.stringify({
          token: "pws_tenant_a.sig",
          expires_at: "2026-07-24T12:00:00Z",
          ttl_seconds: 120,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    await expect(stale).rejects.toThrow(
      /workspace changed before the stream could be opened/i,
    );
    const fresh = await buildStreamUrl("/api/v1/track/stream");
    expect(new URL(fresh).searchParams.get("stream_token")).toBe(
      "pws_tenant_b.sig",
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await clearApiConfig();
  });

  it("invalidates the token cache when API credentials are cleared", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            token: "pws_before_clear.sig",
            expires_at: "2026-07-24T12:00:00Z",
            ttl_seconds: 120,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            token: "pws_after_clear.sig",
            expires_at: "2026-07-24T12:00:00Z",
            ttl_seconds: 120,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    rememberSession({
      user_id: "user-a",
      tenant_id: "tenant-a",
      email: "a@example.com",
      role: "admin",
      auth_provider: "password",
      email_verified: true,
    });
    const before = await buildStreamUrl("/api/v1/track/stream");
    await clearApiConfig();
    const after = await buildStreamUrl("/api/v1/track/stream");

    expect(new URL(before).searchParams.get("stream_token")).toBe(
      "pws_before_clear.sig",
    );
    expect(new URL(after).searchParams.get("stream_token")).toBe(
      "pws_after_clear.sig",
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await clearApiConfig();
  });

  it("never attaches a cached token to a replacement API origin", async () => {
    const storage = new Map<string, string>();
    globalThis.window.localStorage = {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => {
        storage.set(key, value);
      },
      removeItem: (key: string) => {
        storage.delete(key);
      },
      clear: () => storage.clear(),
      key: (index: number) => Array.from(storage.keys())[index] ?? null,
      get length() {
        return storage.size;
      },
    };
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      const token = url.startsWith("https://api-a.example.com/")
        ? "pws_origin_a.sig"
        : "pws_origin_b.sig";
      return new Response(
        JSON.stringify({
          token,
          expires_at: "2026-07-24T12:00:00Z",
          ttl_seconds: 120,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    await setApiConfig("https://api-a.example.com", "pw_origin_a");
    const first = await buildStreamUrl("/api/v1/track/stream");
    await setApiConfig("https://api-b.example.com", "pw_origin_b");
    const second = await buildStreamUrl("/api/v1/track/events.csv");

    expect(first).toContain("https://api-a.example.com/api/v1/track/stream");
    expect(new URL(first).searchParams.get("stream_token")).toBe(
      "pws_origin_a.sig",
    );
    expect(second).toContain(
      "https://api-b.example.com/api/v1/track/events.csv",
    );
    expect(new URL(second).searchParams.get("stream_token")).toBe(
      "pws_origin_b.sig",
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual([
      "https://api-a.example.com/api/v1/streams/token",
      "https://api-b.example.com/api/v1/streams/token",
    ]);
    await clearApiConfig();
  });

  it("invalidates a cached admin token when the effective role drops", async () => {
    const tokens = ["pws_admin.sig", "pws_viewer.sig"];
    const fetchMock = vi.fn(async () => {
      const token = tokens[fetchMock.mock.calls.length - 1];
      return new Response(
        JSON.stringify({
          token,
          expires_at: "2026-07-24T12:00:00Z",
          ttl_seconds: 120,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    rememberSession({
      user_id: "user-a",
      tenant_id: "tenant-a",
      email: "a@example.com",
      role: "admin",
      effective_role: "admin",
      auth_provider: "password",
      email_verified: true,
    });
    const admin = await buildStreamUrl("/api/v1/track/events.csv");
    rememberSession({
      user_id: "user-a",
      tenant_id: "tenant-a",
      email: "a@example.com",
      role: "admin",
      effective_role: "viewer",
      viewer_mode: true,
      auth_provider: "password",
      email_verified: true,
    });
    const viewer = await buildStreamUrl("/api/v1/track/events.csv");

    expect(new URL(admin).searchParams.get("stream_token")).toBe(
      "pws_admin.sig",
    );
    expect(new URL(viewer).searchParams.get("stream_token")).toBe(
      "pws_viewer.sig",
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await clearApiConfig();
  });

  it("builds stream URLs for path-like inputs without malformed base joins", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          token: "pws_payload.sig",
          expires_at: "2026-05-11T00:00:00Z",
          ttl_seconds: 120,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const url = await buildStreamUrl("api/v1/events?topics=campaign.*");

    expect(url).toBe(
      "http://localhost:8080/api/v1/events?topics=campaign.*&stream_token=pws_payload.sig",
    );
  });

  it("rejects absolute-looking stream paths before minting a token", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          token: "pws_payload.sig",
          expires_at: "2026-05-11T00:00:00Z",
          ttl_seconds: 120,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      buildStreamUrl("https://evil.example/events?x=1"),
    ).rejects.toThrow(/Unsafe API path/);
    await expect(buildStreamUrl("/api/v1/%2e%2e/events")).rejects.toThrow(
      /Unsafe API path/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("api-client OAuth navigation guards", () => {
  it("allows only relative paths and owned auth deep links as OAuth returns", () => {
    expect(safeOAuthRedirectTo("/app")).toBe("/app");
    expect(safeOAuthRedirectTo("moosewave://auth/magic")).toBe(
      "moosewave://auth/magic",
    );
    expect(
      safeOAuthRedirectTo("moosewave://auth/magic?state=nonce_123&x=ignored"),
    ).toBe("moosewave://auth/magic?state=nonce_123");
    expect(safeOAuthRedirectTo("moosewave://auth/oauth-return")).toBe(
      "moosewave://auth/oauth-return",
    );
  });

  it("rejects unrelated or credentialed OAuth return URLs", () => {
    expect(safeOAuthRedirectTo("//evil.example/app")).toBeUndefined();
    expect(
      safeOAuthRedirectTo("https://app.unrelated.invalid/app"),
    ).toBeUndefined();
    expect(safeOAuthRedirectTo("moosewave://subscriber/123")).toBeUndefined();
    expect(safeOAuthRedirectTo("moosewave://u:p@auth/magic")).toBeUndefined();
    expect(
      safeOAuthRedirectTo("moosewave://auth/magic?state=one&state=two"),
    ).toBeUndefined();
    expect(safeOAuthRedirectTo("moosewave://auth/magic#frag")).toBeUndefined();
    expect(safeOAuthRedirectTo(`/${"x".repeat(3000)}`)).toBeUndefined();
  });

  it("allows Slack OAuth start on HTTPS and local development HTTP", () => {
    expect(
      safeSlackOAuthStartUrl(
        "https://api.postwave.test/api/v1/slack/oauth/start#x",
      ),
    ).toBe("https://api.postwave.test/api/v1/slack/oauth/start");
    expect(
      safeSlackOAuthStartUrl("http://localhost:8080/api/v1/slack/oauth/start"),
    ).toBe("http://localhost:8080/api/v1/slack/oauth/start");
  });

  it("rejects Slack OAuth start URLs that could navigate somewhere unexpected", () => {
    expect(
      safeSlackOAuthStartUrl(
        "https://api.postwave.test/api/v1/slack/oauth/callback",
      ),
    ).toBeNull();
    expect(
      safeSlackOAuthStartUrl(
        "https://user:pass@api.postwave.test/api/v1/slack/oauth/start",
      ),
    ).toBeNull();
    expect(
      safeSlackOAuthStartUrl(
        "http://api.postwave.test/api/v1/slack/oauth/start",
      ),
    ).toBeNull();
    expect(safeSlackOAuthStartUrl("javascript:alert(1)")).toBeNull();
    expect(
      safeSlackOAuthStartUrl(
        `https://api.postwave.test/api/v1/slack/oauth/start?x=${"a".repeat(3000)}`,
      ),
    ).toBeNull();
  });
});

describe("api-client sequence and automation helpers", () => {
  it("creates manual sequence drafts with full step payloads", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({
          url,
          body: JSON.parse((init.body as string) || "{}"),
        });
        return new Response(
          JSON.stringify({
            id: "seq_1",
            name: "Follow up: trial_started",
            status: "draft",
            steps: [],
          }),
          { status: 201, headers: { "Content-Type": "application/json" } },
        );
      }),
    );

    const r = await api.createSequence({
      name: "Follow up: trial_started",
      steps: [
        {
          type: "condition",
          position: 1,
          condition: {
            predicate: "product_event",
            value: "trial_started",
            yes_branch: [],
            no_branch: [],
          },
        },
      ],
    });

    expect(r.error).toBeUndefined();
    expect(calls[0].url).toContain("/api/v1/voice/sequences");
    expect(calls[0].body).toMatchObject({
      name: "Follow up: trial_started",
      status: "draft",
      steps: [
        {
          type: "condition",
          condition: { predicate: "product_event", value: "trial_started" },
        },
      ],
    });
  });

  it("encodes sequence regenerate route segments and rejects invalid positions", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({
          url,
          body: JSON.parse((init.body as string) || "{}"),
        });
        // Synchronous single-email response shape (dev/tests path):
        // the client returns {subject, body} directly, no polling (D07#2).
        return new Response(
          JSON.stringify({
            position: 2,
            subject: "New subject",
            body: "New body",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }),
    );

    const ok = await api.regenerateSequenceStep("seq/a", 2);
    const bad = await api.regenerateSequenceStep("seq/a", 0);

    expect(ok.error).toBeUndefined();
    expect(ok.data).toEqual({ subject: "New subject", body: "New body" });
    expect(bad.error?.kind).toBe("invalid_config");
    expect(calls).toEqual([
      {
        url: "http://localhost:8080/api/v1/voice/sequences/seq%2Fa/regenerate/2",
        body: {},
      },
    ]);
  });

  it("serializes analytics range through URLSearchParams", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(url);
        return new Response(JSON.stringify({ points: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );

    const res = await api.getSubscriberTimeseries("30d");

    expect(res.error).toBeUndefined();
    expect(calls).toEqual([
      "http://localhost:8080/api/v1/analytics/subscribers/timeseries?range=30d",
    ]);
  });

  it("creates product-event automation journeys through the compat surface", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({
          url,
          body: JSON.parse((init.body as string) || "{}"),
        });
        return new Response(
          JSON.stringify({
            id: "journey_1",
            name: "When trial_started",
            status: "draft",
            triggers: [],
            nodes: [],
            edges: [],
          }),
          { status: 201, headers: { "Content-Type": "application/json" } },
        );
      }),
    );

    const r = await api.createAutomationJourney({
      name: "When trial_started",
      status: "draft",
      triggers: [{ type: "product_event", event_name: "trial_started" }],
      nodes: [{ id: "entry", type: "trigger" }],
      edges: [],
    });

    expect(r.error).toBeUndefined();
    expect(calls[0].url).toContain("/api/v1/mailchimp-compat/automations");
    expect(calls[0].body).toMatchObject({
      name: "When trial_started",
      triggers: [{ type: "product_event", event_name: "trial_started" }],
    });
  });
});

describe("api-client native-client CSRF header", () => {
  // The Go backend's Origin/CSRF gate (apps/api/internal/middleware/
  // origin_csrf.go — isTrustedNativeClient) trusts session-cookie
  // mutating requests from this Tauri desktop build ONLY when they carry
  // `X-Postwave-Client: desktop`. Tauri webviews issue requests from the
  // tauri://localhost origin, which is NOT in the server allow-list, so
  // without this header every state-changing POST would be 403'd. Mirror
  // of apps/api/internal/middleware/origin_csrf_test.go on the client.
  it("declares the desktop native-client header constant", () => {
    expect(NATIVE_CLIENT_HEADERS).toMatchObject({
      "X-Postwave-Client": "desktop",
    });
  });

  it("sends X-Postwave-Client: desktop on every outgoing request (GET)", async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init: RequestInit) =>
        new Response("{}", {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await apiRequest("/api/v1/forms");

    const init = fetchMock.mock.calls[0][1];
    const headers = new Headers(init.headers as HeadersInit);
    expect(headers.get("X-Postwave-Client")).toBe("desktop");
  });

  it("sends X-Postwave-Client: desktop on state-changing POSTs", async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init: RequestInit) =>
        new Response("{}", {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await apiRequest("/api/v1/streams/token", {
      method: "POST",
      body: JSON.stringify({}),
    });

    const init = fetchMock.mock.calls[0][1];
    const headers = new Headers(init.headers as HeadersInit);
    expect(headers.get("X-Postwave-Client")).toBe("desktop");
    expect(init.method).toBe("POST");
  });

  it("sends X-Postwave-Client: desktop on the resumable migration chunk-upload PUT", async () => {
    // The resumable upload's chunk PUT is a state-changing request issued
    // from the tauri://localhost origin. Without X-Postwave-Client the Go
    // Origin/CSRF gate 403s it in cookie-auth mode, breaking every import.
    // A small (< MIGRATION_UPLOAD_CHUNK_SIZE) file uploads in a single PUT,
    // then a /complete POST. Ack `received` = file size so the loop exits.
    const file = new File(["id,email\n1,a@example.com\n"], "import.csv", {
      type: "text/csv",
    });
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      if (init.method === "PUT") {
        return new Response(JSON.stringify({ received: file.size }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      // /complete POST and any other call.
      return new Response("{}", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const r = await api.uploadMigrationFile("mailchimp", file);
    expect(r.error).toBeUndefined();

    // Locate the PUT call and assert it carried the native-client header.
    const putCall = fetchMock.mock.calls.find(
      ([, init]) => (init as RequestInit).method === "PUT",
    );
    expect(putCall).toBeDefined();
    const putHeaders = new Headers(
      (putCall?.[1] as RequestInit).headers as HeadersInit,
    );
    expect(putHeaders.get("X-Postwave-Client")).toBe("desktop");
    // Sanity: it really is the chunk-upload endpoint.
    expect(String(putCall?.[0])).toContain("/uploads/");
  });
});

describe("api-client campaign contracts", () => {
  it("threads stable page coordinates and the exact count proof through one abort scope", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        const body = url.endsWith("/count")
          ? { total: 137, by_status: { draft: 137 } }
          : [];
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );
    const controller = new AbortController();

    const page = await api.listCampaigns(
      { page: 2, perPage: 100 },
      { signal: controller.signal },
    );
    const count = await api.countCampaigns({ signal: controller.signal });

    expect(page.error).toBeUndefined();
    expect(count.data?.total).toBe(137);
    expect(calls.map((call) => call.url)).toEqual([
      "http://localhost:8080/api/v1/campaigns?page=2&per_page=100",
      "http://localhost:8080/api/v1/campaigns/count",
    ]);
    expect(calls.every((call) => call.init.signal !== undefined)).toBe(true);
  });

  it("posts campaign drafts with only fields accepted by campaigns.CreateInput", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return new Response(
          JSON.stringify({
            id: "campaign-1",
            name: "July launch",
            subject: "A considered subject",
            status: "draft",
          }),
          { status: 201, headers: { "Content-Type": "application/json" } },
        );
      }),
    );

    const response = await api.createCampaign({
      name: "July launch",
      subject: "A considered subject",
      from_email: "  sender@example.test  ",
      body: "<p>Hello</p>",
      preview_text: "A concise preview",
    });

    expect(response.error).toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("http://localhost:8080/api/v1/campaigns");
    expect(calls[0].init.method).toBe("POST");
    expect(JSON.parse(calls[0].init.body as string)).toEqual({
      name: "July launch",
      subject: "A considered subject",
      body_html: "<p>Hello</p>",
      preview_text: "A concise preview",
      delivery_settings: { from_email: "sender@example.test" },
    });
    expect(JSON.parse(calls[0].init.body as string)).not.toHaveProperty(
      "status",
    );
  });
});

describe("api-client abort signal", () => {
  it("exposes exact final response headers to endpoint-specific validators", async () => {
    const observed: Array<{ etag: string | null; fallback: string | null }> =
      [];
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("{}", {
            status: 200,
            headers: {
              "Content-Type": "application/json",
              ETag: '"agency-branding:tenant:v1"',
              "X-Resource-Version": "generic-fallback",
            },
          }),
      ),
    );

    await apiRequest(
      "/api/v1/forms",
      {},
      {
        onResponseHeaders: (headers) => {
          observed.push({
            etag: headers.get("etag"),
            fallback: headers.get("x-resource-version"),
          });
        },
      },
    );

    expect(observed).toEqual([
      {
        etag: '"agency-branding:tenant:v1"',
        fallback: "generic-fallback",
      },
    ]);
  });

  it("treats a caller abort as terminal — no retry, distinct code, no throw", async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      if (init.signal?.aborted) {
        throw new DOMException("Aborted", "AbortError");
      }
      return new Response("{}", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const ctrl = new AbortController();
    ctrl.abort();
    const r = await apiRequest("/api/v1/forms", {}, { signal: ctrl.signal });

    expect(r.error).toMatchObject({ kind: "network", code: "aborted" });
    // Terminal: exactly one wire attempt, no backoff retries.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("threads {signal} through the five mention-search list wrappers", async () => {
    // PostwaveAI's @-mention search fans out to these five list
    // endpoints with the debounce effect's AbortController — a
    // superseded keystroke must cancel the in-flight sweep instead of
    // letting it ride the network to completion (audit gap B9).
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      if (init.signal?.aborted) {
        throw new DOMException("Aborted", "AbortError");
      }
      return new Response("[]", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const ctrl = new AbortController();
    ctrl.abort();
    const results = await Promise.all([
      api.listCampaigns({ perPage: 40 }, { signal: ctrl.signal }),
      api.listSubscribers({ query: "x", perPage: 30 }, { signal: ctrl.signal }),
      api.listSequences({ signal: ctrl.signal }),
      api.listCampaignTemplates({ query: "x" }, { signal: ctrl.signal }),
      api.listForms({ signal: ctrl.signal }),
    ]);

    for (const r of results) {
      expect(r.error).toMatchObject({ kind: "network", code: "aborted" });
    }
    // One terminal wire attempt per wrapper — no retries past an abort.
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it("the five wrappers still resolve normally without a signal", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response("[]", {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const [campaigns, sequences, forms] = await Promise.all([
      api.listCampaigns({ perPage: 5 }),
      api.listSequences(),
      api.listForms(),
    ]);
    expect(campaigns.error).toBeUndefined();
    expect(sequences.error).toBeUndefined();
    expect(forms.error).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

describe("api-client new backend wrappers (2026-06)", () => {
  function jsonFetchMock(
    handler: (
      url: string,
      init: RequestInit,
    ) => { status: number; body: unknown },
  ) {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const mock = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      const { status, body } = handler(url, init);
      return new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", mock);
    return { calls, mock };
  }

  it("addMembers posts {subscriber_ids} and rejects >1000 ids locally", async () => {
    const { calls } = jsonFetchMock(() => ({
      status: 200,
      body: { added: 2, skipped: 1 },
    }));

    const ok = await listsExtendedApi.addMembers(7, ["s1", "s2", "s3"]);
    expect(ok.data).toEqual({ added: 2, skipped: 1 });
    expect(calls[0].url).toBe(
      "http://localhost:8080/api/v1/lists/7/subscribers",
    );
    expect(JSON.parse(calls[0].init.body as string)).toEqual({
      subscriber_ids: ["s1", "s2", "s3"],
    });

    const tooMany = await listsExtendedApi.addMembers(
      7,
      Array.from({ length: 1001 }, (_, i) => `s${i}`),
    );
    expect(tooMany.error?.kind).toBe("invalid_config");
    expect(calls).toHaveLength(1); // the oversized batch never hit the wire
  });

  it("removeMember resolves a 204 delete", async () => {
    const urls: string[] = [];
    const fetchMock = vi.fn(async (url: string) => {
      urls.push(url);
      return new Response(null, { status: 204 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const r = await listsExtendedApi.removeMember("list_1", "sub/9");
    expect(r.error).toBeUndefined();
    expect(urls[0]).toBe(
      "http://localhost:8080/api/v1/lists/list_1/subscribers/sub%2F9",
    );
  });

  it("listsExtendedApi.suppressions paginates the per-list surface", async () => {
    const { calls } = jsonFetchMock(() => ({
      status: 200,
      body: { items: [], total: 0, page: 2, per_page: 50 },
    }));
    const r = await listsExtendedApi.suppressions(3, { page: 2, perPage: 50 });
    expect(r.error).toBeUndefined();
    expect(calls[0].url).toBe(
      "http://localhost:8080/api/v1/lists/3/suppressions?page=2&per_page=50",
    );
  });

  it("converged suppression get uses the email= exact filter", async () => {
    const { calls } = jsonFetchMock(() => ({
      status: 200,
      body: {
        items: [
          {
            id: "sup_1",
            email: "a@b.co",
            reason: "hard_bounce",
            source: "ses",
            created_at: "2026-06-01T00:00:00Z",
          },
        ],
        total: 1,
        page: 1,
        size: 1,
      },
    }));

    const r = await suppressionsConvergedApi.get("a@b.co");
    expect(r.data?.id).toBe("sup_1");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain("email=a%40b.co");
    expect(calls[0].url).toContain("size=1");
  });

  it("converged suppression get falls back to the budgeted scan on 400", async () => {
    const { calls } = jsonFetchMock((url) => {
      if (url.includes("email=")) {
        return { status: 400, body: { error: { message: "unknown param" } } };
      }
      return {
        status: 200,
        body: {
          items: [
            {
              id: "sup_2",
              email: "A@B.CO",
              reason: "manual_unsubscribe",
              source: "manual",
              created_at: "2026-06-01T00:00:00Z",
            },
          ],
          total: 1,
          page: 1,
          size: 200,
        },
      };
    });

    const r = await suppressionsConvergedApi.get("a@b.co");
    expect(r.data?.id).toBe("sup_2");
    // First call carried the filter and 400'd; the scan page followed.
    expect(calls.length).toBe(2);
    expect(calls[1].url).not.toContain("email=");
  });

  it("suppression trend + bulk endpoints follow the converged wire shapes", async () => {
    const { calls } = jsonFetchMock((url) => {
      if (url.includes("/trend")) {
        return {
          status: 200,
          body: {
            points: [
              { date: "2026-06-09", count: 3, by_reason: { hard_bounce: 3 } },
            ],
            days: 30,
          },
        };
      }
      return {
        status: 200,
        body: { deleted_count: 2, errors: [], blocked: ["sup_9"] },
      };
    });

    const trend = await suppressionsApi.trend({ days: 30 });
    expect(trend.data?.days).toBe(30);
    expect(calls[0].url).toContain("/api/v1/suppressions/trend?days=30");

    const del = await suppressionsApi.bulkDelete({
      emails: ["a@b.co"],
      force: false,
    });
    expect(del.data).toEqual({
      deleted_count: 2,
      errors: [],
      blocked: ["sup_9"],
    });
    expect(JSON.parse(calls[1].init.body as string)).toEqual({
      emails: ["a@b.co"],
      force: false,
    });
  });

  it("suppression mirror folds a 503 into a not_configured result", async () => {
    jsonFetchMock(() => ({
      status: 503,
      body: {
        error: {
          code: "not_configured",
          message: "sendgrid credentials missing",
          provider: "sendgrid",
          not_configured: true,
          not_configured_reason: "No SendGrid API key on this tenant.",
        },
      },
    }));

    const r = await suppressionsApi.mirror("sendgrid");
    expect(r.error).toBeUndefined();
    expect(r.data).toMatchObject({
      provider: "sendgrid",
      not_configured: true,
      not_configured_reason: "No SendGrid API key on this tenant.",
    });
  });

  it("getAuditEventsByIds joins ids and enforces the 100-id cap locally", async () => {
    const { calls } = jsonFetchMock(() => ({
      status: 200,
      body: { items: [] },
    }));

    const r = await api.getAuditEventsByIds([1, 2, "3"]);
    expect(r.data).toEqual({ items: [] });
    expect(calls[0].url).toBe(
      "http://localhost:8080/api/v1/audit/events?ids=1%2C2%2C3",
    );

    const over = await api.getAuditEventsByIds(
      Array.from({ length: 101 }, (_, i) => i),
    );
    expect(over.error?.kind).toBe("invalid_config");
    expect(calls).toHaveLength(1);

    const empty = await api.getAuditEventsByIds([]);
    expect(empty.data).toEqual({ items: [] });
    expect(calls).toHaveLength(1);
  });

  it("draftSequence posts the brief to the voice draft endpoint", async () => {
    const { calls } = jsonFetchMock(() => ({
      status: 200,
      body: {
        name: "Welcome flow",
        steps: [{ subject: "Hi", body: "…", delay_hours: 0, position: 1 }],
      },
    }));

    const r = await api.draftSequence({
      brief: "welcome new users",
      step_count: 3,
    });
    expect(r.data?.steps).toHaveLength(1);
    expect(calls[0].url).toBe(
      "http://localhost:8080/api/v1/voice/sequences/draft",
    );
    expect(JSON.parse(calls[0].init.body as string)).toEqual({
      brief: "welcome new users",
      step_count: 3,
    });
  });

  it("referral payout wrappers hit the payouts surface", async () => {
    const { calls } = jsonFetchMock((_url, init) => {
      if ((init.method ?? "GET") === "PATCH") {
        return {
          status: 200,
          body: {
            id: "pay_1",
            referrer_id: "sub_1",
            milestone: 5,
            reward_label: "Sticker pack",
            status: "approved",
            created_at: "2026-06-01T00:00:00Z",
            updated_at: "2026-06-10T00:00:00Z",
          },
        };
      }
      return { status: 200, body: { items: [], total: 0 } };
    });

    const list = await api.listReferralPayouts({
      status: "pending",
      limit: 20,
    });
    expect(list.data).toEqual({ items: [], total: 0 });
    expect(calls[0].url).toContain(
      "/api/v1/referrals/payouts?status=pending&limit=20",
    );

    const patched = await api.updateReferralPayout("pay_1", "approved");
    expect(patched.data?.status).toBe("approved");
    expect(calls[1].url).toContain("/api/v1/referrals/payouts/pay_1");
    expect(JSON.parse(calls[1].init.body as string)).toEqual({
      status: "approved",
    });
  });

  it("resumeMigration posts to the resume route", async () => {
    const { calls } = jsonFetchMock(() => ({
      status: 202,
      body: { job_id: "job_1", status: "queued" },
    }));

    const r = await api.resumeMigration("job_1");
    expect(r.data).toEqual({ job_id: "job_1", status: "queued" });
    expect(calls[0].url).toBe(
      "http://localhost:8080/api/v1/migrations/job_1/resume",
    );
    expect(calls[0].init.method).toBe("POST");
  });

  it("verifies migration source capabilities without collapsing malformed payloads to empty", async () => {
    const capability = {
      source: "mailchimp",
      auth_method: "oauth2",
      supports: { subscribers: true, automation_mode: "rebuild_review" },
    };
    const payloads: unknown[] = [
      [capability],
      { items: [] },
      { items: [capability, { source: "missing-auth-method" }, null] },
      {},
    ];
    const { calls } = jsonFetchMock(() => ({
      status: 200,
      body: payloads.shift(),
    }));

    expect(await api.listMigrationSources()).toEqual({ data: [capability] });
    expect(await api.listMigrationSources()).toEqual({ data: [] });
    expect(await api.listMigrationSources()).toMatchObject({
      error: {
        kind: "parse",
        code: "migration_sources_invalid_item",
      },
    });
    expect(await api.listMigrationSources()).toMatchObject({
      error: {
        kind: "parse",
        code: "migration_sources_invalid_envelope",
      },
    });
    expect(calls.map((call) => call.url)).toEqual([
      "http://localhost:8080/api/v1/migrations/sources",
      "http://localhost:8080/api/v1/migrations/sources",
      "http://localhost:8080/api/v1/migrations/sources",
      "http://localhost:8080/api/v1/migrations/sources",
    ]);
  });

  it("listSequenceParticipants forwards filters and surfaces retryable 503 as an error", async () => {
    const { calls } = jsonFetchMock((url) => {
      if (url.includes("status=completed")) {
        return {
          status: 200,
          body: { items: [], total: 0, page: 1, per_page: 25 },
        };
      }
      return {
        status: 503,
        body: { error: { message: "database unavailable" } },
      };
    });

    const ok = await api.listSequenceParticipants("seq_1", {
      status: "completed",
      page: 1,
      perPage: 25,
    });
    expect(ok.data).toEqual({ items: [], total: 0, page: 1, per_page: 25 });
    expect(calls[0].url).toContain(
      "/api/v1/voice/sequences/seq_1/participants?status=completed&page=1&per_page=25",
    );

    const unavailable = await api.listSequenceParticipants("seq_1");
    expect(unavailable.error?.status).toBe(503);
    expect(isSequenceParticipantsUnavailable(unavailable.error)).toBe(false);
  });
});

describe("api-client full-surface wiring wrappers (2026-06-11)", () => {
  function jsonFetchMock(
    handler: (
      url: string,
      init: RequestInit,
    ) => { status: number; body: unknown },
  ) {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const mock = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      const { status, body } = handler(url, init);
      return new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", mock);
    return { calls, mock };
  }

  it("emailBlocksApi.compose posts the block list and returns MJML", async () => {
    const { calls } = jsonFetchMock(() => ({
      status: 200,
      body: { mjml: "<mjml/>", warnings: [] },
    }));
    const brand = {
      primary_color: "#111111",
      body_font: "Inter",
      heading_font: "Inter",
      background_color: "#ffffff",
    };
    const r = await emailBlocksApi.compose({
      brand,
      blocks: [{ block_id: "hero_text", config: { headline: "Hi" } }],
      subject: "Hello",
    });
    expect(r.data?.mjml).toBe("<mjml/>");
    expect(calls[0].url).toBe(
      "http://localhost:8080/api/v1/email-blocks/compose",
    );
    expect(JSON.parse(calls[0].init.body as string)).toMatchObject({
      brand,
      blocks: [{ block_id: "hero_text" }],
      subject: "Hello",
    });
  });

  it("sendWindowApi.check posts {scheduled_at} to the /check route", async () => {
    const { calls } = jsonFetchMock(() => ({
      status: 200,
      body: {
        inside_window: false,
        enforcement: "block",
        should: "block",
        reason: "outside window",
      },
    }));
    const r = await sendWindowApi.check("2026-06-12T03:00:00Z");
    expect(r.data?.should).toBe("block");
    expect(calls[0].url).toBe("http://localhost:8080/api/v1/send-window/check");
    expect(JSON.parse(calls[0].init.body as string)).toEqual({
      scheduled_at: "2026-06-12T03:00:00Z",
    });
  });

  it("translationsApi.preview posts body+locale exactly once (LLM opts)", async () => {
    const { mock, calls } = jsonFetchMock(() => ({
      status: 200,
      body: {
        body: "Hola",
        locale: "es",
        cache_hit: false,
        dictionary_matches: 0,
        skipped: false,
      },
    }));
    const r = await translationsApi.preview({ body: "Hello", locale: "es" });
    expect(r.data?.locale).toBe("es");
    expect(calls[0].url).toBe(
      "http://localhost:8080/api/v1/translations/preview",
    );
    expect(JSON.parse(calls[0].init.body as string)).toEqual({
      body: "Hello",
      locale: "es",
    });
    // maxAttempts:1 — exactly one wire attempt even though POST.
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it("linkCheckerApi.check resolves the bare-array verdict list", async () => {
    const { calls } = jsonFetchMock(() => ({
      status: 200,
      body: [{ url: "https://a.example", status: 200, ok: true }],
    }));
    const r = await linkCheckerApi.check("camp/1");
    expect(r.data).toEqual([
      { url: "https://a.example", status: 200, ok: true },
    ]);
    expect(calls[0].url).toBe(
      "http://localhost:8080/api/v1/campaigns/camp%2F1/check-links",
    );
    expect(calls[0].init.method).toBe("POST");
  });

  it("utmTemplatesApi.preview posts {url, campaign_id}", async () => {
    const { calls } = jsonFetchMock(() => ({
      status: 200,
      body: {
        original: "https://x.example",
        rewritten: "https://x.example?utm_source=newsletter",
        template: { id: "t1", is_default: true, enabled: true },
      },
    }));
    const r = await utmTemplatesApi.preview({
      url: "https://x.example",
      campaign_id: "c1",
    });
    expect(r.data?.rewritten).toContain("utm_source=");
    expect(calls[0].url).toBe(
      "http://localhost:8080/api/v1/utm-templates/preview",
    );
    expect(JSON.parse(calls[0].init.body as string)).toEqual({
      url: "https://x.example",
      campaign_id: "c1",
    });
  });

  it("holdoutApi create + lift compose the campaign-scoped paths", async () => {
    const { calls } = jsonFetchMock((url) => {
      if (url.endsWith("/lift")) {
        return {
          status: 200,
          body: { campaign_id: "c1", percent: 10, status: "pending" },
        };
      }
      return {
        status: 201,
        body: { campaign_id: "c1", percent: 10, seed: "abc" },
      };
    });
    const created = await holdoutApi.create("c1", 10);
    expect(created.data?.seed).toBe("abc");
    expect(calls[0].url).toBe(
      "http://localhost:8080/api/v1/campaigns/c1/holdout",
    );
    expect(JSON.parse(calls[0].init.body as string)).toEqual({ percent: 10 });

    const lift = await holdoutApi.lift("c1");
    expect(lift.data?.status).toBe("pending");
    expect(calls[1].url).toBe(
      "http://localhost:8080/api/v1/campaigns/c1/holdout/lift",
    );
  });

  it("controlGroupsApi.report forwards the ?window= query", async () => {
    const { calls } = jsonFetchMock(() => ({
      status: 200,
      body: {
        group_id: "g1",
        window_days: 14,
        control_size: 100,
        treated_size: 900,
        control_engagement_rate: 0.1,
        treated_engagement_rate: 0.2,
        incremental_lift: 0.1,
        generated_at: "2026-06-11T00:00:00Z",
      },
    }));
    const r = await controlGroupsApi.report("g1", 14);
    expect(r.data?.window_days).toBe(14);
    expect(calls[0].url).toBe(
      "http://localhost:8080/api/v1/control-groups/g1/report?window=14",
    );
  });

  it("subscriberNotesApi.create posts under the subscriber path", async () => {
    const { calls } = jsonFetchMock(() => ({
      status: 201,
      body: { id: "note_1" },
    }));
    const r = await subscriberNotesApi.create(42, {
      body: "VIP — replied personally",
      pinned: true,
    });
    expect(r.data?.id).toBe("note_1");
    expect(calls[0].url).toBe(
      "http://localhost:8080/api/v1/subscribers/42/notes",
    );
    expect(JSON.parse(calls[0].init.body as string)).toEqual({
      body: "VIP — replied personally",
      pinned: true,
    });
  });

  it("sunsetApi.previewReengagement keeps the camelCase wire shape", async () => {
    const { calls } = jsonFetchMock(() => ({
      status: 200,
      body: {
        subject: "We miss you",
        preheader: "p",
        bodyText: "t",
        bodyHtml: "<p/>",
        primaryCta: "Stay subscribed",
        candidateCount: 120,
        variant: "casual",
      },
    }));
    const r = await sunsetApi.previewReengagement({
      brand: { WorkspaceName: "Acme", Tone: "casual" },
      candidateCount: 120,
      variant: "casual",
    });
    expect(r.data?.candidateCount).toBe(120);
    expect(calls[0].url).toBe(
      "http://localhost:8080/api/v1/sunset/reengagement/preview",
    );
    expect(JSON.parse(calls[0].init.body as string)).toEqual({
      brand: { WorkspaceName: "Acme", Tone: "casual" },
      candidateCount: 120,
      variant: "casual",
    });
  });

  it("zeroCopyTriggersApi.retryDLQ composes the nested entry path", async () => {
    const { calls } = jsonFetchMock(() => ({
      status: 202,
      body: { id: 7, status: "pending" },
    }));
    const r = await zeroCopyTriggersApi.retryDLQ("trig_1", 7);
    expect(r.data?.status).toBe("pending");
    expect(calls[0].url).toBe(
      "http://localhost:8080/api/v1/zero-copy-triggers/trig_1/dlq/7/retry",
    );
    expect(calls[0].init.method).toBe("POST");
  });

  it("omnichannelApi.validate wraps the body in {campaign}", async () => {
    const { calls } = jsonFetchMock(() => ({
      status: 200,
      body: { valid: true, supported_paths: 1 },
    }));
    const r = await omnichannelApi.validate({
      name: "Promo",
      paths: [{ path_key: "email", name: "Email", channel: "email" }],
    });
    expect(r.data?.valid).toBe(true);
    expect(calls[0].url).toBe(
      "http://localhost:8080/api/v1/omnichannel/validate",
    );
    expect(JSON.parse(calls[0].init.body as string)).toEqual({
      campaign: {
        name: "Promo",
        paths: [{ path_key: "email", name: "Email", channel: "email" }],
      },
    });
  });

  it("conversionsApi.list sends the deterministic timestamp and ID cursor pair", async () => {
    const { calls } = jsonFetchMock(() => ({ status: 200, body: [] }));
    const first = await conversionsApi.list();
    const next = await conversionsApi.list({
      before: "2026-06-01T00:00:00Z",
      beforeId: 771,
    });
    expect(first.data).toEqual([]);
    expect(next.data).toEqual([]);
    expect(calls[0].url).toBe("http://localhost:8080/api/v1/conversions");
    expect(calls[1].url).toBe(
      "http://localhost:8080/api/v1/conversions?before=2026-06-01T00%3A00%3A00Z&before_id=771",
    );
  });

  it("conversionsApi wires the private ingest-secret register, issue, and revoke routes", async () => {
    const { calls } = jsonFetchMock((url, init) => {
      if ((init.method ?? "GET") === "GET") {
        return { status: 200, body: { items: [] } };
      }
      if (url.endsWith("/revoke")) {
        return { status: 200, body: { revoked: true } };
      }
      return {
        status: 201,
        body: {
          secret: {
            key_id: "key/id",
            label: "Production checkout",
            created_at: "2026-08-30T10:00:00Z",
            secret: "shown-once",
            identity_projection_status: "pending",
            identity_projection_updated_at: "2026-08-30T10:00:00Z",
          },
          notice: "Only shown once.",
        },
      };
    });

    await conversionsApi.listIngestSecrets();
    await conversionsApi.listIngestSecrets("next/opaque+cursor==");
    await conversionsApi.issueIngestSecret("Production checkout");
    await conversionsApi.revokeIngestSecret("key/id");

    expect(calls.map(({ url }) => url)).toEqual([
      "http://localhost:8080/api/v1/conversions/ingest-secrets?limit=100",
      "http://localhost:8080/api/v1/conversions/ingest-secrets?limit=100&cursor=next%2Fopaque%2Bcursor%3D%3D",
      "http://localhost:8080/api/v1/conversions/ingest-secrets",
      "http://localhost:8080/api/v1/conversions/ingest-secrets/key%2Fid/revoke",
    ]);
    expect(calls.map(({ init }) => init.method ?? "GET")).toEqual([
      "GET",
      "GET",
      "POST",
      "POST",
    ]);
    expect(calls.every(({ init }) => init.cache === "no-store")).toBe(true);
    expect(JSON.parse(String(calls[2]?.init.body))).toEqual({
      label: "Production checkout",
    });
    expect(
      new Headers(calls[2]?.init.headers).get("Idempotency-Key"),
    ).toBeNull();
  });

  it("commerceApi.listCartRecoveryLinks forwards status + cursor pagination", async () => {
    const { calls } = jsonFetchMock(() => ({
      status: 200,
      body: { items: [], next_cursor: "next/opaque+cursor==" },
    }));
    const r = await commerceApi.listCartRecoveryLinks("int_1", {
      status: "active",
      cursor: "current/opaque+cursor==",
      limit: 25,
    });
    expect(r.data?.next_cursor).toBe("next/opaque+cursor==");
    expect(calls[0].url).toBe(
      "http://localhost:8080/api/v1/commerce/integrations/int_1/cart-recovery-links?status=active&limit=25&cursor=current%2Fopaque%2Bcursor%3D%3D",
    );
  });

  it("commerceApi facade composes the extracted Shopify OAuth route", async () => {
    const { calls } = jsonFetchMock(() => ({
      status: 200,
      body: {
        provider: "shopify",
        shop_domain: "shop / one",
        authorize_url: "https://accounts.example.test/authorize",
        state: "state_1",
        scopes: [],
        local: false,
      },
    }));

    const result = await commerceApi.startShopifyOAuth("shop / one");

    expect(result.data?.provider).toBe("shopify");
    expect(calls[0].url).toBe(
      "http://localhost:8080/api/v1/commerce/shopify/oauth/start?shop=shop%20%2F%20one",
    );
    expect(new Headers(calls[0].init.headers).get("X-Postwave-Client")).toBe(
      "desktop",
    );
  });

  it("commerceApi.disconnectIntegration returns provider cleanup evidence", async () => {
    const { calls } = jsonFetchMock(() => ({
      status: 200,
      body: {
        ok: true,
        provider_cleanup: {
          provider: "stripe",
          status: "operator_action_required",
          postwave_status: "disconnected",
          provider_cleanup_posture: "operator_managed_stripe_dashboard",
          managed_provider_cleanup: false,
          provider_scope_type: "stripe_account_id",
          provider_scope_id: "acct_123",
          credential_ref_present: true,
          webhook_secret_ref_present: true,
          webhook_cleanup_status:
            "operator_delete_or_disable_stripe_webhook_endpoint",
          credential_cleanup_status:
            "operator_revoke_or_rotate_stripe_restricted_key",
        },
      },
    }));
    const r = await commerceApi.disconnectIntegration("int_1");
    expect(r.data?.ok).toBe(true);
    expect(r.data?.provider_cleanup?.provider_cleanup_posture).toBe(
      "operator_managed_stripe_dashboard",
    );
    expect(r.data?.provider_cleanup?.credential_ref_present).toBe(true);
    expect(r.data?.provider_cleanup?.webhook_cleanup_status).toBe(
      "operator_delete_or_disable_stripe_webhook_endpoint",
    );
    expect(calls[0].url).toBe(
      "http://localhost:8080/api/v1/commerce/integrations/int_1",
    );
    expect(calls[0].init.method).toBe("DELETE");
  });

  it("crmIntegrationsApi.disconnect returns provider cleanup evidence", async () => {
    const { calls } = jsonFetchMock(() => ({
      status: 200,
      body: {
        ok: true,
        provider_cleanup: {
          provider: "hubspot",
          status: "operator_action_required",
          postwave_status: "disconnected",
          provider_cleanup_posture:
            "mixed_postwave_oauth_operator_hubspot_console",
          managed_provider_cleanup: false,
          provider_scope_type: "hubspot_portal_id",
          provider_scope_id: "123",
          credential_ref_present: true,
          webhook_cleanup_status:
            "app_level_webhook_subscription_shared_no_per_tenant_cleanup",
          credential_cleanup_status:
            "operator_revoke_or_rotate_hubspot_private_app_token_if_no_longer_used",
        },
      },
    }));
    const r = await crmIntegrationsApi.disconnect("crm_1");
    expect(r.data?.ok).toBe(true);
    expect(r.data?.provider_cleanup?.provider_cleanup_posture).toBe(
      "mixed_postwave_oauth_operator_hubspot_console",
    );
    expect(r.data?.provider_cleanup?.credential_ref_present).toBe(true);
    expect(calls[0].url).toBe(
      "http://localhost:8080/api/v1/crm/integrations/crm_1",
    );
    expect(calls[0].init.method).toBe("DELETE");
  });

  it("reviewIntegrationsApi.acknowledgeProviderCleanup posts operator evidence", async () => {
    const { calls } = jsonFetchMock(() => ({
      status: 200,
      body: {
        ok: true,
        provider_cleanup: {
          provider: "yotpo",
          status: "operator_acknowledged",
          acknowledged_by: "ops@example.com",
          completed_actions: ["app_secret_or_api_credentials_rotated"],
        },
      },
    }));

    const r = await reviewIntegrationsApi.acknowledgeProviderCleanup(
      "review/1",
      {
        completed_actions: ["app_secret_or_api_credentials_rotated"],
        notes: "Verified in Yotpo console.",
      },
    );

    expect(r.data?.provider_cleanup?.status).toBe("operator_acknowledged");
    expect(calls[0].url).toBe(
      "http://localhost:8080/api/v1/review-integrations/review%2F1/provider-cleanup/acknowledge",
    );
    expect(calls[0].init.method).toBe("POST");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      completed_actions: ["app_secret_or_api_credentials_rotated"],
      notes: "Verified in Yotpo console.",
    });
  });

  it("subscriptionIntegrationsApi.acknowledgeProviderCleanup posts Recharge operator evidence", async () => {
    const { calls } = jsonFetchMock(() => ({
      status: 200,
      body: {
        ok: true,
        provider_cleanup: {
          provider: "recharge",
          status: "operator_acknowledged",
          acknowledged_by: "ops@example.com",
          completed_actions: ["api_token_revoked_or_rotated"],
        },
      },
    }));

    const r = await subscriptionIntegrationsApi.acknowledgeProviderCleanup(
      "subscription/1",
      {
        completed_actions: ["api_token_revoked_or_rotated"],
        notes: "Verified in Recharge console.",
      },
    );

    expect(r.data?.provider_cleanup?.status).toBe("operator_acknowledged");
    expect(calls[0].url).toBe(
      "http://localhost:8080/api/v1/subscription-integrations/subscription%2F1/provider-cleanup/acknowledge",
    );
    expect(calls[0].init.method).toBe("POST");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      completed_actions: ["api_token_revoked_or_rotated"],
      notes: "Verified in Recharge console.",
    });
  });

  it("warehouseApi.acknowledgeProviderCleanup posts Snowflake operator evidence", async () => {
    const { calls } = jsonFetchMock(() => ({
      status: 200,
      body: {
        ok: true,
        id: "warehouse/1",
        previous_version: 4,
        version: 5,
      },
    }));

    const r = await warehouseApi.acknowledgeProviderCleanup("warehouse/1", {
      expected_version: 4,
      completed_actions: ["snowflake_roles_or_grants_removed"],
      notes: "Verified in Snowflake console.",
    });

    expect(r.data).toEqual({
      ok: true,
      id: "warehouse/1",
      previous_version: 4,
      version: 5,
    });
    expect(calls[0].url).toBe(
      "http://localhost:8080/api/v1/warehouse/connections/warehouse%2F1/provider-cleanup/acknowledge",
    );
    expect(calls[0].init.method).toBe("POST");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      expected_version: 4,
      completed_actions: ["snowflake_roles_or_grants_removed"],
      notes: "Verified in Snowflake console.",
    });
  });

  it("crmIntegrationsApi exposes managed CRM OAuth availability and start URLs", async () => {
    const { calls } = jsonFetchMock(() => ({
      status: 200,
      body: {
        available: true,
        configured: true,
        requires_session: true,
        start_url: "/api/v1/crm/salesforce/oauth/start",
      },
    }));

    const availability =
      await crmIntegrationsApi.oauthAvailability("salesforce");
    const start = crmIntegrationsApi.oauthStartUrl("salesforce", {
      name: "Salesforce production",
      org_id: "00Dxx",
      sync_tasks: false,
      redirect_to: "/app/integrations",
    });

    expect(availability.data?.available).toBe(true);
    expect(calls[0].url).toBe(
      "http://localhost:8080/api/v1/crm/salesforce/oauth/availability",
    );
    expect(start).toBe(
      "http://localhost:8080/api/v1/crm/salesforce/oauth/start?name=Salesforce+production&org_id=00Dxx&sync_tasks=false&redirect_to=%2Fapp%2Fintegrations",
    );
  });

  it("diagnosticianApi.diagnose posts to the proxied gateway path once", async () => {
    const { mock, calls } = jsonFetchMock(() => ({
      status: 200,
      body: {
        campaign_id: "c9",
        diagnosis: "## Looks fine",
        fixes: [],
        predicted_impact: {},
        generated_at: "2026-06-11T00:00:00Z",
      },
    }));
    const r = await diagnosticianApi.diagnose("c9", { domain: "mail.acme.io" });
    expect(r.data?.diagnosis).toContain("Looks fine");
    expect(calls[0].url).toBe("http://localhost:8080/api/v1/diagnose/c9");
    expect(JSON.parse(calls[0].init.body as string)).toEqual({
      domain: "mail.acme.io",
    });
    // LLM_REQUEST_OPTS: one attempt only.
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it("blocklistAutoSuppressApi.set PATCHes the flag", async () => {
    const { calls } = jsonFetchMock(() => ({
      status: 200,
      body: {
        auto_suppress: true,
        eligible_now: 2,
        active_suppressions: 3,
        observed_at: "2026-07-17T12:00:00Z",
      },
    }));
    const r = await blocklistAutoSuppressApi.set(true);
    expect(r.data?.auto_suppress).toBe(true);
    expect(calls[0].url).toBe(
      "http://localhost:8080/api/v1/blocklist/auto-suppress",
    );
    expect(calls[0].init.method).toBe("PATCH");
    expect(JSON.parse(calls[0].init.body as string)).toEqual({
      auto_suppress: true,
    });
  });

  it("featureFlagsApi.resolve hits the per-key resolve route", async () => {
    const { calls } = jsonFetchMock(() => ({
      status: 200,
      body: { key: "new_editor", value: "on", source: "tenant" },
    }));
    const r = await featureFlagsApi.resolve("new_editor");
    expect(r.data?.source).toBe("tenant");
    expect(calls[0].url).toBe(
      "http://localhost:8080/api/v1/feature-flags/new_editor/resolve",
    );
  });

  it("regionsApi uses the public non-/api/v1 paths", async () => {
    const { calls } = jsonFetchMock((url) => {
      if (url.endsWith("/current")) {
        return {
          status: 200,
          body: {
            region: "eu-central-1",
            is_eu: true,
            is_us: false,
            sdk_host: "api.eu.moosewave.com",
            postmark_base: "",
            mailgun_base: "",
            ses_region: "eu-central-1",
          },
        };
      }
      return { status: 200, body: { regions: [] } };
    });
    const cur = await regionsApi.current();
    expect(cur.data?.region).toBe("eu-central-1");
    expect(calls[0].url).toBe("http://localhost:8080/api/regions/current");
    const all = await regionsApi.list();
    expect(all.data?.regions).toEqual([]);
    expect(calls[1].url).toBe("http://localhost:8080/api/regions");
  });

  it("searchApi.global encodes q, forwards limit, and threads {signal}", async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      if (init.signal?.aborted) {
        throw new DOMException("Aborted", "AbortError");
      }
      return new Response(JSON.stringify({ query: "vip list", results: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const ok = await searchApi.global("vip list", { limit: 5 });
    expect(ok.data).toEqual({ query: "vip list", results: [] });
    expect(fetchMock.mock.calls[0][0]).toBe(
      "http://localhost:8080/api/v1/search?q=vip+list&limit=5",
    );

    const ctrl = new AbortController();
    ctrl.abort();
    const aborted = await searchApi.global("x", { signal: ctrl.signal });
    expect(aborted.error).toMatchObject({ kind: "network", code: "aborted" });
    // Terminal abort: exactly one extra wire attempt.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("api-client product events", () => {
  it("loads tenant-wide product events without a subscriber id", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(url);
        return new Response(JSON.stringify({ items: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );

    const r = await api.listProductEvents({
      limit: 25,
      before: "2026-05-19T00:00:00Z",
    });

    expect(r.error).toBeUndefined();
    expect(calls[0]).toContain("/api/v1/track/events");
    expect(calls[0]).toContain("limit=25");
    expect(calls[0]).toContain("before=2026-05-19T00");
    expect(calls[0]).not.toContain("subscriber_id=");
  });
});
