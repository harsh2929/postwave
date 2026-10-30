import { describe, expect, it } from "vitest";

import {
  api,
  MAX_EMAILS_PER_PROFILE as FACADE_MAX_EMAILS_PER_PROFILE,
  SIGNUP_SOURCES as FACADE_SIGNUP_SOURCES,
  signupSourceLabel as facadeSignupSourceLabel,
} from "../../lib/api-client";
import {
  createSubscriberProfilesApis,
  isExactSubscriberVersion,
  isExactSubscriberVersionFor,
  MAX_EMAILS_PER_PROFILE,
  SIGNUP_SOURCES,
  signupSourceLabel,
  type SubscriberProfilesRequester,
  type SubscriberProfilesRequestOptions,
} from "../../lib/api/subscriber-profiles";
import type { ApiErr, ApiResult } from "../../lib/api/result";

interface RequestCall {
  path: string;
  init: RequestInit | undefined;
  opts: SubscriberProfilesRequestOptions | undefined;
}

const DIRECTORY_METHOD_NAMES = [
  "listSubscribers",
  "createSubscriber",
  "bulkPasteSubscribers",
] as const;

const PROFILE_METHOD_NAMES = [
  "getSubscriber",
  "getSubscriberActivity",
  "getSubscriberPredictionMetadata",
  "getSubscriberGroupMemberships",
  "updateSubscriber",
  "deleteSubscriber",
  "archiveSubscriber",
  "unarchiveSubscriber",
  "getSubscriberLifecycle",
  "putSubscriberLifecycle",
  "listSubscriberAliases",
  "upsertSubscriberAlias",
  "deleteSubscriberAlias",
  "listSubscriberChannelConsents",
  "setSubscriberChannelConsent",
  "subscribeToTopic",
  "unsubscribeFromTopic",
  "getSubscriberGpp",
  "listSubscriberEmails",
  "addSubscriberEmail",
  "updateSubscriberEmail",
  "deleteSubscriberEmail",
  "listSubscriberTraits",
  "recordSubscriberEvent",
  "listAccounts",
  "getAccount",
  "createAccount",
  "updateAccount",
  "deleteAccount",
  "setSubscriberAccount",
  "getSubscriberCatalogAttributes",
  "setSubscriberCatalogAttributes",
  "getSubscriberReplenishmentCadence",
  "getSubscriberDemographics",
  "listCollections",
  "getCollection",
  "createCollection",
  "updateCollection",
  "deleteCollection",
] as const;

const ALL_METHOD_NAMES = [
  ...DIRECTORY_METHOD_NAMES,
  ...PROFILE_METHOD_NAMES,
] as const;
const METHOD_NAME_SET = new Set<string>(ALL_METHOD_NAMES);

function createHarness(responses: ApiResult<unknown>[] = []) {
  const calls: RequestCall[] = [];
  const request: SubscriberProfilesRequester = async <T>(
    path: string,
    init?: RequestInit,
    opts?: SubscriberProfilesRequestOptions,
  ): Promise<ApiResult<T>> => {
    calls.push({ path, init, opts });
    return (responses.shift() ?? { data: {} }) as ApiResult<T>;
  };
  const apis = createSubscriberProfilesApis(request);
  return { calls, ...apis };
}

