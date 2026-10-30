import { describe, expect, it } from "vitest";

import { api } from "../../lib/api-client";
import {
  createEnterpriseGovernanceOperationsMethods,
  type EnterpriseGovernanceOperationsDependencies,
  type EnterpriseGovernanceRequester,
  type EnterpriseGovernanceRequestOptions,
} from "../../lib/api/enterprise-governance-operations";
import type { ApiErr, ApiResult } from "../../lib/api/result";

interface RequestCall {
  path: string;
  init: RequestInit | undefined;
  opts: EnterpriseGovernanceRequestOptions | undefined;
}

const METHOD_NAMES = [
  "inboundRoutesList",
  "inboundRouteCreate",
  "inboundRoutePatch",
  "inboundRouteDelete",
  "inboundRoutesReorder",
  "inboundRoutePreview",
  "inboundRouteMatchesList",
  "inboundRouteActionRunsList",
  "inboundEndpointGet",
  "inboundEndpointRotate",
  "scimTokensList",
  "scimTokenCreate",
  "scimTokenRevoke",
  "scimRoleMappingsList",
  "scimRoleMappingUpsert",
  "scimRoleMappingDelete",
  "listCompliancePrograms",
  "getComplianceProgram",
  "attestComplianceProgram",
  "revokeComplianceProgram",
  "listComplianceEvents",
  "byokListKeys",
  "byokListProviders",
  "byokCreateKey",
  "byokActivateKey",
  "byokHealthCheck",
  "byokDeleteKey",
] as const;

const METHOD_NAME_SET = new Set<string>(METHOD_NAMES);

function createHarness(responses: ApiResult<unknown>[] = []) {
  const calls: RequestCall[] = [];
  const queuedResponses = [...responses];
  const request: EnterpriseGovernanceRequester = async <T>(
    path: string,
    init?: RequestInit,
    opts?: EnterpriseGovernanceRequestOptions,
  ): Promise<ApiResult<T>> => {
    calls.push({ path, init, opts });
    return (queuedResponses.shift() ?? { data: {} }) as ApiResult<T>;
  };
  const dependencies: EnterpriseGovernanceOperationsDependencies = {
    request,
  };
  return {
    calls,
    methods: createEnterpriseGovernanceOperationsMethods(dependencies),
  };
}

