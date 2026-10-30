import { describe, expect, it } from "vitest";

import { api } from "../../lib/api-client";
import {
  createAuditOperationsMethods,
  decodeAuditCountPayload,
  decodeAuditListPayload,
  decodeMyAuditScopesPayload,
  decodeAuditSavedViewFilters,
  decodeAuditSavedViewsPayload,
  decodeAuditSsePayload,
  decodeAuditStatsPayload,
  isAuditIsoInstant,
  serializeAuditQuery,
  type AuditOperationsDependencies,
  type AuditOperationsRequester,
} from "../../lib/api/audit-operations";
import type { ApiErr, ApiResult } from "../../lib/api/result";

interface RequestCall {
  path: string;
  init: RequestInit | undefined;
  opts: AuditOperationsDependencies["llmRequestOptions"] | undefined;
}

interface NativeCall {
  input: string | URL | Request;
  init: RequestInit | undefined;
}

const LLM_OPTIONS = { timeoutMs: 60_000, maxAttempts: 1 } as const;

const METHOD_NAMES = [
  "listAudit",
  "getAuditStats",
  "getAuditAnomalyScore",
  "getAuditRecentAnomalies",
  "auditExportUrl",
  "auditExportUrlAuthed",
  "auditExportManifestsList",
  "apiAuditNLQ",
  "apiAuditNLQCostStatus",
  "getMyAuditScopes",
  "listRoles",
  "updateRoleScopes",
  "auditStreamUrl",
  "auditStreamUrlAuthed",
  "auditInvestigationStreamUrlAuthed",
  "listAuditSavedViews",
  "createAuditSavedView",
  "updateAuditSavedView",
  "deleteAuditSavedView",
  "getAuditRetention",
  "setAuditRetention",
  "listRetentionActivity",
  "setEventRetentionOverride",
  "createAuditPortalSession",
  "listAuditPortalSessions",
  "revokeAuditPortalSession",
  "getInclusionProof",
  "auditSessionReplay",
  "investigateAuditEvent",
  "listAuditInvestigations",
  "getAuditInvestigation",
  "approveAuditInvestigation",
  "rejectAuditInvestigation",
  "downloadAIVSBundle",
  "auditUnmaskPII",
  "getAuditRedactionPolicy",
  "putAuditRedactionPolicy",
  "getConsistencyProof",
  "getLatestAuditCheckpoint",
  "getAuditChain",
] as const;

function createHarness(
  options: {
    responses?: ApiResult<unknown>[];
    nativeResponses?: Array<Response | Error>;
    apiKey?: string | null;
    normalizedApiKey?: string | null;
  } = {},
) {
  const calls: RequestCall[] = [];
  const streamPaths: string[] = [];
  const nativeCalls: NativeCall[] = [];
  const controllerParents: Array<AbortSignal | null | undefined> = [];
  const state = { disposeCount: 0, errorResponseCount: 0 };
  const responses = [...(options.responses ?? [])];
  const nativeResponses = [...(options.nativeResponses ?? [])];
  const controller = new AbortController();
  const request: AuditOperationsRequester = async <T>(
    path: string,
    init?: RequestInit,
    opts?: AuditOperationsDependencies["llmRequestOptions"],
  ): Promise<ApiResult<T>> => {
    calls.push({ path, init, opts });
    return (responses.shift() ?? { data: {} }) as ApiResult<T>;
  };
  const dependencies: AuditOperationsDependencies = {
    request,
    getApiUrl: () => "https://api.example.test",
    buildStreamUrl: async (path) => {
      streamPaths.push(path);
      return `stream:${path}`;
    },
    createDownloadController: (parent) => {
      controllerParents.push(parent);
      return {
        signal: controller.signal,
        dispose: () => {
          state.disposeCount += 1;
        },
      };
    },
    getApiKey: () =>
      "apiKey" in options ? (options.apiKey ?? null) : "raw-key",
    normalizeApiKey: () =>
      "normalizedApiKey" in options
        ? (options.normalizedApiKey ?? null)
        : "normalized-key",
    nativeAwareFetch: async (input, init) => {
      nativeCalls.push({ input, init });
      const next = nativeResponses.shift();
      if (next instanceof Error) throw next;
      return (
        next ??
        new Response("bundle", {
          status: 200,
          headers: {
            "Content-Disposition": 'attachment; filename="audit-bundle.tar.gz"',
          },
        })
      );
    },
    apiUrl: (path) => `https://api.example.test${path}`,
    errorFromResponse: async (response) => {
      state.errorResponseCount += 1;
      return {
        kind: "http",
        status: response.status,
        message: `HTTP ${response.status}`,
      };
    },
    transportError: (error) => ({
      kind: "network",
      message: error instanceof Error ? error.message : String(error),
    }),
    llmRequestOptions: LLM_OPTIONS,
  };
  return {
    calls,
    controller,
    controllerParents,
    methods: createAuditOperationsMethods(dependencies),
    nativeCalls,
    state,
    streamPaths,
  };
}

function validAuditRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 101,
    action: "campaign.pause",
    resourceType: "campaign",
    resourceId: "campaign-42",
    actorType: "human",
    actorLabel: "Ada Lovelace",
    metadata: { reason: "operator_request" },
    at: "2026-08-12T10:30:00.123Z",
    ...overrides,
  };
}

function validAuditStats() {
  return {
    totalEvents: 3,
    byActorType: [
      { label: "human", count: 2 },
      { label: "agent", count: 1 },
    ],
    topActions: [
      { label: "campaign.pause", count: 2 },
      { label: "campaign.resume", count: 1 },
    ],
    daily: [
      { date: "2026-08-11", count: 1 },
      { date: "2026-08-12", count: 2 },
    ],
  };
}

describe("audit operations API extraction contracts", () => {
  it("retains the exact 40-method named inventory on the factory and facade", () => {
    const {
      calls,
      controllerParents,
      methods,
      nativeCalls,
      state,
      streamPaths,
    } = createHarness();

    expect(Object.keys(methods)).toEqual(METHOD_NAMES);
    for (const name of METHOD_NAMES) {
      expect(typeof methods[name]).toBe("function");
      expect(methods[name].name).toBe(name);
      expect(typeof api[name]).toBe("function");
      expect(api[name].name).toBe(name);
    }
    expect(calls).toEqual([]);
    expect(streamPaths).toEqual([]);
    expect(nativeCalls).toEqual([]);
    expect(controllerParents).toEqual([]);
    expect(state).toEqual({ disposeCount: 0, errorResponseCount: 0 });
  });

  it("preserves audit listing, analytics, export, and manifest transports", async () => {
    const { calls, methods, streamPaths } = createHarness();
    const filters = {
      actorType: "agent",
      actorLabel: "Ada Lovelace",
      action: "subscriber.update",
      resourceType: "subscriber/profile",
      resourceId: "sub/one",
      since: "2026-07-15T10:00:00Z",
    };

    await methods.listAudit({ ...filters, cursor: "cursor/one", limit: 25 });
    await methods.getAuditStats(filters);
    await methods.getAuditAnomalyScore(42);
    await methods.getAuditRecentAnomalies();
    expect(methods.auditExportUrl({ ...filters, limit: 1_000 })).toBe(
      "https://api.example.test/api/v1/audit/export?actor_type=agent&actor_label=Ada+Lovelace&action=subscriber.update&resource_type=subscriber%2Fprofile&resource_id=sub%2Fone&since=2026-07-15T10%3A00%3A00Z&limit=1000",
    );
    await expect(
      methods.auditExportUrlAuthed({
        ...filters,
        limit: 500,
        includeManifest: true,
      }),
    ).resolves.toBe(
      "stream:/api/v1/audit/export?actor_type=agent&actor_label=Ada+Lovelace&action=subscriber.update&resource_type=subscriber%2Fprofile&resource_id=sub%2Fone&since=2026-07-15T10%3A00%3A00Z&limit=500&include_manifest=true",
    );
    await methods.auditExportManifestsList(10);

    expect(streamPaths).toEqual([
      "/api/v1/audit/export?actor_type=agent&actor_label=Ada+Lovelace&action=subscriber.update&resource_type=subscriber%2Fprofile&resource_id=sub%2Fone&since=2026-07-15T10%3A00%3A00Z&limit=500&include_manifest=true",
    ]);
    expect(calls).toEqual([
      {
        path: "/api/v1/audit?actor_type=agent&actor_label=Ada+Lovelace&action=subscriber.update&resource_type=subscriber%2Fprofile&resource_id=sub%2Fone&since=2026-07-15T10%3A00%3A00Z&cursor=cursor%2Fone&limit=25",
        init: undefined,
        opts: undefined,
      },
      {
        path: "/api/v1/audit/stats?actor_type=agent&actor_label=Ada+Lovelace&action=subscriber.update&resource_type=subscriber%2Fprofile&resource_id=sub%2Fone&since=2026-07-15T10%3A00%3A00Z",
        init: undefined,
        opts: undefined,
      },
      {
        path: "/api/v1/audit/42/anomaly-score",
        init: undefined,
        opts: undefined,
      },
      {
        path: "/api/v1/audit/anomalies/recent?limit=5",
        init: undefined,
        opts: undefined,
      },
      {
        path: "/api/v1/audit/export/manifests?limit=10",
        init: undefined,
        opts: undefined,
      },
    ]);
  });

  it("preserves NLQ request policy and audit RBAC contracts", async () => {
    const { calls, methods } = createHarness();

    await methods.apiAuditNLQ("who changed subscriber one?");
    await methods.apiAuditNLQCostStatus();
    await methods.getMyAuditScopes();
    await methods.listRoles();
    await methods.updateRoleScopes("role/one", [
      "audit:read",
      "audit:read_pii",
    ]);

    expect(calls).toEqual([
      {
        path: "/api/v1/audit/nlq",
        init: {
          method: "POST",
          body: JSON.stringify({ query: "who changed subscriber one?" }),
        },
        opts: LLM_OPTIONS,
      },
      {
        path: "/api/v1/audit/nlq/cost-status",
        init: undefined,
        opts: undefined,
      },
      {
        path: "/api/v1/audit/my-scopes",
        init: undefined,
        opts: undefined,
      },
      {
        path: "/api/v1/roles",
        init: undefined,
        opts: undefined,
      },
      {
        path: "/api/v1/roles/role%2Fone/scopes",
        init: {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ scopes: ["audit:read", "audit:read_pii"] }),
        },
        opts: undefined,
      },
    ]);
  });

  it("preserves streams, saved views, retention, and per-event overrides", async () => {
    const { calls, methods, streamPaths } = createHarness();

    expect(methods.auditStreamUrl()).toBe(
      "https://api.example.test/api/v1/audit/stream",
    );
    await expect(
      methods.auditStreamUrlAuthed({
        actorType: "human",
        actorLabel: "Ada",
        action: "login",
        resourceType: "session",
        resourceId: "session/one",
        since: "2026-07-15T00:00:00Z",
      }),
    ).resolves.toBe(
      "stream:/api/v1/audit/stream?actor_type=human&actor_label=Ada&action=login&resource_type=session&resource_id=session%2Fone&since=2026-07-15T00%3A00%3A00Z",
    );
    await expect(
      methods.auditInvestigationStreamUrlAuthed("investigation/one"),
    ).resolves.toBe(
      "stream:/api/v1/audit/investigations/investigation%2Fone/stream",
    );
    await methods.listAuditSavedViews();
    await methods.createAuditSavedView({
      name: "High risk",
      description: "Agent events",
      filters: { actorType: "agent" },
    });
    await methods.updateAuditSavedView("view/one", {
      name: "Critical risk",
      filters: { category: "destructive" },
    });
    await methods.deleteAuditSavedView("view/one");
    await methods.getAuditRetention();
    await methods.setAuditRetention(null);
    await methods.listRetentionActivity({ limit: 30 });
    await methods.setEventRetentionOverride("event/one", {
      retention_override_days: 365,
      legal_hold: true,
    });

    expect(streamPaths).toEqual([
      "/api/v1/audit/stream?actor_type=human&actor_label=Ada&action=login&resource_type=session&resource_id=session%2Fone&since=2026-07-15T00%3A00%3A00Z",
      "/api/v1/audit/investigations/investigation%2Fone/stream",
    ]);
    expect(calls).toEqual([
      {
        path: "/api/v1/audit/saved-views",
        init: undefined,
        opts: undefined,
      },
      {
        path: "/api/v1/audit/saved-views",
        init: {
          method: "POST",
          body: JSON.stringify({
            name: "High risk",
            description: "Agent events",
            filters: { actorType: "agent" },
          }),
        },
        opts: undefined,
      },
      {
        path: "/api/v1/audit/saved-views/view%2Fone",
        init: {
          method: "PATCH",
          body: JSON.stringify({
            name: "Critical risk",
            filters: { category: "destructive" },
          }),
        },
        opts: undefined,
      },
      {
        path: "/api/v1/audit/saved-views/view%2Fone",
        init: { method: "DELETE" },
        opts: undefined,
      },
      {
        path: "/api/v1/audit/retention",
        init: undefined,
        opts: undefined,
      },
      {
        path: "/api/v1/audit/retention",
        init: { method: "PUT", body: JSON.stringify({ retentionDays: null }) },
        opts: undefined,
      },
      {
        path: "/api/v1/audit/retention-activity?limit=30",
        init: undefined,
        opts: undefined,
      },
      {
        path: "/api/v1/audit/event%2Fone/retention-override",
        init: {
          method: "PATCH",
          body: JSON.stringify({
            retention_override_days: 365,
            legal_hold: true,
          }),
        },
        opts: undefined,
      },
    ]);
  });

  it("preserves portal, proof, replay, and investigation transports", async () => {
    const { calls, methods } = createHarness();

    await methods.createAuditPortalSession();
    await methods.listAuditPortalSessions();
    await methods.revokeAuditPortalSession("portal/one");
    await methods.getInclusionProof("event/one");
    await methods.auditSessionReplay("event/one");
    await methods.investigateAuditEvent("event/one", 45);
    await methods.listAuditInvestigations({
      status: "draft/review",
      limit: 20,
    });
    await methods.getAuditInvestigation("investigation/one");
    await methods.approveAuditInvestigation("investigation/one");
    await methods.rejectAuditInvestigation("investigation/one", "Needs review");

    expect(calls).toEqual([
      {
        path: "/api/v1/audit/portal/sessions",
        init: { method: "POST", body: JSON.stringify({}) },
        opts: undefined,
      },
      {
        path: "/api/v1/audit/portal/sessions",
        init: undefined,
        opts: undefined,
      },
      {
        path: "/api/v1/audit/portal/sessions/portal%2Fone",
        init: { method: "DELETE" },
        opts: undefined,
      },
      {
        path: "/api/v1/audit/event%2Fone/inclusion-proof",
        init: undefined,
        opts: undefined,
      },
      {
        path: "/api/v1/audit/event%2Fone/session-replay",
        init: undefined,
        opts: undefined,
      },
      {
        path: "/api/v1/audit/event%2Fone/investigate?context_window_minutes=45",
        init: { method: "POST" },
        opts: LLM_OPTIONS,
      },
      {
        path: "/api/v1/audit/investigations?status=draft%2Freview&limit=20",
        init: undefined,
        opts: undefined,
      },
      {
        path: "/api/v1/audit/investigations/investigation%2Fone",
        init: undefined,
        opts: undefined,
      },
      {
        path: "/api/v1/audit/investigations/investigation%2Fone/approve",
        init: {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ notes: "" }),
        },
        opts: undefined,
      },
      {
        path: "/api/v1/audit/investigations/investigation%2Fone/reject",
        init: {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reason: "Needs review" }),
        },
        opts: undefined,
      },
    ]);
  });

  it("preserves PII-redaction and Merkle-integrity contracts", async () => {
    const { calls, methods } = createHarness();
    const policy = {
      defaultRedactedFields: ["email"],
      jsonpathRules: [
        { path: "$.email", action: "encrypt" as const },
        { path: "$.phone", action: "mask" as const },
      ],
      updatedAt: "2026-07-16T00:00:00Z",
    };

    await methods.auditUnmaskPII("event/one", "Customer request");
    await methods.getAuditRedactionPolicy();
    await methods.putAuditRedactionPolicy(policy);
    await methods.getConsistencyProof(10, 25);
    await methods.getLatestAuditCheckpoint();

    expect(calls).toEqual([
      {
        path: "/api/v1/audit/event%2Fone/unmask",
        init: {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reason: "Customer request" }),
        },
        opts: undefined,
      },
      {
        path: "/api/v1/audit/redaction-policies",
        init: undefined,
        opts: undefined,
      },
      {
        path: "/api/v1/audit/redaction-policies",
        init: {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(policy),
        },
        opts: undefined,
      },
      {
        path: "/api/v1/audit/consistency-proof?from=10&to=25",
        init: undefined,
        opts: undefined,
      },
      {
        path: "/api/v1/audit/checkpoint/latest",
        init: undefined,
        opts: undefined,
      },
    ]);
  });

  it("preserves authenticated AIVS download success and disposal semantics", async () => {
    const parent = new AbortController();
    const { controller, controllerParents, methods, nativeCalls, state } =
      createHarness();

    const result = await methods.downloadAIVSBundle("session/one", {
      signal: parent.signal,
    });

    expect(result.error).toBeUndefined();
    expect(result.data?.filename).toBe("audit-bundle.tar.gz");
    expect(await result.data?.blob.text()).toBe("bundle");
    expect(controllerParents).toEqual([parent.signal]);
    expect(state.disposeCount).toBe(1);
    expect(nativeCalls).toHaveLength(1);
    expect(nativeCalls[0]?.input).toBe(
      "https://api.example.test/api/v1/audit/ai-session/session%2Fone/aivs-bundle",
    );
    expect(nativeCalls[0]?.init).toEqual({
      method: "GET",
      headers: {
        Accept: "application/gzip",
        Authorization: "Bearer normalized-key",
      },
      mode: "cors",
      credentials: "include",
      cache: "no-store",
      signal: controller.signal,
    });
  });

  it("preserves AIVS HTTP, fallback-filename, and transport-error branches", async () => {
    const forbidden = createHarness({
      nativeResponses: [new Response("forbidden", { status: 403 })],
    });
    await expect(
      forbidden.methods.downloadAIVSBundle("session/one"),
    ).resolves.toEqual({
      error: { kind: "http", status: 403, message: "HTTP 403" },
    });
    expect(forbidden.state.errorResponseCount).toBe(1);
    expect(forbidden.state.disposeCount).toBe(1);

    const noFilename = createHarness({
      nativeResponses: [new Response("bundle", { status: 200 })],
    });
    const fallback = await noFilename.methods.downloadAIVSBundle("session/one");
    expect(fallback.data?.filename).toMatch(
      /^postwave-aivs-session\/one-\d{4}-\d{2}-\d{2}\.tar\.gz$/,
    );
    expect(noFilename.state.disposeCount).toBe(1);

    const noKey = createHarness({ apiKey: null, normalizedApiKey: null });
    await noKey.methods.downloadAIVSBundle("session/one");
    expect(noKey.nativeCalls[0]?.init?.headers).toEqual({
      Accept: "application/gzip",
    });
    expect(noKey.state.disposeCount).toBe(1);

    const thrown = createHarness({
      nativeResponses: [new Error("native fetch failed")],
    });
    await expect(
      thrown.methods.downloadAIVSBundle("session/one"),
    ).resolves.toEqual({
      error: { kind: "network", message: "native fetch failed" },
    });
    expect(thrown.state.disposeCount).toBe(1);
  });

  it("keeps unrelated request failures unchanged", async () => {
    const failure: ApiErr = {
      error: { kind: "http", status: 500, message: "audit unavailable" },
    };
    const { methods } = createHarness({ responses: [failure] });

    await expect(methods.listAudit()).resolves.toEqual(failure);
  });
});