describe("subscriber profiles API extraction contracts", () => {
  it("accepts only the backend's legitimate exact strong subscriber revision format", () => {
    const version =
      '"subscriber:00000000-0000-4000-8000-000000000042:v1770000000000000"';
    expect(isExactSubscriberVersion(version)).toBe(true);
    expect(
      isExactSubscriberVersionFor(
        version,
        "00000000-0000-4000-8000-000000000042",
      ),
    ).toBe(true);
    expect(
      isExactSubscriberVersionFor(
        version,
        "00000000-0000-4000-8000-000000000099",
      ),
    ).toBe(false);
    for (const invalid of [
      "*",
      `W/${version}`,
      `${version}, ${version}`,
      '"campaign:00000000-0000-4000-8000-000000000042:v1"',
      '"subscriber:00000000-0000-4000-8000-000000000042:not-a-version"',
      ` ${version}`,
    ]) {
      expect(isExactSubscriberVersion(invalid)).toBe(false);
    }
  });

  it("retains both ordered method bags, facade placement, constants, and helper identity", () => {
    const { calls, subscriberDirectoryMethods, subscriberProfileMethods } =
      createHarness();

    expect(Object.keys(subscriberDirectoryMethods)).toEqual(
      DIRECTORY_METHOD_NAMES,
    );
    expect(Object.keys(subscriberProfileMethods)).toEqual(PROFILE_METHOD_NAMES);
    expect(
      Object.keys(api).filter((name) => METHOD_NAME_SET.has(name)),
    ).toEqual(ALL_METHOD_NAMES);
    for (const name of DIRECTORY_METHOD_NAMES) {
      expect(subscriberDirectoryMethods[name].name).toBe(name);
      expect(api[name].name).toBe(name);
    }
    for (const name of PROFILE_METHOD_NAMES) {
      expect(subscriberProfileMethods[name].name).toBe(name);
      expect(api[name].name).toBe(name);
    }
    expect(calls).toEqual([]);

    expect(FACADE_MAX_EMAILS_PER_PROFILE).toBe(MAX_EMAILS_PER_PROFILE);
    expect(FACADE_SIGNUP_SOURCES).toBe(SIGNUP_SOURCES);
    expect(facadeSignupSourceLabel).toBe(signupSourceLabel);
    expect(MAX_EMAILS_PER_PROFILE).toBe(5);
    expect(SIGNUP_SOURCES).toEqual([
      "embedded_form",
      "hosted_page",
      "import",
      "api",
      "integration",
      "unknown",
    ]);
    expect([
      signupSourceLabel("embedded_form"),
      signupSourceLabel("hosted_page"),
      signupSourceLabel("import"),
      signupSourceLabel("api"),
      signupSourceLabel("integration"),
      signupSourceLabel("unknown"),
      signupSourceLabel(undefined),
    ]).toEqual([
      "Embedded form",
      "Hosted page",
      "CSV import",
      "API",
      "Integration",
      "Unknown",
      "Unknown",
    ]);
  });

  it("preserves directory queries, request signals, and creation payloads", async () => {
    const { calls, subscriberDirectoryMethods: methods } = createHarness();
    const signal = new AbortController().signal;

    await methods.listSubscribers(
      {
        query: "Ada & buyers",
        status: "enabled",
        sort: "first_name",
        order: "asc",
        page: 2,
        perPage: 50,
        cursor: "cursor/one",
        includeArchived: true,
      },
      { signal },
    );
    await methods.createSubscriber({
      email: "ada@example.com",
      tags: ["vip"],
      name: "Ada",
    });
    await methods.bulkPasteSubscribers({
      emails: "ada@example.com; grace@example.com",
      status: "unconfirmed",
      tags: ["new"],
    });

    expect(calls).toEqual([
      {
        path: "/api/v1/subscribers?q=Ada+%26+buyers&status=enabled&sort=first_name&order=asc&page=2&per_page=50&cursor=cursor%2Fone&include_archived=true",
        init: {},
        opts: { signal },
      },
      {
        path: "/api/v1/subscribers",
        init: {
          method: "POST",
          body: JSON.stringify({
            email: "ada@example.com",
            tags: ["vip"],
            merge_fields: { name: "Ada" },
            status: "unconfirmed",
          }),
        },
        opts: undefined,
      },
      {
        path: "/api/v1/subscribers/bulk-paste",
        init: {
          method: "POST",
          body: JSON.stringify({
            emails: "ada@example.com; grace@example.com",
            status: "unconfirmed",
            tags: ["new"],
          }),
        },
        opts: undefined,
      },
    ]);
  });

  it("rejects malformed directory successes and accepts one exact versioned page", async () => {
    const validVersion = '"subscriber:subscriber-1:v7"';
    const { subscriberDirectoryMethods: methods } = createHarness([
      { data: {} },
      {
        data: {
          items: [
            {
              id: "subscriber-1",
              email: "alice@example.test",
              version: 'W/"subscriber:subscriber-1:v7"',
            },
          ],
          total: 1,
          page: 1,
          per_page: 50,
        },
      },
      {
        data: {
          items: [
            {
              id: "subscriber-1",
              email: "alice@example.test",
              version: validVersion,
            },
          ],
          total: 1,
          page: 1,
          per_page: 50,
        },
      },
    ]);

    const missingEnvelope = await methods.listSubscribers();
    const weakVersion = await methods.listSubscribers();
    const valid = await methods.listSubscribers();

    expect(missingEnvelope.error).toMatchObject({
      kind: "parse",
      code: "invalid_subscriber_response_contract",
    });
    expect(weakVersion.error).toMatchObject({
      kind: "parse",
      code: "invalid_subscriber_response_contract",
    });
    expect(valid).toEqual({
      data: {
        items: [
          {
            id: "subscriber-1",
            email: "alice@example.test",
            version: validVersion,
          },
        ],
        total: 1,
        page: 1,
        per_page: 50,
      },
    });
  });

  it("preserves profile, archive, lifecycle, and alias transports", async () => {
    const { calls, subscriberProfileMethods: methods } = createHarness();
    const patch = {
      status: "enabled",
      first_name: "Ada",
      frequency_preference: "weekly" as const,
      pause_days: 7,
      consent_source: "double_optin" as const,
      consent_timestamp: "2026-07-01T09:30:00.000Z",
      consent_channel: "email",
      consent_legal_basis: "consent",
      consent_jurisdiction: "GB",
      consent_evidence: "receipt:CONSENT-42",
      consent_reason: "Reviewed the double opt-in receipt.",
      consent_policy_version: "privacy-2026-07",
    };
    const lifecycle = {
      stage: "customer" as const,
      score: 95,
      reason: "Purchased",
    };
    const alias = {
      alias_type: "external_id" as const,
      alias_value: "crm/42",
      confidence: 0.9,
      source: "crm",
      provenance: { system: "salesforce" },
    };

    await methods.getSubscriber("subscriber/one");
    await methods.getSubscriberActivity("subscriber/one");
    await methods.getSubscriberPredictionMetadata("subscriber/one");
    await methods.getSubscriberGroupMemberships("subscriber/one");
    await methods.updateSubscriber("subscriber/one", patch, {
      version: `"subscriber:subscriber.one:v1"`,
    });
    await methods.deleteSubscriber(
      "subscriber/one",
      `"subscriber:subscriber.one:v1"`,
    );
    await methods.archiveSubscriber(
      "subscriber/one",
      `"subscriber:subscriber.one:v1"`,
    );
    await methods.unarchiveSubscriber(
      "subscriber/one",
      `"subscriber:subscriber.one:v2"`,
    );
    await methods.getSubscriberLifecycle("subscriber/one");
    await methods.putSubscriberLifecycle(
      "subscriber/one",
      lifecycle,
      `"subscriber:subscriber.one:v1"`,
    );
    await methods.listSubscriberAliases("subscriber/one");
    await methods.upsertSubscriberAlias(
      "subscriber/one",
      alias,
      `"subscriber:subscriber.one:v2"`,
    );
    await methods.deleteSubscriberAlias(
      "subscriber/one",
      "alias/one",
      `"subscriber:subscriber.one:v3"`,
    );

    const root = "/api/v1/subscribers/subscriber%2Fone";
    expect(calls).toEqual([
      { path: root, init: undefined, opts: undefined },
      { path: `${root}/activity`, init: undefined, opts: undefined },
      {
        path: `${root}/prediction-metadata`,
        init: undefined,
        opts: undefined,
      },
      { path: `${root}/groups`, init: undefined, opts: undefined },
      {
        path: root,
        init: {
          method: "PATCH",
          headers: { "If-Match": `"subscriber:subscriber.one:v1"` },
          body: JSON.stringify(patch),
        },
        opts: { maxAttempts: 1, requireOnline: true },
      },
      {
        path: root,
        init: {
          method: "DELETE",
          headers: { "If-Match": `"subscriber:subscriber.one:v1"` },
        },
        opts: undefined,
      },
      {
        path: `${root}/archive`,
        init: {
          method: "PATCH",
          headers: { "If-Match": `"subscriber:subscriber.one:v1"` },
        },
        opts: { maxAttempts: 1, requireOnline: true },
      },
      {
        path: `${root}/unarchive`,
        init: {
          method: "PATCH",
          headers: { "If-Match": `"subscriber:subscriber.one:v2"` },
        },
        opts: { maxAttempts: 1, requireOnline: true },
      },
      { path: `${root}/lifecycle`, init: undefined, opts: undefined },
      {
        path: `${root}/lifecycle`,
        init: {
          method: "PUT",
          headers: { "If-Match": `"subscriber:subscriber.one:v1"` },
          body: JSON.stringify(lifecycle),
        },
        opts: { maxAttempts: 1, requireOnline: true },
      },
      { path: `${root}/aliases`, init: undefined, opts: undefined },
      {
        path: `${root}/aliases`,
        init: {
          method: "POST",
          headers: { "If-Match": `"subscriber:subscriber.one:v2"` },
          body: JSON.stringify(alias),
        },
        opts: { maxAttempts: 1, requireOnline: true },
      },
      {
        path: `${root}/aliases/alias%2Fone`,
        init: {
          method: "DELETE",
          headers: { "If-Match": `"subscriber:subscriber.one:v3"` },
        },
        opts: { maxAttempts: 1, requireOnline: true },
      },
    ]);
  });

  it("fails closed before transport when an enabled transition lacks reviewed evidence", async () => {
    const { calls, subscriberProfileMethods: methods } = createHarness();

    const result = await methods.updateSubscriber(
      "subscriber-1",
      { status: "enabled" },
      { version: `"subscriber:subscriber-1:v1"` },
    );

    expect(calls).toEqual([]);
    expect(result).toMatchObject({
      error: {
        kind: "http",
        status: 400,
        code: "invalid_subscriber_status_consent_input",
      },
      retryability: "not-retryable",
    });
  });

  it("fails closed before transport without an exact subscriber revision", async () => {
    const { calls, subscriberProfileMethods: methods } = createHarness();

    for (const version of [
      "",
      "   ",
      "*",
      'W/"subscriber:subscriber-1:v1"',
      '"subscriber:subscriber-1:v1", "subscriber:subscriber-1:v2"',
      '"subscriber:subscriber-1:not-a-version"',
    ]) {
      const result = await methods.updateSubscriber(
        "subscriber-1",
        { tags: ["vip"] },
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

  it("fails closed before transport when delete lacks an exact revision", async () => {
    const { calls, subscriberProfileMethods: methods } = createHarness();

    for (const version of ["", "   ", "*"]) {
      const result = await methods.deleteSubscriber("subscriber-1", version);
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

  it("makes alias writes online-only, exact-revision-bound, and response-verified", async () => {
    const savedVersion = `"subscriber:subscriber-1:v2"`;
    const deletedVersion = `"subscriber:subscriber-1:v3"`;
    const alias = {
      alias_type: "external_id" as const,
      alias_value: "crm-42",
      source: "desktop",
    };
    const { calls, subscriberProfileMethods: methods } = createHarness([
      {
        data: {
          id: "alias-1",
          subscriber_id: "subscriber-1",
          alias_type: "external_id",
          alias_value: "crm-42",
          confidence: 1,
          source: "desktop",
          subscriber_version: savedVersion,
          external_id: "crm-42",
        },
        serverVersion: savedVersion,
      },
      {
        data: {
          deleted: true,
          subscriber_id: "subscriber-1",
          subscriber_version: deletedVersion,
          external_id: null,
        },
        serverVersion: deletedVersion,
      },
    ]);

    for (const invalid of ["", "   ", "*"]) {
      expect(
        await methods.upsertSubscriberAlias("subscriber-1", alias, invalid),
      ).toMatchObject({
        error: { status: 428, code: "precondition_required" },
        retryability: "not-retryable",
      });
      expect(
        await methods.deleteSubscriberAlias("subscriber-1", "alias-1", invalid),
      ).toMatchObject({
        error: { status: 428, code: "precondition_required" },
        retryability: "not-retryable",
      });
    }

    const saved = await methods.upsertSubscriberAlias(
      "subscriber-1",
      alias,
      `"subscriber:subscriber-1:v1"`,
    );
    const deleted = await methods.deleteSubscriberAlias(
      "subscriber-1",
      "alias-1",
      savedVersion,
    );
    expect(saved).toMatchObject({
      data: { subscriber_version: savedVersion, external_id: "crm-42" },
    });
    expect(deleted).toMatchObject({
      data: { subscriber_version: deletedVersion, external_id: null },
    });
    expect(calls).toEqual([
      {
        path: "/api/v1/subscribers/subscriber-1/aliases",
        init: {
          method: "POST",
          headers: { "If-Match": `"subscriber:subscriber-1:v1"` },
          body: JSON.stringify(alias),
        },
        opts: { maxAttempts: 1, requireOnline: true },
      },
      {
        path: "/api/v1/subscribers/subscriber-1/aliases/alias-1",
        init: {
          method: "DELETE",
          headers: { "If-Match": savedVersion },
        },
        opts: { maxAttempts: 1, requireOnline: true },
      },
    ]);
  });

  it("makes lifecycle writes online-only and chains the exact parent revision", async () => {
    const nextVersion = `"subscriber:subscriber-1:v2"`;
    const input = {
      stage: "customer" as const,
      score: 4,
      source: "desktop",
    };
    const { calls, subscriberProfileMethods: methods } = createHarness([
      {
        data: {
          subscriber_id: "subscriber-1",
          subscriber_version: nextVersion,
          tenant_id: "tenant-1",
          stage: "customer",
          previous_stage: "lead",
          score: 4,
          transitioned: true,
          transitioned_at: "2026-07-19T08:00:00.000Z",
          updated_at: "2026-07-19T08:00:00.000Z",
        },
        serverVersion: nextVersion,
      },
    ]);
    for (const invalid of [
      "",
      "   ",
      "*",
      `W/"subscriber:subscriber-1:v1"`,
      `"subscriber:subscriber-1:v1", "subscriber:subscriber-1:v2"`,
    ]) {
      expect(
        await methods.putSubscriberLifecycle("subscriber-1", input, invalid),
      ).toMatchObject({
        error: { status: 428, code: "precondition_required" },
        retryability: "not-retryable",
      });
    }
    const result = await methods.putSubscriberLifecycle(
      "subscriber-1",
      input,
      `"subscriber:subscriber-1:v1"`,
    );
    expect(result).toMatchObject({
      data: { subscriber_version: nextVersion, stage: "customer", score: 4 },
    });
    expect(calls).toEqual([
      {
        path: "/api/v1/subscribers/subscriber-1/lifecycle",
        init: {
          method: "PUT",
          headers: { "If-Match": `"subscriber:subscriber-1:v1"` },
          body: JSON.stringify(input),
        },
        opts: { maxAttempts: 1, requireOnline: true },
      },
    ]);
  });

  it("accepts only lifecycle reads bound to the requested identity and response ETag", async () => {
    const version = `"subscriber:subscriber-1:v4"`;
    const validLifecycle = {
      subscriber_id: "subscriber-1",
      subscriber_version: version,
      tenant_id: "tenant-1",
      stage: "lead" as const,
      score: 4,
      updated_at: "2026-07-19T08:00:00.000Z",
    };
    const valid = createHarness([
      { data: validLifecycle, serverVersion: version },
    ]).subscriberProfileMethods;
    await expect(valid.getSubscriberLifecycle("subscriber-1")).resolves.toEqual(
      { data: validLifecycle, serverVersion: version },
    );

    for (const response of [
      {
        data: { ...validLifecycle, subscriber_id: "subscriber-2" },
        serverVersion: version,
      },
      {
        data: validLifecycle,
        serverVersion: `"subscriber:subscriber-1:v3"`,
      },
      {
        data: { ...validLifecycle, score: 0 },
        serverVersion: version,
      },
      {
        data: { ...validLifecycle, updated_at: "not-a-timestamp" },
        serverVersion: version,
      },
      {
        data: {
          ...validLifecycle,
          updated_at: "2026-02-30T08:00:00.000Z",
        },
        serverVersion: version,
      },
      {
        data: {
          ...validLifecycle,
          transitioned: true,
          previous_stage: "lead",
          transitioned_at: "2026-07-19T08:00:00.000Z",
        },
        serverVersion: version,
      },
      {
        data: {
          ...validLifecycle,
          transitioned: true,
          previous_stage: "subscriber",
          transitioned_at: "invalid",
        },
        serverVersion: version,
      },
    ]) {
      const methods = createHarness([response]).subscriberProfileMethods;
      await expect(
        methods.getSubscriberLifecycle("subscriber-1"),
      ).resolves.toMatchObject({
        error: { kind: "parse" },
        retryability: "manual",
      });
    }
  });

  it("requires exact revisions and verifies archive-state responses", async () => {
    const archivedVersion = '"subscriber:subscriber-1:v2"';
    const restoredVersion = '"subscriber:subscriber-1:v3"';
    const { calls, subscriberProfileMethods: methods } = createHarness([
      {
        data: {
          id: "subscriber-1",
          email: "reader@example.test",
          archived_at: "2026-07-19T10:00:00Z",
          version: archivedVersion,
        },
        serverVersion: archivedVersion,
      },
      {
        data: {
          id: "subscriber-1",
          email: "reader@example.test",
          archived_at: null,
          version: restoredVersion,
        },
        serverVersion: restoredVersion,
      },
    ]);

    for (const invalid of ["", "   ", "*"]) {
      expect(
        await methods.archiveSubscriber("subscriber-1", invalid),
      ).toMatchObject({
        error: { status: 428, code: "precondition_required" },
        retryability: "not-retryable",
      });
      expect(
        await methods.unarchiveSubscriber("subscriber-1", invalid),
      ).toMatchObject({
        error: { status: 428, code: "precondition_required" },
        retryability: "not-retryable",
      });
    }

    const archived = await methods.archiveSubscriber(
      "subscriber-1",
      '"subscriber:subscriber-1:v1"',
    );
    const restored = await methods.unarchiveSubscriber(
      "subscriber-1",
      archivedVersion,
    );
    expect(archived).toMatchObject({ data: { version: archivedVersion } });
    expect(restored).toMatchObject({ data: { version: restoredVersion } });
    expect(calls).toEqual([
      {
        path: "/api/v1/subscribers/subscriber-1/archive",
        init: {
          method: "PATCH",
          headers: { "If-Match": '"subscriber:subscriber-1:v1"' },
        },
        opts: { maxAttempts: 1, requireOnline: true },
      },
      {
        path: "/api/v1/subscribers/subscriber-1/unarchive",
        init: {
          method: "PATCH",
          headers: { "If-Match": archivedVersion },
        },
        opts: { maxAttempts: 1, requireOnline: true },
      },
    ]);
  });

  it("requires and verifies the parent revision for account-link writes", async () => {
    const nextVersion = '"subscriber:subscriber-1:v2"';
    const response = {
      data: {
        id: "subscriber-1",
        email: "reader@example.test",
        account_id: "account-1",
        version: nextVersion,
      },
      serverVersion: nextVersion,
    } as ApiResult<unknown>;
    const { calls, subscriberProfileMethods: methods } = createHarness([
      response,
    ]);

    for (const invalid of ["", "   ", "*"]) {
      expect(
        await methods.setSubscriberAccount(
          "subscriber-1",
          "account-1",
          invalid,
        ),
      ).toMatchObject({
        error: { status: 428, code: "precondition_required" },
        retryability: "not-retryable",
      });
    }
    const result = await methods.setSubscriberAccount(
      "subscriber-1",
      "account-1",
      '"subscriber:subscriber-1:v1"',
    );
    expect(result).toEqual(response);
    expect(calls).toEqual([
      {
        path: "/api/v1/subscribers/subscriber-1/account",
        init: {
          method: "PATCH",
          headers: { "If-Match": '"subscriber:subscriber-1:v1"' },
          body: JSON.stringify({ account_id: "account-1" }),
        },
        opts: { maxAttempts: 1, requireOnline: true },
      },
    ]);
  });

  it("rejects malformed subscriber bodies from archive, restore, and account-link successes", async () => {
    const archivedVersion = '"subscriber:subscriber-1:v2"';
    const restoredVersion = '"subscriber:subscriber-1:v3"';
    const accountVersion = '"subscriber:subscriber-1:v4"';
    const { subscriberProfileMethods: methods } = createHarness([
      {
        data: {
          id: "subscriber-1",
          archived_at: "2026-07-19T10:00:00Z",
          version: archivedVersion,
        },
        serverVersion: archivedVersion,
      },
      {
        data: {
          id: "subscriber-1",
          email: " ",
          archived_at: null,
          version: restoredVersion,
        },
        serverVersion: restoredVersion,
      },
      {
        data: {
          id: "subscriber-1",
          email: `reader@${"x".repeat(320)}`,
          account_id: "account-1",
          version: accountVersion,
        },
        serverVersion: accountVersion,
      },
    ]);

    const results = [
      await methods.archiveSubscriber(
        "subscriber-1",
        '"subscriber:subscriber-1:v1"',
      ),
      await methods.unarchiveSubscriber("subscriber-1", archivedVersion),
      await methods.setSubscriberAccount(
        "subscriber-1",
        "account-1",
        restoredVersion,
      ),
    ];

    for (const result of results) {
      expect(result).toMatchObject({
        error: {
          kind: "parse",
          code: "invalid_subscriber_response_contract",
        },
        retryability: "manual",
      });
    }
  });

  it("requires and verifies the parent revision for channel-consent writes", async () => {
    const version = '"subscriber:subscriber-1:v7"';
    const nextVersion = '"subscriber:subscriber-1:v8"';
    const response = {
      data: {
        id: "channel-email",
        subscriber_id: "subscriber-1",
        subscriber_version: nextVersion,
        channel: "email",
        status: "opted_out",
      },
      serverVersion: nextVersion,
    } as ApiResult<unknown>;
    const { calls, subscriberProfileMethods: methods } = createHarness([
      response,
    ]);

    for (const invalid of ["", "   ", "*"]) {
      const result = await methods.setSubscriberChannelConsent(
        "subscriber-1",
        "email",
        { status: "opted_out" },
        { version: invalid },
      );
      expect(result).toMatchObject({
        error: { status: 428, code: "precondition_required" },
        retryability: "not-retryable",
      });
    }
    const result = await methods.setSubscriberChannelConsent(
      "subscriber-1",
      "email",
      { status: "opted_out" },
      { version, signal: new AbortController().signal },
    );
    expect(result).toEqual(response);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      path: "/api/v1/subscribers/subscriber-1/channel-consents/email",
      init: {
        method: "PATCH",
        headers: { "If-Match": version },
      },
      opts: { maxAttempts: 1, requireOnline: true },
    });
  });

  it("rejects a channel-consent response with a mismatched revision", async () => {
    const { subscriberProfileMethods: methods } = createHarness([
      {
        data: {
          id: "channel-email",
          subscriber_id: "subscriber-1",
          subscriber_version: '"subscriber:subscriber-1:v2"',
          channel: "email",
          status: "opted_in",
        },
        serverVersion: '"subscriber:subscriber-1:v3"',
      },
    ]);
    const result = await methods.setSubscriberChannelConsent(
      "subscriber-1",
      "email",
      { status: "opted_in" },
      { version: '"subscriber:subscriber-1:v1"' },
    );
    expect(result).toMatchObject({
      error: {
        kind: "parse",
        code: "invalid_subscriber_response_contract",
      },
      retryability: "manual",
    });
  });

  it("rejects a mutation response whose body revision and ETag disagree", async () => {
    const { calls, subscriberProfileMethods: methods } = createHarness([
      {
        data: {
          id: "subscriber-1",
          email: "reader@example.test",
          tags: ["vip"],
          version: `"subscriber:subscriber-1:v2"`,
        },
        serverVersion: `"subscriber:subscriber-1:v3"`,
      },
    ]);

    const result = await methods.updateSubscriber(
      "subscriber-1",
      { tags: ["vip"] },
      { version: `"subscriber:subscriber-1:v1"` },
    );

    expect(result).toMatchObject({
      error: {
        kind: "parse",
        code: "invalid_subscriber_response_contract",
      },
      retryability: "manual",
    });
    expect(calls[0]?.init?.headers).toEqual({
      "If-Match": `"subscriber:subscriber-1:v1"`,
    });
  });

  it("normalizes a complete enabled grant, forces online transport, and verifies its purpose projection", async () => {
    const response = {
      data: {
        id: "subscriber-1",
        email: "reader@example.test",
        status: "enabled",
        consent_source: "single_optin",
        consent_timestamp: "2026-07-01T09:30:00.000Z",
        consent_email_marketing_at: "2026-07-01T09:30:00.000Z",
        version: `"subscriber:subscriber-1:v2"`,
      },
      serverVersion: `"subscriber:subscriber-1:v2"`,
    } as ApiResult<unknown>;
    const { calls, subscriberProfileMethods: methods } = createHarness([
      response,
    ]);
    const signal = new AbortController().signal;

    const result = await methods.updateSubscriber(
      "subscriber-1",
      {
        status: "enabled",
        consent_source: "single_optin",
        consent_timestamp: "2026-07-01T10:30:00+01:00",
        consent_channel: " EMAIL ",
        consent_legal_basis: " CONSENT ",
        consent_jurisdiction: " gb ",
        consent_evidence: " receipt:CONSENT-42 ",
        consent_reason: " Reviewed the opt-in receipt. ",
        consent_policy_version: " privacy-2026-07 ",
      },
      {
        signal,
        maxAttempts: 4,
        version: `"subscriber:subscriber-1:v1"`,
      },
    );

    expect(result).toEqual(response);
    expect(calls).toEqual([
      {
        path: "/api/v1/subscribers/subscriber-1",
        init: {
          method: "PATCH",
          headers: { "If-Match": `"subscriber:subscriber-1:v1"` },
          body: JSON.stringify({
            status: "enabled",
            consent_source: "single_optin",
            consent_timestamp: "2026-07-01T09:30:00.000Z",
            consent_channel: "email",
            consent_legal_basis: "consent",
            consent_jurisdiction: "GB",
            consent_evidence: "receipt:CONSENT-42",
            consent_reason: "Reviewed the opt-in receipt.",
            consent_policy_version: "privacy-2026-07",
          }),
        },
        opts: { signal, maxAttempts: 1, requireOnline: true },
      },
    ]);
  });

  it("rejects an enabled response that omits the exact email-purpose projection", async () => {
    const { subscriberProfileMethods: methods } = createHarness([
      {
        data: {
          id: "subscriber-1",
          email: "reader@example.test",
          status: "enabled",
          consent_source: "double_optin",
          consent_timestamp: "2026-07-01T09:30:00.000Z",
          version: `"subscriber:subscriber-1:v2"`,
        },
        serverVersion: `"subscriber:subscriber-1:v2"`,
      },
    ]);

    const result = await methods.updateSubscriber(
      "subscriber-1",
      {
        status: "enabled",
        consent_source: "double_optin",
        consent_timestamp: "2026-07-01T09:30:00.000Z",
        consent_channel: "email",
        consent_legal_basis: "consent",
        consent_jurisdiction: "GB",
        consent_evidence: "receipt:CONSENT-42",
        consent_reason: "Reviewed the double opt-in receipt.",
        consent_policy_version: "privacy-2026-07",
      },
      { version: `"subscriber:subscriber-1:v1"` },
    );

    expect(result).toMatchObject({
      error: {
        kind: "parse",
        code: "invalid_subscriber_response_contract",
      },
      retryability: "manual",
    });
  });

  it("preserves consent, topic, GPP, multi-email, trait, and event contracts", async () => {
    const { calls, subscriberProfileMethods: methods } = createHarness();
    const consent = {
      status: "opted_in" as const,
      consent_source: "preference-center",
      frequency_cap_until: "2026-07-20T00:00:00Z",
    };
    const emailInput = {
      email: "new@example.com",
    };
    const emailPatch = {
      consent_status: "never_subscribed" as const,
      source: "direct_request",
      channel: "desktop",
      legal_basis: "consent",
      occurred_at: "2026-07-16T10:00:00Z",
      jurisdiction: "GB",
      evidence: "ticket:PW-42",
      reason: "subscriber requested revocation",
      policy_version: "privacy-2026-07",
    };
    const emailVersion = '"subscriber-email:v1"';
    const subscriberVersion = '"subscriber:subscriber-one:v1"';
    const event = {
      event_name: "Product Viewed",
      event_type: "commerce",
      metadata: { sku: "sku/one" },
      source_event_id: "event/one",
      occurred_at: "2026-07-16T10:00:00Z",
    };

    await methods.listSubscriberChannelConsents("subscriber/one");
    await methods.setSubscriberChannelConsent(
      "subscriber/one",
      "whatsapp",
      consent,
      { version: subscriberVersion },
    );
    await methods.subscribeToTopic("ada+vip@example.com", "topic/one");
    await methods.unsubscribeFromTopic("ada+vip@example.com", "topic/one");
    await methods.getSubscriberGpp("subscriber/one");
    await methods.listSubscriberEmails("subscriber/one");
    await methods.addSubscriberEmail(
      "subscriber/one",
      emailInput,
      subscriberVersion,
    );
    await methods.updateSubscriberEmail(
      "subscriber/one",
      "email/one",
      emailPatch,
      emailVersion,
    );
    await methods.deleteSubscriberEmail(
      "subscriber/one",
      "email/one",
      emailVersion,
    );
    await methods.listSubscriberTraits("subscriber/one");
    await methods.recordSubscriberEvent("subscriber/one", event);

    const root = "/api/v1/subscribers/subscriber%2Fone";
    const topicRoot =
      "/api/v1/subscribers/ada%2Bvip%40example.com/topics/topic%2Fone";
    expect(calls).toEqual([
      { path: `${root}/channel-consents`, init: undefined, opts: undefined },
      {
        path: `${root}/channel-consents/whatsapp`,
        init: {
          method: "PATCH",
          headers: { "If-Match": subscriberVersion },
          body: JSON.stringify(consent),
        },
        opts: { maxAttempts: 1, requireOnline: true },
      },
      {
        path: `${topicRoot}/subscribe`,
        init: { method: "POST" },
        opts: undefined,
      },
      {
        path: `${topicRoot}/unsubscribe`,
        init: { method: "POST" },
        opts: undefined,
      },
      { path: `${root}/gpp`, init: undefined, opts: undefined },
      { path: `${root}/emails`, init: undefined, opts: undefined },
      {
        path: `${root}/emails`,
        init: {
          method: "POST",
          headers: { "If-Match": subscriberVersion },
          body: JSON.stringify(emailInput),
        },
        opts: { maxAttempts: 1, requireOnline: true },
      },
      {
        path: `${root}/emails/email%2Fone`,
        init: {
          method: "PATCH",
          headers: { "If-Match": emailVersion },
          body: JSON.stringify(emailPatch),
        },
        opts: undefined,
      },
      {
        path: `${root}/emails/email%2Fone`,
        init: { method: "DELETE", headers: { "If-Match": emailVersion } },
        opts: undefined,
      },
      { path: `${root}/traits`, init: undefined, opts: undefined },
      {
        path: `${root}/events`,
        init: { method: "POST", body: JSON.stringify(event) },
        opts: undefined,
      },
    ]);
  });

  it("fails closed before attaching an address without one exact parent revision", async () => {
    for (const version of [
      "",
      "*",
      'W/"subscriber:subscriber-one:v1"',
      '"subscriber:subscriber-one:v1", "subscriber:subscriber-one:v2"',
    ]) {
      const { calls, subscriberProfileMethods: methods } = createHarness();
      const result = await methods.addSubscriberEmail(
        "subscriber/one",
        { email: "new@example.com" },
        version,
      );

      expect(result).toMatchObject({
        error: { kind: "parse" },
        retryability: "manual",
      });
      expect(calls).toEqual([]);
    }
  });

  it("preserves account, catalog, cadence, demographic, and collection contracts", async () => {
    const { calls, subscriberProfileMethods: methods } = createHarness();
    const accountInput = {
      name: "Analytical Engines",
      industry: "Computing",
      country: "GB",
      metadata: { tier: "enterprise" },
    };
    const accountPatch = { name: "Analytical Engines Ltd" };
    const catalogInput = {
      favorite_category: {
        category: "books",
        count: 4,
        timestamp: "2026-07-16T00:00:00Z",
      },
      last_viewed_sku: "sku/one",
    };
    const collectionInput = {
      name: "Coupons",
      collection_type: "coupons" as const,
      source_type: "manual" as const,
      data: [{ code: "ADA10" }],
    };
    const collectionPatch = {
      name: "VIP Coupons",
      data: [{ code: "ADA20" }],
    };

    await methods.listAccounts();
    await methods.getAccount("account/one");
    await methods.createAccount(accountInput);
    await methods.updateAccount("account/one", accountPatch);
    await methods.deleteAccount("account/one");
    await methods.setSubscriberAccount(
      "subscriber/one",
      null,
      '"subscriber:subscriber.one:v1"',
    );
    await methods.getSubscriberCatalogAttributes("subscriber/one");
    await methods.setSubscriberCatalogAttributes(
      "subscriber/one",
      catalogInput,
    );
    await methods.getSubscriberReplenishmentCadence("subscriber/one");
    await methods.getSubscriberDemographics("subscriber/one");
    await methods.listCollections();
    await methods.getCollection("collection/one");
    await methods.createCollection(collectionInput);
    await methods.updateCollection("collection/one", collectionPatch, 7);
    await methods.deleteCollection("collection/one", 7);

    const accountRoot = "/api/v1/accounts/account%2Fone";
    const subscriberRoot = "/api/v1/subscribers/subscriber%2Fone";
    const collectionRoot = "/api/v1/collections/collection%2Fone";
    expect(calls).toEqual([
      { path: "/api/v1/accounts", init: undefined, opts: undefined },
      { path: accountRoot, init: undefined, opts: undefined },
      {
        path: "/api/v1/accounts",
        init: { method: "POST", body: JSON.stringify(accountInput) },
        opts: undefined,
      },
      {
        path: accountRoot,
        init: { method: "PATCH", body: JSON.stringify(accountPatch) },
        opts: undefined,
      },
      { path: accountRoot, init: { method: "DELETE" }, opts: undefined },
      {
        path: `${subscriberRoot}/account`,
        init: {
          method: "PATCH",
          headers: { "If-Match": '"subscriber:subscriber.one:v1"' },
          body: JSON.stringify({ account_id: null }),
        },
        opts: { maxAttempts: 1, requireOnline: true },
      },
      {
        path: `${subscriberRoot}/catalog-attributes`,
        init: undefined,
        opts: undefined,
      },
      {
        path: `${subscriberRoot}/catalog-attributes`,
        init: { method: "PATCH", body: JSON.stringify(catalogInput) },
        opts: undefined,
      },
      {
        path: `${subscriberRoot}/replenishment-cadence`,
        init: undefined,
        opts: undefined,
      },
      {
        path: `${subscriberRoot}/demographics`,
        init: undefined,
        opts: undefined,
      },
      { path: "/api/v1/collections", init: undefined, opts: undefined },
      { path: collectionRoot, init: undefined, opts: undefined },
      {
        path: "/api/v1/collections",
        init: {
          method: "POST",
          body: JSON.stringify({ ...collectionInput, expected_version: 0 }),
        },
        opts: { maxAttempts: 1, requireOnline: true },
      },
      {
        path: collectionRoot,
        init: {
          method: "PATCH",
          body: JSON.stringify({ ...collectionPatch, expected_version: 7 }),
        },
        opts: { maxAttempts: 1, requireOnline: true },
      },
      {
        path: collectionRoot,
        init: {
          method: "DELETE",
          body: JSON.stringify({ expected_version: 7 }),
        },
        opts: { maxAttempts: 1, requireOnline: true },
      },
    ]);
  });

  it("supports abortable nested reads and collection summaries without row bodies", async () => {
    const { calls, subscriberProfileMethods: methods } = createHarness();
    const signal = new AbortController().signal;

    await methods.listSubscriberChannelConsents("subscriber/one", { signal });
    await methods.listSubscriberEmails("subscriber/one", { signal });
    await methods.getSubscriberCatalogAttributes("subscriber/one", { signal });
    await methods.getSubscriberReplenishmentCadence("subscriber/one", {
      signal,
    });
    await methods.getSubscriberDemographics("subscriber/one", { signal });
    await methods.listCollections({ includeData: false, signal });
    await methods.listCollections({
      limit: 25,
      cursor: "next/page",
      query: "launch & learn",
      collectionType: "content",
      signal,
    });
    await methods.getCollection("collection/one", { signal });
    await methods.createCollection(
      { name: "Reference values", data: [{ key: "value" }] },
      { signal },
    );
    await methods.updateCollection(
      "collection/one",
      { name: "Updated values" },
      9,
      { signal },
    );
    await methods.deleteCollection("collection/one", 9, { signal });

    const root = "/api/v1/subscribers/subscriber%2Fone";
    expect(calls).toEqual([
      {
        path: `${root}/channel-consents`,
        init: undefined,
        opts: { signal },
      },
      { path: `${root}/emails`, init: undefined, opts: { signal } },
      {
        path: `${root}/catalog-attributes`,
        init: undefined,
        opts: { signal },
      },
      {
        path: `${root}/replenishment-cadence`,
        init: undefined,
        opts: { signal },
      },
      {
        path: `${root}/demographics`,
        init: undefined,
        opts: { signal },
      },
      {
        path: "/api/v1/collections?include_data=false",
        init: undefined,
        opts: { signal },
      },
      {
        path: "/api/v1/collections?limit=25&cursor=next%2Fpage&q=launch+%26+learn&collection_type=content",
        init: undefined,
        opts: { signal },
      },
      {
        path: "/api/v1/collections/collection%2Fone",
        init: undefined,
        opts: { signal },
      },
      {
        path: "/api/v1/collections",
        init: {
          method: "POST",
          body: JSON.stringify({
            name: "Reference values",
            data: [{ key: "value" }],
            expected_version: 0,
          }),
        },
        opts: { signal, requireOnline: true, maxAttempts: 1 },
      },
      {
        path: "/api/v1/collections/collection%2Fone",
        init: {
          method: "PATCH",
          body: JSON.stringify({
            name: "Updated values",
            expected_version: 9,
          }),
        },
        opts: { signal, requireOnline: true, maxAttempts: 1 },
      },
      {
        path: "/api/v1/collections/collection%2Fone",
        init: {
          method: "DELETE",
          body: JSON.stringify({ expected_version: 9 }),
        },
        opts: { signal, requireOnline: true, maxAttempts: 1 },
      },
    ]);
  });

  it("keeps transport failures unchanged", async () => {
    const failure: ApiErr = {
      error: { kind: "http", status: 500, message: "profile unavailable" },
    };
    const { subscriberProfileMethods } = createHarness([failure]);

    await expect(
      subscriberProfileMethods.getSubscriber("one"),
    ).resolves.toEqual(failure);
  });

  it("accepts an email lookup with a stable returned id and rejects identity-less detail", async () => {
    const version = '"subscriber:00000000-0000-4000-8000-000000000042:v1"';
    const { subscriberProfileMethods: methods } = createHarness([
      {
        data: {
          id: "00000000-0000-4000-8000-000000000042",
          email: "Deep-Link@Example.Test",
          version,
        },
        serverVersion: version,
      },
      {
        data: {
          email: "missing-id@example.test",
        },
      },
    ]);

    await expect(
      methods.getSubscriber("deep-link@example.test"),
    ).resolves.toEqual({
      data: {
        id: "00000000-0000-4000-8000-000000000042",
        email: "Deep-Link@Example.Test",
        version,
      },
      serverVersion: version,
    });
    const missingIdentity = (await methods.getSubscriber(
      "missing-id@example.test",
    )) as ApiErr;
    expect(missingIdentity.error.kind).toBe("parse");
    expect(missingIdentity.error.code).toBe(
      "invalid_subscriber_response_contract",
    );
    expect(missingIdentity.retryability).toBe("manual");
  });

  it("rejects mismatched identities across detail and nested profile responses", async () => {
    const { subscriberProfileMethods: methods } = createHarness([
      {
        data: {
          id: "subscriber-other",
          email: "other@example.com",
        },
      },
      {
        data: {
          subscriber_id: "subscriber-other",
          groups: [],
        },
      },
      {
        data: {
          id: "subscriber-other",
          email: "other@example.com",
        },
      },
      {
        data: {
          subscriber_id: "subscriber-other",
          stage: "customer",
          score: 80,
        },
      },
    ]);

    const results = [
      await methods.getSubscriber("subscriber-one"),
      await methods.getSubscriberGroupMemberships("subscriber-one"),
      await methods.updateSubscriber(
        "subscriber-one",
        { tags: ["vip"] },
        { version: `"subscriber:subscriber-one:v1"` },
      ),
      await methods.getSubscriberLifecycle("subscriber-one"),
    ];
    for (const result of results) {
      const rejected = result as ApiErr;
      expect(rejected.error.code).toBe("subscriber_response_identity_mismatch");
      expect(rejected.error.kind).toBe("parse");
      expect(rejected.retryability).toBe("manual");
    }
  });
});
