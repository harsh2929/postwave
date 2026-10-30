import { describe, expect, it } from "vitest";

import { api } from "../../lib/api-client";
import {
  createConsentPrivacyOperationsMethods,
  type ConsentPrivacyOperationsDependencies,
  type ConsentPrivacyRequester,
  type ConsentPrivacyRequestOptions,
} from "../../lib/api/consent-privacy-operations";
import type { ApiErr, ApiResult } from "../../lib/api/result";

interface RequestCall {
  path: string;
  init: RequestInit | undefined;
  opts: ConsentPrivacyRequestOptions | undefined;
}

interface NativeCall {
  input: string | URL | Request;
  init: RequestInit | undefined;
}

const METHOD_NAMES = [
  "listConsentReceipts",
  "getConsentReceiptsByEmail",
  "listConsentEvents",
  "getSubscriberTrackingPrefs",
  "patchSubscriberTrackingPrefs",
  "listPrivacyIncidents",
  "getPrivacyIncident",
  "createPrivacyIncident",
  "transitionPrivacyIncident",
  "signoffPrivacyIncident",
  "recordPrivacyIncidentNotification",
  "listPrivacyIncidentEvents",
  "downloadPrivacyIncidentPacket",
] as const;

const METHOD_NAME_SET = new Set<string>(METHOD_NAMES);
const CONSENT_WORKSPACE_ID = "33333333-3333-4333-8333-333333333333";
const CONSENT_SNAPSHOT = "2026-08-20T10:00:00.000000Z";

function consentReceipt(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: "42",
    kind: "receipt",
    subscriber_email: "reader@example.com",
    new_state: "subscribed",
    source: "form:newsletter",
    at: "2026-08-20T09:00:00.000000Z",
    recorded_at: "2026-08-20T09:00:01.000000Z",
    ...overrides,
  };
}

function consentReceiptPage(
  receipts: Record<string, unknown>[] = [consentReceipt()],
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schema_version: 1,
    workspace_id: CONSENT_WORKSPACE_ID,
    snapshot_at: CONSENT_SNAPSHOT,
    source_planes: ["consent_receipts", "consent_records"],
    receipts,
    count: receipts.length,
    has_more: false,
    ...overrides,
  };
}

function consentEvent(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: "44444444-4444-4444-8444-444444444444",
    decision_id: "55555555-5555-4555-8555-555555555555",
    subject_type: "visitor",
    subject_id: "visitor_0123456789",
    channel: "web",
    category: "marketing",
    action: "denied",
    source: "gpc",
    policy_version: "privacy-v3",
    preferences: { gpc: true },
    created_at: "2026-08-20T08:59:00.000000Z",
    recorded_at: "2026-08-20T09:00:00.000000Z",
    ...overrides,
  };
}

function consentEventPage(
  events: Record<string, unknown>[] = [consentEvent()],
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schema_version: 1,
    workspace_id: CONSENT_WORKSPACE_ID,
    snapshot_at: CONSENT_SNAPSHOT,
    source_planes: ["consent_events"],
    events,
    count: events.length,
    has_more: false,
    ...overrides,
  };
}

function trackingConsent(subscriberId: string) {
  return {
    subscriber_id: subscriberId,
    subscriber_email: "reader@example.com",
    open_opt_out_at: null,
    click_opt_out_at: null,
    effective_open_opt_out: false,
    effective_click_opt_out: false,
    source: "admin",
    gpc: false,
    policy_version: "privacy-v2",
    updated_at: "2026-07-19T01:02:03.000Z",
  };
}

function privacyIncident(id = "11111111-1111-4111-8111-111111111111") {
  return {
    id,
    severity: "critical" as const,
    status: "open" as const,
    detected_at: "2026-07-16T08:00:00Z",
    discovered_at: "2026-07-16T08:05:00Z",
    clock_started_at: "2026-07-16T08:00:00Z",
    gdpr_72h_deadline: "2026-07-19T08:00:00Z",
    template_version: "2026-06",
    affected_regions: ["EU"],
    affected_data_categories: ["email"],
    affected_subject_count: 42,
    notification_decisions: {},
    jurisdictions: ["GDPR"],
    summary: "Customer export exposure",
    created_at: "2026-07-16T08:00:00Z",
    updated_at: "2026-07-16T08:05:00Z",
  };
}

const jurisdictionReference = {
  code: "GDPR",
  name: "EU GDPR",
};

function privacyIncidentDetail(id = "11111111-1111-4111-8111-111111111111") {
  return {
    ...privacyIncident(id),
    jurisdiction_resolution: {
      status: "release_held" as const,
      release_hold_code: "jurisdiction_rules_release_hold" as const,
      recognized: [jurisdictionReference],
    },
  };
}