describe("audit runtime and query contracts", () => {
  it("decodes permission payloads strictly before any admin flag reaches the UI", async () => {
    const valid = {
      scopes: ["admin", "audit:read", "audit:read_pii"],
      auditScopes: ["audit:read", "audit:read_pii"],
      isAdmin: true,
    };
    expect(decodeMyAuditScopesPayload(valid)).toEqual(valid);
    expect(
      decodeMyAuditScopesPayload({ ...valid, isAdmin: "false" }),
    ).toBeNull();
    expect(decodeMyAuditScopesPayload({ ...valid, isAdmin: 1 })).toBeNull();
    expect(
      decodeMyAuditScopesPayload({
        ...valid,
        auditScopes: ["audit:read", "audit:future"],
      }),
    ).toBeNull();
    expect(
      decodeMyAuditScopesPayload({
        ...valid,
        scopes: ["admin", "audit:read"],
      }),
    ).toBeNull();

    const malformed = createHarness({
      responses: [{ data: { scopes: [], auditScopes: [], isAdmin: "yes" } }],
    });
    await expect(malformed.methods.getMyAuditScopes()).resolves.toMatchObject({
      error: { kind: "parse", code: "invalid_audit_payload" },
    });
  });

  it("serializes every shared audit filter once in deterministic snake_case order", () => {
    expect(
      serializeAuditQuery({
        resourceId: "sub/42",
        actorLabel: "Ada Lovelace",
        actorType: "human",
        since: "2026-08-01T00:00:00Z",
        action: "subscriber.update",
        resourceType: "subscriber",
        cursor: "cursor/one",
        limit: 50,
        includeManifest: true,
      }),
    ).toBe(
      "actor_type=human&actor_label=Ada+Lovelace&action=subscriber.update&resource_type=subscriber&resource_id=sub%2F42&since=2026-08-01T00%3A00%3A00Z&cursor=cursor%2Fone&limit=50&include_manifest=true",
    );
    expect(serializeAuditQuery({ actorType: "platform_operator" })).toBe(
      "actor_type=platform_operator",
    );
    expect(serializeAuditQuery({ actorType: "api_key" })).toBe(
      "action=postwave-invalid-query-7f16d6a8c0044ee5a1d80dfdc3d33b87",
    );
    expect(serializeAuditQuery({ action: "x".repeat(257) })).toBe(
      "action=postwave-invalid-query-7f16d6a8c0044ee5a1d80dfdc3d33b87",
    );
    expect(serializeAuditQuery({ actorLabel: "Ada\nAdmin" })).toBe(
      "action=postwave-invalid-query-7f16d6a8c0044ee5a1d80dfdc3d33b87",
    );
    expect(
      serializeAuditQuery({ action: "delete", future: true } as never),
    ).toBe("action=postwave-invalid-query-7f16d6a8c0044ee5a1d80dfdc3d33b87");
    const failClosedAction = new URLSearchParams(
      serializeAuditQuery({ actorLabel: "Ada\nAdmin" }),
    ).get("action");
    expect(failClosedAction).toMatch(/^[a-z0-9-]+$/u);
    expect(failClosedAction).not.toMatch(/[%_]/u);
  });

  it("forwards caller abort signals and decodes valid list and statistics bodies", async () => {
    const signal = new AbortController().signal;
    const list = { rows: [validAuditRow()], nextCursor: "100" };
    const stats = validAuditStats();
    const { calls, methods } = createHarness({
      responses: [{ data: list }, { data: stats }],
    });

    await expect(
      methods.listAudit({ actorType: "human" }, { signal }),
    ).resolves.toEqual({ data: list });
    await expect(
      methods.getAuditStats({ actorType: "human" }, { signal }),
    ).resolves.toEqual({ data: stats });
    expect(calls).toEqual([
      {
        path: "/api/v1/audit?actor_type=human",
        init: undefined,
        opts: { signal },
      },
      {
        path: "/api/v1/audit/stats?actor_type=human",
        init: undefined,
        opts: { signal },
      },
    ]);
  });

  it("rejects ambiguous envelopes, duplicate IDs, repeated cursors, and oversized pages", () => {
    const row = validAuditRow();
    expect(
      decodeAuditListPayload({ items: [row], next_cursor: "100" }),
    ).toEqual({ rows: [row], nextCursor: "100" });
    expect(decodeAuditListPayload({ rows: [row], items: [row] })).toBeNull();
    expect(
      decodeAuditListPayload({ rows: [row], nextCursor: "100" }, "100"),
    ).toBeNull();
    expect(
      decodeAuditListPayload({
        rows: [row, validAuditRow({ id: "101" })],
      }),
    ).toBeNull();
    expect(
      decodeAuditListPayload({ rows: [validAuditRow({ tenantId: "secret" })] }),
    ).toBeNull();
    expect(
      decodeAuditListPayload({
        rows: Array.from({ length: 501 }, (_, index) =>
          validAuditRow({ id: index + 1 }),
        ),
      }),
    ).toBeNull();
    expect(decodeAuditListPayload({ rows: [row], total: 1 })).toBeNull();
  });

  it("rejects impossible instants and bounded-row violations for list and SSE data", () => {
    expect(isAuditIsoInstant("2024-02-29T23:59:59.999Z")).toBe(true);
    expect(isAuditIsoInstant("2025-02-29T00:00:00Z")).toBe(false);
    expect(isAuditIsoInstant("2026-04-31T00:00:00Z")).toBe(false);
    expect(
      decodeAuditListPayload({
        rows: [validAuditRow({ at: "2026-02-30T00:00:00Z" })],
      }),
    ).toBeNull();
    expect(
      decodeAuditListPayload({
        rows: [validAuditRow({ metadata: { blob: "x".repeat(16_385) } })],
      }),
    ).toBeNull();
    expect(decodeAuditSsePayload(JSON.stringify(validAuditRow()))).toEqual(
      validAuditRow(),
    );
    expect(
      decodeAuditSsePayload(JSON.stringify(validAuditRow({ id: 0 }))),
    ).toBeNull();
    expect(decodeAuditSsePayload("{".repeat(128 * 1_024 + 1))).toBeNull();
  });

  it("validates statistics and count bodies as internally consistent exact shapes", () => {
    expect(decodeAuditStatsPayload(validAuditStats())).toEqual(
      validAuditStats(),
    );
    expect(
      decodeAuditStatsPayload({
        ...validAuditStats(),
        byActorType: [
          { label: "human", count: 2 },
          { label: "human", count: 1 },
        ],
      }),
    ).toBeNull();
    expect(
      decodeAuditStatsPayload({
        ...validAuditStats(),
        daily: [{ date: "2026-02-30", count: 3 }],
      }),
    ).toBeNull();
    expect(
      decodeAuditStatsPayload({ ...validAuditStats(), totalEvents: 4 }),
    ).toBeNull();
    expect(
      decodeAuditCountPayload({ totalEstimate: 42, confidence: "exact" }),
    ).toEqual({ totalEstimate: 42, confidence: "exact" });
    expect(
      decodeAuditCountPayload({
        totalEstimate: 42,
        confidence: "exact",
        total: 41,
      }),
    ).toBeNull();
    expect(
      decodeAuditCountPayload({
        totalEstimate: Number.MAX_SAFE_INTEGER + 1,
        confidence: "approximate",
      }),
    ).toBeNull();
  });

  it("accepts only the understood bounded saved-view filter schema", () => {
    const filters = {
      actorType: "agent",
      actorLabel: "Agent One",
      actionQuery: "campaign.pause",
      resourceType: "campaign",
      resourceId: "campaign-42",
      days: 30,
      category: "destructive",
      since: "2026-08-01T00:00:00Z",
      until: "2026-09-01T00:00:00Z",
    };
    expect(decodeAuditSavedViewFilters(filters)).toEqual(filters);
    expect(decodeAuditSavedViewFilters({ actorType: "user" })).toEqual({
      actorType: "human",
    });
    expect(decodeAuditSavedViewFilters({ ...filters, days: "30" })).toBeNull();
    expect(
      decodeAuditSavedViewFilters({
        ...filters,
        since: "2026-10-01T00:00:00Z",
      }),
    ).toBeNull();
    expect(
      decodeAuditSavedViewFilters({ ...filters, future: true }),
    ).toBeNull();
    expect(
      decodeAuditSavedViewsPayload({
        views: [
          {
            id: "view-1",
            name: "Agent changes",
            filters,
            createdAt: "2026-08-12T09:00:00Z",
            updatedAt: "2026-08-12T10:00:00Z",
          },
        ],
      }),
    ).not.toBeNull();
    expect(
      decodeAuditSavedViewsPayload({
        views: [
          {
            id: "view-1",
            name: "Agent changes",
            filters,
            createdAt: "2026-08-12T09:00:00Z",
            updatedAt: "2026-08-12T10:00:00Z",
            tenantId: "secret",
          },
        ],
      }),
    ).toBeNull();
    expect(
      decodeAuditSavedViewsPayload({
        views: [
          {
            id: "view-1",
            name: "One",
            filters: {},
            createdAt: "2026-08-12T09:00:00Z",
            updatedAt: "2026-08-12T10:00:00Z",
          },
          {
            id: "view-1",
            name: "Duplicate",
            filters: {},
            createdAt: "2026-08-12T09:00:00Z",
            updatedAt: "2026-08-12T10:00:00Z",
          },
        ],
      }),
    ).toBeNull();
  });

  it("turns malformed successful bodies into parse errors without changing transport errors", async () => {
    const transportFailure: ApiErr = {
      error: { kind: "http", status: 503, message: "Unavailable" },
    };
    const { methods } = createHarness({
      responses: [
        { data: { rows: "nope" } },
        { data: { totalEvents: 1 } },
        { data: { views: "nope" } },
        transportFailure,
      ],
    });
    await expect(methods.listAudit()).resolves.toMatchObject({
      error: { kind: "parse", code: "invalid_audit_payload" },
    });
    await expect(methods.getAuditStats()).resolves.toMatchObject({
      error: { kind: "parse", code: "invalid_audit_payload" },
    });
    await expect(methods.listAuditSavedViews()).resolves.toMatchObject({
      error: { kind: "parse", code: "invalid_audit_payload" },
    });
    await expect(methods.listAudit()).resolves.toEqual(transportFailure);
  });

  it("refuses unbounded saved-view writes before transport", async () => {
    const { calls, methods } = createHarness();
    await expect(
      methods.createAuditSavedView({ name: "x".repeat(257), filters: {} }),
    ).resolves.toMatchObject({
      error: { kind: "parse", code: "invalid_audit_payload" },
    });
    await expect(
      methods.updateAuditSavedView("x".repeat(129), { name: "Valid" }),
    ).resolves.toMatchObject({
      error: { kind: "parse", code: "invalid_audit_payload" },
    });
    expect(calls).toEqual([]);
  });
});