describe("enterprise governance operations API extraction contracts", () => {
  it("retains the exact ordered 27-method inventory without eager work", () => {
    const { calls, methods } = createHarness();

    expect(Object.keys(methods)).toEqual(METHOD_NAMES);
    expect(
      Object.keys(api).filter((name) => METHOD_NAME_SET.has(name)),
    ).toEqual(METHOD_NAMES);
    for (const name of METHOD_NAMES) {
      expect(typeof methods[name]).toBe("function");
      expect(methods[name].name).toBe(name);
      expect(typeof api[name]).toBe("function");
      expect(api[name].name).toBe(name);
    }
    expect(calls).toEqual([]);
  });

  it("preserves inbound-route CRUD, ordering, and preview transports", async () => {
    const { calls, methods } = createHarness();
    const input = {
      name: "Support routing",
      priority: 10,
      stop_on_match: true,
      enabled: true,
      match_recipient: "support@example.com",
      match_subject_prefix: "URGENT",
      match_from_domain: "customer.example",
      actions: [
        { kind: "tag" as const, tag: "support" },
        { kind: "webhook" as const, url: "https://hooks.example.test/inbound" },
      ],
      action_retry_max: 3,
      action_retry_backoff_seconds: 30,
    };
    const patch = {
      name: "Priority support",
      actions: [],
      clear_actions: true,
    };
    const preview = {
      recipient: "support@example.com",
      subject: "URGENT: account locked",
      from: "ada@customer.example",
    };

    await methods.inboundRoutesList();
    await methods.inboundRouteCreate(input);
    await methods.inboundRoutePatch("route/one", patch);
    await methods.inboundRouteDelete("route/one");
    await methods.inboundRoutesReorder(["route/two", "route/one"]);
    await methods.inboundRoutePreview(preview);

    expect(calls).toEqual([
      {
        path: "/api/v1/inbound-routes",
        init: undefined,
        opts: undefined,
      },
      {
        path: "/api/v1/inbound-routes",
        init: { method: "POST", body: JSON.stringify(input) },
        opts: undefined,
      },
      {
        path: "/api/v1/inbound-routes/route%2Fone",
        init: { method: "PATCH", body: JSON.stringify(patch) },
        opts: undefined,
      },
      {
        path: "/api/v1/inbound-routes/route%2Fone",
        init: { method: "DELETE" },
        opts: undefined,
      },
      {
        path: "/api/v1/inbound-routes/reorder",
        init: {
          method: "POST",
          body: JSON.stringify({ route_ids: ["route/two", "route/one"] }),
        },
        opts: undefined,
      },
      {
        path: "/api/v1/inbound-routes/preview",
        init: { method: "POST", body: JSON.stringify(preview) },
        opts: undefined,
      },
    ]);
  });

  it("preserves inbound history, action-run, and one-shot endpoint transports", async () => {
    const { calls, methods } = createHarness();

    await methods.inboundRouteMatchesList("route/one", { limit: 25 });
    await methods.inboundRouteActionRunsList("match/one");
    await methods.inboundEndpointGet();
    await methods.inboundEndpointRotate();

    expect(calls).toEqual([
      {
        path: "/api/v1/inbound-routes/route%2Fone/matches?limit=25",
        init: undefined,
        opts: undefined,
      },
      {
        path: "/api/v1/inbound-routes/matches/match%2Fone/runs",
        init: undefined,
        opts: undefined,
      },
      {
        path: "/api/v1/inbound-emails/endpoint",
        init: undefined,
        opts: undefined,
      },
      {
        path: "/api/v1/inbound-emails/endpoint/rotate",
        init: { method: "POST" },
        opts: undefined,
      },
    ]);
  });

  it("preserves SCIM token and role-mapping lifecycle transports", async () => {
    const { calls, methods } = createHarness();
    const mapping = {
      group_name: "Customer Success/Admins",
      role: "admin" as const,
      precedence: 10,
    };

    await methods.scimTokensList();
    await methods.scimTokenCreate({ description: "Okta production" });
    await methods.scimTokenRevoke("token/one");
    await methods.scimRoleMappingsList();
    await methods.scimRoleMappingUpsert(mapping);
    await methods.scimRoleMappingDelete("mapping/one");

    expect(calls).toEqual([
      {
        path: "/api/v1/scim/tokens",
        init: undefined,
        opts: undefined,
      },
      {
        path: "/api/v1/scim/tokens",
        init: {
          method: "POST",
          body: JSON.stringify({ description: "Okta production" }),
        },
        opts: undefined,
      },
      {
        path: "/api/v1/scim/tokens/token%2Fone",
        init: { method: "DELETE" },
        opts: undefined,
      },
      {
        path: "/api/v1/scim/role-mappings",
        init: undefined,
        opts: undefined,
      },
      {
        path: "/api/v1/scim/role-mappings",
        init: { method: "POST", body: JSON.stringify(mapping) },
        opts: undefined,
      },
      {
        path: "/api/v1/scim/role-mappings/mapping%2Fone",
        init: { method: "DELETE" },
        opts: undefined,
      },
    ]);
  });

  it("preserves compliance program, attestation, revocation, and event transports", async () => {
    const { calls, methods } = createHarness();
    const attestation = {
      signedByEmail: "owner@example.com",
      signerName: "Ada Lovelace",
      documentPath: "compliance/soc2.pdf",
      documentSha256: "abc123",
      notes: "Reviewed by counsel",
      renewalAt: "2027-07-16T00:00:00Z",
      expectedUpdatedAt: "2026-07-16T00:00:00Z",
    };
    const revision = "2026-07-16T00:00:00Z";

    await methods.listCompliancePrograms();
    await methods.getComplianceProgram("pci/dss");
    await methods.attestComplianceProgram("pci/dss", attestation);
    await methods.revokeComplianceProgram(
      "pci/dss",
      "Certificate expired",
      revision,
    );
    await methods.listComplianceEvents("pci/dss");

    expect(calls).toEqual([
      {
        path: "/api/v1/compliance/programs",
        init: undefined,
        opts: undefined,
      },
      {
        path: "/api/v1/compliance/programs/pci%2Fdss",
        init: undefined,
        opts: undefined,
      },
      {
        path: "/api/v1/compliance/programs/pci%2Fdss/attest",
        init: { method: "POST", body: JSON.stringify(attestation) },
        opts: undefined,
      },
      {
        path: "/api/v1/compliance/programs/pci%2Fdss/revoke",
        init: {
          method: "POST",
          body: JSON.stringify({
            reason: "Certificate expired",
            expectedUpdatedAt: revision,
          }),
        },
        opts: undefined,
      },
      {
        path: "/api/v1/compliance/programs/pci%2Fdss/events",
        init: undefined,
        opts: undefined,
      },
    ]);
  });

  it("preserves BYOK catalog, creation, activation, health, and deletion transports", async () => {
    const { calls, methods } = createHarness();
    const keyInput = {
      provider: "aws-kms",
      key_ref: "arn:aws:kms:us-east-1:123:key/abc",
      description: "Primary customer key",
    };

    await methods.byokListKeys();
    await methods.byokListProviders();
    await methods.byokCreateKey(keyInput);
    await methods.byokActivateKey("key/one");
    await methods.byokHealthCheck("key/one");
    await methods.byokDeleteKey("key/one");

    expect(calls).toEqual([
      {
        path: "/api/v1/byok/keys",
        init: undefined,
        opts: undefined,
      },
      {
        path: "/api/v1/byok/providers",
        init: undefined,
        opts: undefined,
      },
      {
        path: "/api/v1/byok/keys",
        init: { method: "POST", body: JSON.stringify(keyInput) },
        opts: undefined,
      },
      {
        path: "/api/v1/byok/keys/key%2Fone/activate",
        init: { method: "POST", body: "{}" },
        opts: undefined,
      },
      {
        path: "/api/v1/byok/keys/key%2Fone/health",
        init: { method: "POST", body: "{}" },
        opts: undefined,
      },
      {
        path: "/api/v1/byok/keys/key%2Fone",
        init: { method: "DELETE" },
        opts: undefined,
      },
    ]);
  });

  it("retains match-query defaults and passes request errors through unchanged", async () => {
    const expectedError: ApiErr = {
      error: { kind: "http", status: 503, message: "Unavailable" },
    };
    const { calls, methods } = createHarness([expectedError]);

    await expect(methods.inboundRouteMatchesList("route/one")).resolves.toBe(
      expectedError,
    );
    await methods.inboundRouteMatchesList("route/one", { limit: 0 });

    expect(calls).toEqual([
      {
        path: "/api/v1/inbound-routes/route%2Fone/matches",
        init: undefined,
        opts: undefined,
      },
      {
        path: "/api/v1/inbound-routes/route%2Fone/matches?limit=0",
        init: undefined,
        opts: undefined,
      },
    ]);
  });
});