function createHarness(
  options: {
    responses?: ApiResult<unknown>[];
    nativeResponses?: Array<Response | Error>;
    nativeImplementation?: (
      input: string | URL | Request,
      init?: RequestInit,
    ) => Promise<Response>;
    apiKey?: string | null;
    normalizedApiKey?: string | null;
    linkParentSignal?: boolean;
  } = {},
) {
  const calls: RequestCall[] = [];
  const nativeCalls: NativeCall[] = [];
  const controllerParents: Array<AbortSignal | null | undefined> = [];
  const apiPaths: string[] = [];
  const normalizedApiKeyInputs: Array<string | null | undefined> = [];
  const state = {
    disposeCount: 0,
    errorResponseCount: 0,
    getApiKeyCount: 0,
    transportErrorCount: 0,
  };
  const responses = [...(options.responses ?? [])];
  const nativeResponses = [...(options.nativeResponses ?? [])];
  const controller = new AbortController();
  const request: ConsentPrivacyRequester = async <T>(
    path: string,
    init?: RequestInit,
    opts?: ConsentPrivacyRequestOptions,
  ): Promise<ApiResult<T>> => {
    calls.push({ path, init, opts });
    return (responses.shift() ?? { data: {} }) as ApiResult<T>;
  };
  const dependencies: ConsentPrivacyOperationsDependencies = {
    request,
    createDownloadController: (parent) => {
      controllerParents.push(parent);
      let unlinkParent: (() => void) | undefined;
      if (options.linkParentSignal && parent) {
        const abortFromParent = (): void => controller.abort(parent.reason);
        if (parent.aborted) abortFromParent();
        else {
          parent.addEventListener("abort", abortFromParent, { once: true });
          unlinkParent = () =>
            parent.removeEventListener("abort", abortFromParent);
        }
      }
      return {
        signal: controller.signal,
        dispose: () => {
          unlinkParent?.();
          state.disposeCount += 1;
        },
      };
    },
    getApiKey: () => {
      state.getApiKeyCount += 1;
      return "apiKey" in options ? (options.apiKey ?? null) : "raw-key";
    },
    normalizeApiKey: (key) => {
      normalizedApiKeyInputs.push(key);
      return "normalizedApiKey" in options
        ? (options.normalizedApiKey ?? null)
        : "normalized-key";
    },
    nativeAwareFetch: async (input, init) => {
      nativeCalls.push({ input, init });
      if (options.nativeImplementation) {
        return options.nativeImplementation(input, init);
      }
      const next = nativeResponses.shift();
      if (next instanceof Error) throw next;
      return (
        next ??
        new Response("# Incident packet\n", {
          status: 200,
          headers: {
            "Content-Disposition":
              'attachment; filename="incident-authority.md"',
          },
        })
      );
    },
    apiUrl: (path) => {
      apiPaths.push(path);
      return `https://api.example.test${path}`;
    },
    errorFromResponse: async (response) => {
      state.errorResponseCount += 1;
      return {
        kind: "http",
        status: response.status,
        message: `HTTP ${response.status}`,
      };
    },
    transportError: (error) => {
      state.transportErrorCount += 1;
      return {
        kind: "network",
        message: error instanceof Error ? error.message : String(error),
      };
    },
  };

  return {
    apiPaths,
    calls,
    controller,
    controllerParents,
    methods: createConsentPrivacyOperationsMethods(dependencies),
    nativeCalls,
    normalizedApiKeyInputs,
    state,
  };
}

describe("consent and privacy operations API extraction contracts", () => {
  it("retains the exact ordered 13-method inventory without eager work", () => {
    const harness = createHarness();

    expect(Object.keys(harness.methods)).toEqual(METHOD_NAMES);
    expect(
      Object.keys(api).filter((name) => METHOD_NAME_SET.has(name)),
    ).toEqual(METHOD_NAMES);
    for (const name of METHOD_NAMES) {
      expect(typeof harness.methods[name]).toBe("function");
      expect(harness.methods[name].name).toBe(name);
      expect(typeof api[name]).toBe("function");
      expect(api[name].name).toBe(name);
    }
    expect(harness.calls).toEqual([]);
    expect(harness.nativeCalls).toEqual([]);
    expect(harness.controllerParents).toEqual([]);
    expect(harness.apiPaths).toEqual([]);
    expect(harness.normalizedApiKeyInputs).toEqual([]);
    expect(harness.state).toEqual({
      disposeCount: 0,
      errorResponseCount: 0,
      getApiKeyCount: 0,
      transportErrorCount: 0,
    });
  });

  it("preserves consent receipt, event, and subscriber tracking transports", async () => {
    const { calls, methods } = createHarness();
    const subscriberId = "11111111-1111-4111-8111-111111111111";
    const trackingVersion = '"subscriber-tracking-consent:v1"';
    const trackingController = new AbortController();
    const trackingPatch = {
      open_opt_out: true,
      click_opt_out: false,
      source: "privacy center",
      policy_version: "2026/07",
      gpc: true,
    };

    await methods.listConsentReceipts({
      workspaceId: CONSENT_WORKSPACE_ID,
      since: "2026-07-15T10:00:00Z",
      limit: 25,
      source: "form/import",
      cursor: "receipt-page-2",
    });
    await methods.getConsentReceiptsByEmail("ada+test@example.com", {
      workspaceId: CONSENT_WORKSPACE_ID,
      limit: 10,
      cursor: "subject-page-2",
    });
    await methods.listConsentEvents({
      workspaceId: CONSENT_WORKSPACE_ID,
      limit: 50,
      subjectType: "visitor",
      category: "marketing",
      action: "denied",
      since: "2026-07-15T10:00:00Z",
      cursor: "event-page-2",
    });
    await methods.getSubscriberTrackingPrefs(subscriberId, {
      signal: trackingController.signal,
    });
    await methods.patchSubscriberTrackingPrefs(subscriberId, trackingPatch, {
      version: trackingVersion,
      signal: trackingController.signal,
    });

    expect(calls).toEqual([
      {
        path: "/api/v1/consent/receipts?since=2026-07-15T10%3A00%3A00Z&limit=25&source=form%2Fimport&cursor=receipt-page-2",
        init: undefined,
        opts: undefined,
      },
      {
        path: "/api/v1/consent/receipts/by-email/ada%2Btest%40example.com?limit=10&cursor=subject-page-2",
        init: undefined,
        opts: undefined,
      },
      {
        path: "/api/v1/consent/events?limit=50&subject_type=visitor&category=marketing&action=denied&since=2026-07-15T10%3A00%3A00Z&cursor=event-page-2",
        init: undefined,
        opts: undefined,
      },
      {
        path: `/api/v1/subscribers/${subscriberId}/tracking-consent`,
        init: undefined,
        opts: { signal: trackingController.signal },
      },
      {
        path: `/api/v1/subscribers/${subscriberId}/tracking-consent`,
        init: {
          method: "PATCH",
          headers: { "If-Match": trackingVersion },
          body: JSON.stringify(trackingPatch),
        },
        opts: {
          maxAttempts: 1,
          requireOnline: true,
          signal: trackingController.signal,
        },
      },
    ]);
  });

  it("rejects cross-subscriber consent and tracking responses", async () => {
    const subscriberId = "11111111-1111-4111-8111-111111111111";
    const otherSubscriberId = "22222222-2222-4222-8222-222222222222";
    const { methods } = createHarness({
      responses: [
        {
          data: consentReceiptPage(
            [consentReceipt({ subscriber_email: "other@example.com" })],
            { email: "reader@example.com" },
          ),
        },
        {
          data: trackingConsent(otherSubscriberId),
          serverVersion: '"subscriber-tracking-consent:other:v1"',
        },
        {
          data: trackingConsent(otherSubscriberId),
          serverVersion: '"subscriber-tracking-consent:other:v2"',
        },
      ],
    });

    const results = [
      await methods.getConsentReceiptsByEmail("reader@example.com", {
        workspaceId: CONSENT_WORKSPACE_ID,
      }),
      await methods.getSubscriberTrackingPrefs(subscriberId),
      await methods.patchSubscriberTrackingPrefs(
        subscriberId,
        { open_opt_out: true },
        { version: '"subscriber-tracking-consent:v1"' },
      ),
    ];
    for (const result of results) {
      const rejected = result as ApiErr;
      expect(rejected.error.code).toBe("subscriber_response_identity_mismatch");
      expect(rejected.error.kind).toBe("parse");
      expect(rejected.retryability).toBe("manual");
    }
  });

  it("fails closed before a tracking-consent write without an exact revision", async () => {
    const { calls, methods } = createHarness();

    for (const version of ["", "   ", "*"]) {
      const result = await methods.patchSubscriberTrackingPrefs(
        "11111111-1111-4111-8111-111111111111",
        { click_opt_out: true },
        { version },
      );
      expect(result).toMatchObject({
        error: {
          kind: "http",
          status: 428,
          code: "precondition_required",
        },
        retryability: "not-retryable",
      });
    }
    expect(calls).toEqual([]);
  });

  it("rejects tracking-consent reads and writes without a fresh response revision", async () => {
    const subscriberId = "11111111-1111-4111-8111-111111111111";
    const { calls, methods } = createHarness({
      responses: [
        { data: trackingConsent(subscriberId) },
        {
          data: trackingConsent(subscriberId),
          serverVersion: "   ",
        },
      ],
    });

    const read = (await methods.getSubscriberTrackingPrefs(
      subscriberId,
    )) as ApiErr;
    const write = (await methods.patchSubscriberTrackingPrefs(
      subscriberId,
      { click_opt_out: true },
      { version: '"subscriber-tracking-consent:v1"' },
    )) as ApiErr;

    for (const result of [read, write]) {
      expect(result).toMatchObject({
        error: {
          kind: "parse",
          code: "invalid_subscriber_response_contract",
        },
        retryability: "manual",
      });
    }
    expect(calls).toHaveLength(2);
  });

  it("rejects duplicate consent-receipt identities", async () => {
    const receipt = consentReceipt();
    const { methods } = createHarness({
      responses: [
        {
          data: consentReceiptPage([receipt, { ...receipt }], {
            email: "reader@example.com",
          }),
        },
      ],
    });

    const result = (await methods.getConsentReceiptsByEmail(
      "reader@example.com",
      { workspaceId: CONSENT_WORKSPACE_ID },
    )) as ApiErr;
    expect(result.error.code).toBe(
      "invalid_consent_evidence_response_contract",
    );
    expect(result.error.kind).toBe("parse");
  });

  it("accepts only versioned, workspace-bound receipt and event snapshots", async () => {
    const proof = consentReceipt({
      id: "66666666-6666-4666-8666-666666666666",
      kind: "proof",
      new_state: "granted",
      source: "double_optin",
      recorded_at: "2026-08-20T08:59:59.999999Z",
    });
    const receiptPage = consentReceiptPage([consentReceipt(), proof], {
      has_more: true,
      next_cursor: "receipt-page-2.signature-2",
    });
    const eventPage = consentEventPage([consentEvent()], {
      has_more: true,
      next_cursor: "event-page-2.signature-2",
    });
    const { methods } = createHarness({
      responses: [{ data: receiptPage }, { data: eventPage }],
    });

    await expect(
      methods.listConsentReceipts({ workspaceId: CONSENT_WORKSPACE_ID }),
    ).resolves.toEqual({ data: receiptPage });
    await expect(
      methods.listConsentEvents({ workspaceId: CONSENT_WORKSPACE_ID }),
    ).resolves.toEqual({ data: eventPage });
  });

  it.each([
    {
      name: "wrong workspace",
      page: consentReceiptPage(undefined, {
        workspace_id: "77777777-7777-4777-8777-777777777777",
      }),
    },
    {
      name: "unknown envelope member",
      page: consentReceiptPage(undefined, { total: 1 }),
    },
    {
      name: "page-local count mismatch",
      page: consentReceiptPage(undefined, { count: 99 }),
    },
    {
      name: "missing continuation cursor",
      page: consentReceiptPage(undefined, { has_more: true }),
    },
    {
      name: "non-canonical continuation cursor",
      page: consentReceiptPage(undefined, {
        has_more: true,
        next_cursor: "not=raw-url-safe",
      }),
    },
    {
      name: "unsigned continuation cursor",
      page: consentReceiptPage(undefined, {
        has_more: true,
        next_cursor: "unsigned-cursor",
      }),
    },
    {
      name: "cursor on a terminal page",
      page: consentReceiptPage(undefined, { next_cursor: "unexpected" }),
    },
    {
      name: "wrong source-plane declaration",
      page: consentReceiptPage(undefined, {
        source_planes: ["consent_records", "consent_receipts"],
      }),
    },
    {
      name: "row newer than the snapshot",
      page: consentReceiptPage([
        consentReceipt({ recorded_at: "2026-08-20T10:00:01.000000Z" }),
      ]),
    },
    {
      name: "out-of-order chronology",
      page: consentReceiptPage([
        consentReceipt({ id: "41", recorded_at: "2026-08-20T08:00:00Z" }),
        consentReceipt({ id: "40", recorded_at: "2026-08-20T09:00:00Z" }),
      ]),
    },
    {
      name: "unsafe bidi source",
      page: consentReceiptPage([consentReceipt({ source: "form\u202Eliame" })]),
    },
    {
      name: "uppercase proof identity",
      page: consentReceiptPage([
        consentReceipt({
          id: "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA",
          kind: "proof",
          new_state: "granted",
          source: "double_optin",
        }),
      ]),
    },
    {
      name: "byte-order mark in source detail",
      page: consentReceiptPage([
        consentReceipt({ source_detail: "form\uFEFFcapture" }),
      ]),
    },
    {
      name: "surrounding whitespace in source",
      page: consentReceiptPage([consentReceipt({ source: " form" })]),
    },
    {
      name: "source exceeding its UTF-8 byte budget",
      page: consentReceiptPage([consentReceipt({ source: "é".repeat(257) })]),
    },
  ])("rejects a $name receipt page", async ({ page }) => {
    const { methods } = createHarness({ responses: [{ data: page }] });

    const result = (await methods.listConsentReceipts({
      workspaceId: CONSENT_WORKSPACE_ID,
    })) as ApiErr;

    expect(result).toMatchObject({
      error: {
        kind: "parse",
        code: "invalid_consent_evidence_response_contract",
      },
      retryability: "manual",
    });
  });

  it.each([
    {
      name: "legacy numeric event id",
      page: consentEventPage([consentEvent({ id: 42 })]),
    },
    {
      name: "unknown event action",
      page: consentEventPage([consentEvent({ action: "accepted" })]),
    },
    {
      name: "event without a subject identity",
      page: consentEventPage([
        consentEvent({ subject_id: undefined, subject_email: undefined }),
      ]),
    },
    {
      name: "duplicate event identity",
      page: consentEventPage([consentEvent(), consentEvent()]),
    },
    {
      name: "out-of-order event chronology",
      page: consentEventPage([
        consentEvent({
          id: "88888888-8888-4888-8888-888888888888",
          recorded_at: "2026-08-20T08:00:00Z",
        }),
        consentEvent({
          id: "99999999-9999-4999-8999-999999999999",
          recorded_at: "2026-08-20T09:00:00Z",
        }),
      ]),
    },
    {
      name: "unsafe control in policy identity",
      page: consentEventPage([consentEvent({ policy_version: "v3\nforged" })]),
    },
    {
      name: "uppercase event identity",
      page: consentEventPage([
        consentEvent({ id: "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA" }),
      ]),
    },
    {
      name: "byte-order mark in proof text",
      page: consentEventPage([
        consentEvent({ proof_text: "accepted\uFEFFterms" }),
      ]),
    },
    {
      name: "surrounding whitespace in policy identity",
      page: consentEventPage([consentEvent({ policy_version: " privacy-v3" })]),
    },
    {
      name: "policy identity exceeding its UTF-8 byte budget",
      page: consentEventPage([
        consentEvent({ policy_version: "é".repeat(129) }),
      ]),
    },
  ])("rejects a $name event page", async ({ page }) => {
    const { methods } = createHarness({ responses: [{ data: page }] });

    const result = (await methods.listConsentEvents({
      workspaceId: CONSENT_WORKSPACE_ID,
    })) as ApiErr;

    expect(result).toMatchObject({
      error: {
        kind: "parse",
        code: "invalid_consent_evidence_response_contract",
      },
      retryability: "manual",
    });
  });

  it("fails locally without a canonical workspace identity", async () => {
    const { calls, methods } = createHarness();

    const [receipts, events] = await Promise.all([
      methods.listConsentReceipts({ workspaceId: "unresolved" }),
      methods.listConsentEvents({ workspaceId: "" }),
    ]);

    expect((receipts as ApiErr).error.kind).toBe("parse");
    expect((events as ApiErr).error.kind).toBe("parse");
    expect(calls).toEqual([]);
  });

  it("preserves the privacy incident queue, lifecycle, notification, and ledger transports", async () => {
    const { calls, methods } = createHarness();
    const incidentInput = {
      severity: "critical" as const,
      summary: "Customer export exposure",
      detected_at: "2026-07-16T08:00:00Z",
      affected_regions: ["EU", "CA-US"],
      affected_data_categories: ["email", "billing"],
      affected_subject_count: 42,
      jurisdictions: ["GDPR", "CA"],
    };
    const notificationInput = {
      audience: "data_subject" as const,
      template_key: "incident-v3",
      recipient_ref: "subscriber/one",
      body_sha256: "abc123",
    };

    await methods.listPrivacyIncidents();
    await methods.getPrivacyIncident("incident/one");
    await methods.createPrivacyIncident(incidentInput, {
      idempotencyKey: "incident-create-draft-1",
    });
    await methods.transitionPrivacyIncident(
      "incident/one",
      "notifications_pending",
      "Containment complete",
      "contained",
    );
    await methods.signoffPrivacyIncident("incident/one", {
      signoff_by: "counsel@example.com",
      notes: "Approved for release",
    });
    await methods.recordPrivacyIncidentNotification(
      "incident/one",
      notificationInput,
    );
    await methods.listPrivacyIncidentEvents("incident/one");

    expect(calls).toEqual([
      {
        path: "/api/v1/privacy/incidents",
        init: undefined,
        opts: undefined,
      },
      {
        path: "/api/v1/privacy/incidents/incident%2Fone",
        init: undefined,
        opts: undefined,
      },
      {
        path: "/api/v1/privacy/incidents",
        init: {
          method: "POST",
          headers: { "Idempotency-Key": "incident-create-draft-1" },
          body: JSON.stringify(incidentInput),
        },
        opts: undefined,
      },
      {
        path: "/api/v1/privacy/incidents/incident%2Fone/transition",
        init: {
          method: "POST",
          body: JSON.stringify({
            expected_from: "contained",
            to: "notifications_pending",
            reason: "Containment complete",
          }),
        },
        opts: undefined,
      },
      {
        path: "/api/v1/privacy/incidents/incident%2Fone/signoff",
        init: {
          method: "POST",
          body: JSON.stringify({
            signoff_by: "counsel@example.com",
            notes: "Approved for release",
          }),
        },
        opts: undefined,
      },
      {
        path: "/api/v1/privacy/incidents/incident%2Fone/notifications",
        init: { method: "POST", body: JSON.stringify(notificationInput) },
        opts: undefined,
      },
      {
        path: "/api/v1/privacy/incidents/incident%2Fone/events",
        init: undefined,
        opts: undefined,
      },
    ]);
  });

  it("validates complete active incident and ordered event response shapes", async () => {
    const incidentId = "11111111-1111-4111-8111-111111111111";
    const incident = {
      ...privacyIncident(incidentId),
      affected_subject_count: 0,
    };
    const detail = {
      ...privacyIncidentDetail(incidentId),
      affected_subject_count: 0,
    };
    const { calls, methods } = createHarness({
      responses: [
        {
          data: {
            incidents: [incident],
            known_jurisdictions: [jurisdictionReference],
            nextCursor: "eyJrIjoiMjAyNi0wNy0xNlQwODowMDowMFoiLCJpIjoiaWQifQ",
          },
        },
        { data: detail },
        { data: detail },
        {
          data: {
            incident_id: incidentId,
            from: "open",
            to: "contained",
            at: "2026-07-16T09:00:00Z",
          },
        },
        {
          data: {
            incident_id: incidentId,
            events: [
              {
                event_id: "33333333-3333-4333-8333-333333333333",
                source: "incident_state_transitions",
                schema_version: 1,
                kind: "transition",
                at: "2026-07-16T08:00:00Z",
                to_state: "open",
                reason: "incident opened",
              },
              {
                event_id: "44444444-4444-4444-8444-444444444444",
                source: "incident_notifications",
                schema_version: 1,
                kind: "notification",
                at: "2026-07-16T09:10:00Z",
                audience: "authority",
                template_key: "authority-v1",
              },
            ],
          },
        },
      ],
    });

    const results = [
      await methods.listPrivacyIncidents({ limit: 50, cursor: "cursor_value" }),
      await methods.getPrivacyIncident(incidentId),
      await methods.createPrivacyIncident(
        {
          severity: "critical",
          summary: "Customer export exposure",
        },
        { idempotencyKey: "incident-create-contract-test" },
      ),
      await methods.transitionPrivacyIncident(
        incidentId,
        "contained",
        "Contained",
        "open",
      ),
      await methods.listPrivacyIncidentEvents(incidentId),
    ];

    for (const result of results) expect(result.error).toBeUndefined();
    expect(calls[0]?.path).toBe(
      "/api/v1/privacy/incidents?limit=50&cursor=cursor_value",
    );
  });

  it("rejects invalid explicit incident retry keys before transport", async () => {
    for (const idempotencyKey of [
      "",
      " padded",
      "line\nbreak",
      "é".repeat(128),
    ]) {
      const { calls, methods } = createHarness();
      const result = (await methods.createPrivacyIncident(
        { severity: "high", summary: "Investigate exposure" },
        { idempotencyKey },
      )) as ApiErr;
      expect(result).toMatchObject({
        error: { code: "invalid_privacy_incident_idempotency_key" },
        retryability: "not-retryable",
      });
      expect(calls).toHaveLength(0);
    }
  });

  it("rejects every unexpected 2xx across release-held operations", async () => {
    const incidentId = "11111111-1111-4111-8111-111111111111";
    const packetResponse = new Response("unqualified packet bytes", {
      status: 200,
      headers: {
        "X-Body-SHA256": "a".repeat(64),
        "X-Template-Version": "2026-06",
      },
    });
    const { methods } = createHarness({
      responses: [
        {
          data: {
            incident_id: incidentId,
            from: "notifications_pending",
            to: "closed",
            at: "2026-07-16T10:00:00Z",
          },
        },
        { data: {} },
        { data: {} },
      ],
      nativeResponses: [packetResponse],
    });

    const results = [
      await methods.transitionPrivacyIncident(
        incidentId,
        "closed",
        "Ready to close",
        "notifications_pending",
      ),
      await methods.signoffPrivacyIncident(incidentId, {
        signoff_by: "counsel@example.com",
      }),
      await methods.recordPrivacyIncidentNotification(incidentId, {
        audience: "authority",
      }),
      await methods.downloadPrivacyIncidentPacket(incidentId, "authority"),
    ] as ApiErr[];

    for (const result of results) {
      expect(result).toMatchObject({
        error: {
          kind: "parse",
          code: "invalid_privacy_incident_response_contract",
        },
        retryability: "manual",
      });
      expect(result).not.toHaveProperty("data");
    }
    expect(packetResponse.bodyUsed).toBe(false);
  });

  it("rejects stale-shape jurisdiction, detail, transition, and event payloads", async () => {
    const incidentId = "11111111-1111-4111-8111-111111111111";
    const eventId = "33333333-3333-4333-8333-333333333333";
    const { methods } = createHarness({
      responses: [
        {
          data: {
            incidents: [privacyIncidentDetail(incidentId)],
            known_jurisdictions: [jurisdictionReference],
          },
        },
        { data: privacyIncident(incidentId) },
        {
          data: {
            incident_id: incidentId,
            from: "contained",
            to: "notifications_pending",
            at: "2026-07-16T09:00:00Z",
          },
        },
        {
          data: {
            incident_id: incidentId,
            events: [
              {
                event_id: eventId,
                source: "incident_state_transitions",
                schema_version: 1,
                kind: "transition",
                at: "2026-07-16T09:00:00Z",
                to_state: "contained",
                legacy_index: 0,
              },
            ],
          },
        },
      ],
    });

    const results = [
      await methods.listPrivacyIncidents(),
      await methods.getPrivacyIncident(incidentId),
      await methods.transitionPrivacyIncident(
        incidentId,
        "notifications_pending",
        "Proceed",
        "open",
      ),
      await methods.listPrivacyIncidentEvents(incidentId),
    ] as ApiErr[];

    for (const result of results) {
      expect(result.error).toMatchObject({
        kind: "parse",
        code: "invalid_privacy_incident_response_contract",
      });
      expect(result.retryability).toBe("manual");
    }
  });

  it("cross-binds pagination, jurisdiction metadata, and event identity", async () => {
    const incidentId = "11111111-1111-4111-8111-111111111111";
    const otherId = "22222222-2222-4222-8222-222222222222";
    const { methods } = createHarness({
      responses: [
        {
          data: {
            incidents: [],
            known_jurisdictions: [jurisdictionReference],
            nextCursor: "nonterminal_cursor",
          },
        },
        {
          data: {
            ...privacyIncidentDetail(incidentId),
            jurisdictions: ["TX"],
          },
        },
        {
          data: {
            ...privacyIncidentDetail(incidentId),
            jurisdiction_resolution: {
              status: "release_held",
              release_hold_code: "jurisdiction_rules_release_hold",
              recognized: [jurisdictionReference],
              unknown_jurisdictions: ["GDPR"],
            },
          },
        },
        {
          data: {
            incident_id: otherId,
            events: [],
          },
        },
      ],
    });

    const emptyNonterminal = (await methods.listPrivacyIncidents()) as ApiErr;
    const mismatchedResolution = (await methods.getPrivacyIncident(
      incidentId,
    )) as ApiErr;
    const overlappingResolution = (await methods.getPrivacyIncident(
      incidentId,
    )) as ApiErr;
    const wrongEventParent = (await methods.listPrivacyIncidentEvents(
      incidentId,
    )) as ApiErr;

    for (const result of [
      emptyNonterminal,
      mismatchedResolution,
      overlappingResolution,
    ]) {
      expect(result.error.code).toBe(
        "invalid_privacy_incident_response_contract",
      );
    }
    expect(wrongEventParent.error.code).toBe(
      "privacy_incident_response_identity_mismatch",
    );
  });

  it("fails closed on malformed or cross-incident sensitive responses", async () => {
    const incidentId = "11111111-1111-4111-8111-111111111111";
    const otherId = "22222222-2222-4222-8222-222222222222";
    const { methods } = createHarness({
      responses: [
        {
          data: {
            incidents: [privacyIncident(), privacyIncident()],
            known_jurisdictions: [jurisdictionReference],
          },
        },
        { data: privacyIncidentDetail(otherId) },
        {
          data: {
            notification_id: "33333333-3333-4333-8333-333333333333",
            incident_id: incidentId,
            audience: "customer",
            template_version: "2026-06",
            sent_at: "2026-07-16T09:10:00Z",
          },
        },
        {
          data: {
            incident_id: incidentId,
            events: [
              {
                event_id: "55555555-5555-4555-8555-555555555555",
                source: "incident_notifications",
                schema_version: 1,
                kind: "notification",
                at: "2026-07-16T10:00:00Z",
                audience: "authority",
              },
              {
                event_id: "66666666-6666-4666-8666-666666666666",
                source: "incident_state_transitions",
                schema_version: 1,
                kind: "transition",
                at: "2026-07-16T09:00:00Z",
                to_state: "contained",
              },
            ],
          },
        },
      ],
    });

    const duplicateList = (await methods.listPrivacyIncidents()) as ApiErr;
    const wrongDetail = (await methods.getPrivacyIncident(
      incidentId,
    )) as ApiErr;
    const wrongAudience = (await methods.recordPrivacyIncidentNotification(
      incidentId,
      { audience: "authority" },
    )) as ApiErr;
    const unorderedEvents = (await methods.listPrivacyIncidentEvents(
      incidentId,
    )) as ApiErr;

    expect(duplicateList.error.code).toBe(
      "invalid_privacy_incident_response_contract",
    );
    expect(wrongDetail.error.code).toBe(
      "privacy_incident_response_identity_mismatch",
    );
    expect(wrongAudience.error.code).toBe(
      "invalid_privacy_incident_response_contract",
    );
    expect(unorderedEvents.error.code).toBe(
      "invalid_privacy_incident_response_contract",
    );
    for (const result of [
      duplicateList,
      wrongDetail,
      wrongAudience,
      unorderedEvents,
    ]) {
      expect(result.error.kind).toBe("parse");
      expect(result.retryability).toBe("manual");
    }
  });

  it("treats event identity as source plus event id", async () => {
    const sharedId = "55555555-5555-4555-8555-555555555555";
    const { methods } = createHarness({
      responses: [
        {
          data: {
            incident_id: "11111111-1111-4111-8111-111111111111",
            events: [
              {
                event_id: sharedId,
                source: "incident_state_transitions",
                schema_version: 1,
                kind: "transition",
                at: "2026-07-16T09:00:00Z",
                to_state: "contained",
              },
              {
                event_id: sharedId,
                source: "incident_notifications",
                schema_version: 1,
                kind: "notification",
                at: "2026-07-16T09:00:00Z",
                audience: "authority",
              },
            ],
          },
        },
      ],
    });

    const result = await methods.listPrivacyIncidentEvents(
      "11111111-1111-4111-8111-111111111111",
    );
    expect(result.error).toBeUndefined();
    expect(result.data?.events).toHaveLength(2);
  });

  it("rejects bidi-formatting controls without rejecting ZWJ emoji", async () => {
    const incidentId = "11111111-1111-4111-8111-111111111111";
    const bidiControls = [
      "\u061c",
      "\u200e",
      "\u200f",
      "\u202a",
      "\u202b",
      "\u202c",
      "\u202d",
      "\u202e",
      "\u2066",
      "\u2067",
      "\u2068",
      "\u2069",
    ];
    const { methods } = createHarness({
      responses: [
        ...bidiControls.map((control) => ({
          data: {
            ...privacyIncidentDetail(incidentId),
            summary: `before${control}after`,
          },
        })),
        {
          data: {
            incident_id: incidentId,
            events: [
              {
                event_id: "55555555-5555-4555-8555-555555555555",
                source: "incident_state_transitions",
                schema_version: 1,
                kind: "transition",
                at: "2026-07-16T09:00:00Z",
                to_state: "contained",
                reason: "safe prefix\u2066spoofed suffix",
              },
            ],
          },
        },
        {
          data: {
            ...privacyIncidentDetail(incidentId),
            summary: "Family 👩‍👩‍👧‍👦 response",
          },
        },
      ],
    });

    for (const _control of bidiControls) {
      const result = (await methods.getPrivacyIncident(incidentId)) as ApiErr;
      expect(result.error.code).toBe(
        "invalid_privacy_incident_response_contract",
      );
    }
    const eventResult = (await methods.listPrivacyIncidentEvents(
      incidentId,
    )) as ApiErr;
    expect(eventResult.error.code).toBe(
      "invalid_privacy_incident_response_contract",
    );
    const zwjResult = await methods.getPrivacyIncident(incidentId);
    expect(zwjResult.error).toBeUndefined();
    expect(zwjResult.data?.summary).toContain("👩‍👩‍👧‍👦");
  });

  it("rejects oversized incident pages, fields, arrays, and ledgers", async () => {
    const incidentId = "11111111-1111-4111-8111-111111111111";
    const validEvent = {
      event_id: "55555555-5555-4555-8555-555555555555",
      source: "incident_state_transitions",
      schema_version: 1,
      kind: "transition",
      at: "2026-07-16T09:00:00Z",
      to_state: "contained",
    };
    const { methods } = createHarness({
      responses: [
        {
          data: {
            ...privacyIncidentDetail(incidentId),
            affected_regions: Array.from(
              { length: 65 },
              (_, index) => `region-${index}`,
            ),
          },
        },
        {
          data: {
            ...privacyIncidentDetail(incidentId),
            affected_regions: ["💥".repeat(257)],
          },
        },
        {
          data: {
            ...privacyIncidentDetail(incidentId),
            summary: "x".repeat(4_001),
          },
        },
        {
          data: {
            incidents: Array(201).fill(privacyIncident()),
            known_jurisdictions: [jurisdictionReference],
          },
        },
        {
          data: {
            incident_id: incidentId,
            events: [{ ...validEvent, reason: "x".repeat(2_001) }],
          },
        },
        {
          data: {
            incident_id: incidentId,
            events: [
              {
                event_id: "66666666-6666-4666-8666-666666666666",
                source: "incident_notifications",
                schema_version: 1,
                kind: "notification",
                at: "2026-07-16T10:00:00Z",
                audience: "authority",
                body_sha256: "not-a-sha256",
              },
            ],
          },
        },
        {
          data: {
            incident_id: incidentId,
            events: Array(10_001).fill(validEvent),
          },
        },
      ],
    });

    const results = [
      await methods.getPrivacyIncident(incidentId),
      await methods.getPrivacyIncident(incidentId),
      await methods.getPrivacyIncident(incidentId),
      await methods.listPrivacyIncidents(),
      await methods.listPrivacyIncidentEvents(incidentId),
      await methods.listPrivacyIncidentEvents(incidentId),
      await methods.listPrivacyIncidentEvents(incidentId),
    ] as ApiErr[];

    for (const result of results) {
      expect(result).toMatchObject({
        error: {
          kind: "parse",
          code: "invalid_privacy_incident_response_contract",
        },
        retryability: "manual",
      });
    }
  });

  it("rejects an authenticated packet 2xx before reading bytes and disposes", async () => {
    const harness = createHarness();
    const parent = new AbortController();

    const result = (await harness.methods.downloadPrivacyIncidentPacket(
      "incident/one",
      "authority",
      { signal: parent.signal },
    )) as ApiErr;

    expect(result).toMatchObject({
      error: {
        kind: "parse",
        code: "invalid_privacy_incident_response_contract",
      },
      retryability: "manual",
    });
    expect(result).not.toHaveProperty("data");
    expect(harness.controllerParents).toEqual([parent.signal]);
    expect(harness.apiPaths).toEqual([
      "/api/v1/privacy/incidents/incident%2Fone/packet/authority",
    ]);
    expect(harness.normalizedApiKeyInputs).toEqual(["raw-key"]);
    expect(harness.nativeCalls).toEqual([
      {
        input:
          "https://api.example.test/api/v1/privacy/incidents/incident%2Fone/packet/authority",
        init: {
          method: "GET",
          headers: {
            Accept: "text/markdown",
            Authorization: "Bearer normalized-key",
          },
          mode: "cors",
          credentials: "include",
          cache: "no-store",
          signal: harness.controller.signal,
        },
      },
    ]);
    expect(harness.state).toEqual({
      disposeCount: 1,
      errorResponseCount: 0,
      getApiKeyCount: 1,
      transportErrorCount: 0,
    });
  });

  it("rejects an unexpected packet 2xx and omits absent authorization", async () => {
    const response = new Response("customer packet", { status: 200 });
    const harness = createHarness({
      apiKey: null,
      normalizedApiKey: null,
      nativeResponses: [response],
    });

    const result = (await harness.methods.downloadPrivacyIncidentPacket(
      "incident/one",
      "customer",
    )) as ApiErr;
    expect(result).toMatchObject({
      error: {
        kind: "parse",
        code: "invalid_privacy_incident_response_contract",
      },
      retryability: "manual",
    });
    expect(result).not.toHaveProperty("data");
    expect(response.bodyUsed).toBe(false);
    expect(harness.controllerParents).toEqual([undefined]);
    expect(harness.normalizedApiKeyInputs).toEqual([null]);
    expect(harness.nativeCalls[0]?.init?.headers).toEqual({
      Accept: "text/markdown",
    });
    expect(harness.state.disposeCount).toBe(1);
  });

  it("delegates packet HTTP failures and always disposes the controller", async () => {
    const forbidden = new Response("forbidden", { status: 403 });
    const harness = createHarness({ nativeResponses: [forbidden] });

    await expect(
      harness.methods.downloadPrivacyIncidentPacket(
        "incident/one",
        "data_subject",
      ),
    ).resolves.toEqual({
      error: { kind: "http", status: 403, message: "HTTP 403" },
    });
    expect(harness.state.errorResponseCount).toBe(1);
    expect(harness.state.transportErrorCount).toBe(0);
    expect(harness.state.disposeCount).toBe(1);
  });

  it("normalizes thrown packet failures and always disposes the controller", async () => {
    const failure = new Error("native fetch failed");
    const harness = createHarness({ nativeResponses: [failure] });

    await expect(
      harness.methods.downloadPrivacyIncidentPacket(
        "incident/one",
        "authority",
      ),
    ).resolves.toEqual({
      error: { kind: "network", message: "native fetch failed" },
    });
    expect(harness.state.errorResponseCount).toBe(0);
    expect(harness.state.transportErrorCount).toBe(1);
    expect(harness.state.disposeCount).toBe(1);
  });

  it("propagates caller aborts through the download signal and still disposes", async () => {
    const abortFailure = new Error("caller aborted packet download");
    const harness = createHarness({
      linkParentSignal: true,
      nativeImplementation: async (_input, init) => {
        const signal = init?.signal;
        if (!signal) throw new Error("missing download signal");
        return new Promise<Response>((_resolve, reject) => {
          const rejectAbort = (): void =>
            reject(
              signal.reason instanceof Error ? signal.reason : abortFailure,
            );
          if (signal.aborted) rejectAbort();
          else signal.addEventListener("abort", rejectAbort, { once: true });
        });
      },
    });
    const parent = new AbortController();

    const result = harness.methods.downloadPrivacyIncidentPacket(
      "incident/one",
      "authority",
      { signal: parent.signal },
    );
    parent.abort(abortFailure);

    await expect(result).resolves.toEqual({
      error: { kind: "network", message: "caller aborted packet download" },
    });
    expect(harness.controller.signal.aborted).toBe(true);
    expect(harness.controllerParents).toEqual([parent.signal]);
    expect(harness.state.errorResponseCount).toBe(0);
    expect(harness.state.transportErrorCount).toBe(1);
    expect(harness.state.disposeCount).toBe(1);
  });

  it("retains empty-query defaults and passes request errors through unchanged", async () => {
    const expectedError: ApiErr = {
      error: { kind: "http", status: 503, message: "Unavailable" },
    };
    const { calls, methods } = createHarness({ responses: [expectedError] });

    await expect(
      methods.listConsentReceipts({ workspaceId: CONSENT_WORKSPACE_ID }),
    ).resolves.toBe(expectedError);
    await methods.listConsentEvents({ workspaceId: CONSENT_WORKSPACE_ID });

    expect(calls).toEqual([
      {
        path: "/api/v1/consent/receipts",
        init: undefined,
        opts: undefined,
      },
      {
        path: "/api/v1/consent/events",
        init: undefined,
        opts: undefined,
      },
    ]);
  });
});
