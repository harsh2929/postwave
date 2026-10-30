import { describe, expect, it } from "vitest";

import { api } from "../../lib/api-client";
import {
  createAgencyOperationsMethods,
  type AgencyOperationsDependencies,
  type AgencyRequester,
  type AgencyRequestOptions,
} from "../../lib/api/agency-operations";
import type { ApiErr, ApiResult } from "../../lib/api/result";

const TENANT_A = "47000000-0000-4000-8000-000000000099";
const TENANT_B = "47000000-0000-4000-8000-000000000088";

interface RequestCall {
  path: string;
  init: RequestInit | undefined;
  opts: AgencyRequestOptions | undefined;
}

const METHOD_NAMES = [
  "agencyListChildren",
  "agencyCreateChild",
  "agencyUnlinkChild",
  "agencyGetBranding",
  "agencyUpdateBranding",
  "agencyInvoicePreview",
  "agencySetBillingMode",
] as const;

const METHOD_NAME_SET = new Set<string>(METHOD_NAMES);

function createHarness(
  responses: ApiResult<unknown>[] = [],
  emitExactETag = true,
) {
  const calls: RequestCall[] = [];
  const queuedResponses = [...responses];
  const request: AgencyRequester = async <T>(
    path: string,
    init?: RequestInit,
    opts?: AgencyRequestOptions,
  ): Promise<ApiResult<T>> => {
    calls.push({ path, init, opts });
    const response = queuedResponses.shift() ?? { data: {} };
    if (
      emitExactETag &&
      !response.error &&
      typeof response.serverVersion === "string"
    ) {
      opts?.onResponseHeaders?.(new Headers({ etag: response.serverVersion }));
    }
    return response as ApiResult<T>;
  };
  const dependencies: AgencyOperationsDependencies = { request };
  return {
    calls,
    methods: createAgencyOperationsMethods(dependencies),
  };
}

describe("agency operations API extraction contracts", () => {
  it("retains the exact ordered seven-method inventory without eager work", () => {
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

  it("transports only bounded roster pages and the branding read", async () => {
    const { calls, methods } = createHarness();

    await methods.agencyListChildren();
    await methods.agencyListChildren({
      limit: 200,
      cursor: "eyJpZCI6ImN1cnNvci0xIn0",
    });
    await methods.agencyGetBranding({ expectedTenantId: TENANT_A });

    expect(calls).toEqual([
      {
        path: "/api/v1/agency/children",
        init: undefined,
        opts: undefined,
      },
      {
        path: "/api/v1/agency/children?limit=200&cursor=eyJpZCI6ImN1cnNvci0xIn0",
        init: undefined,
        opts: undefined,
      },
      {
        path: "/api/v1/agency/branding",
        init: undefined,
        opts: { onResponseHeaders: expect.any(Function) },
      },
    ]);
  });

  it("binds branding provenance to the current workspace before and after transport", async () => {
    const invalid = createHarness();
    await expect(
      invalid.methods.agencyGetBranding({ expectedTenantId: "not-a-tenant" }),
    ).resolves.toMatchObject({
      error: {
        kind: "invalid_config",
        code: "invalid_agency_branding_authority",
      },
      retryability: "not-retryable",
    });
    expect(invalid.calls).toEqual([]);

    const crossTenantETag = `"agency-branding:${TENANT_B}:v7"`;
    const crossTenant = createHarness([
      {
        data: { etag: crossTenantETag },
        serverVersion: crossTenantETag,
      },
    ]);
    await expect(
      crossTenant.methods.agencyGetBranding({ expectedTenantId: TENANT_A }),
    ).resolves.toMatchObject({
      error: {
        kind: "parse",
        code: "agency_branding_etag_mismatch",
      },
      retryability: "not-retryable",
    });
    expect(crossTenant.calls).toHaveLength(1);

    const sameTenantETag = `"agency-branding:${TENANT_A}:v7"`;
    const verified = createHarness([
      {
        data: { etag: sameTenantETag },
        serverVersion: sameTenantETag,
      },
    ]);
    await expect(
      verified.methods.agencyGetBranding({ expectedTenantId: TENANT_A }),
    ).resolves.toMatchObject({ data: { etag: sameTenantETag } });

    const genericVersionOnly = createHarness(
      [
        {
          data: { etag: sameTenantETag },
          serverVersion: sameTenantETag,
        },
      ],
      false,
    );
    await expect(
      genericVersionOnly.methods.agencyGetBranding({
        expectedTenantId: TENANT_A,
      }),
    ).resolves.toMatchObject({
      error: {
        kind: "parse",
        code: "agency_branding_etag_mismatch",
      },
    });

    const malformedRevisionETag = `"agency-branding:${TENANT_A}:v01"`;
    const malformedRevision = createHarness([
      {
        data: { etag: malformedRevisionETag },
        serverVersion: malformedRevisionETag,
      },
    ]);
    await expect(
      malformedRevision.methods.agencyGetBranding({
        expectedTenantId: TENANT_A,
      }),
    ).resolves.toMatchObject({
      error: {
        kind: "parse",
        code: "agency_branding_etag_mismatch",
      },
    });
  });

  it("rejects invalid roster paging locally", async () => {
    const { calls, methods } = createHarness();

    for (const options of [
      { limit: 0 },
      { limit: 201 },
      { limit: 1.5 },
      { cursor: "" },
      { cursor: "not/base64+url=" },
    ]) {
      await expect(methods.agencyListChildren(options)).resolves.toMatchObject({
        error: {
          kind: "invalid_config",
          code: "invalid_agency_children_page",
        },
        retryability: "not-retryable",
      });
    }
    expect(calls).toEqual([]);
  });

  it("returns typed local release holds for every unsafe mutation and projection", async () => {
    const { calls, methods } = createHarness();
    const create = {
      slug: "customer-success",
      name: "Customer Success",
      tier: "pro" as const,
      billing_mode: "parent" as const,
      reseller_markup_bps: 1500,
    };
    const patch = {
      whitelabel_enabled: true,
      brand_name: "Acme Mail",
      custom_domain: "mail.acme.example",
      logo_url: "https://acme.example/logo.svg",
      primary_color: "#123456",
      support_email: "support@acme.example",
      legal_entity: "Acme, Inc.",
    };
    const billing = {
      target_tenant_id: "tenant/one",
      mode: "parent" as const,
      reason: "Agency consolidated billing",
    };

    const results: ApiErr[] = [
      await methods.agencyCreateChild(create),
      await methods.agencyUnlinkChild("tenant/one"),
      await methods.agencyUpdateBranding(patch),
      await methods.agencyInvoicePreview(45),
      await methods.agencySetBillingMode(billing),
    ];

    expect(calls).toEqual([]);
    expect(results.map((result) => result.error.code)).toEqual([
      "agency_child_create_release_hold",
      "agency_child_unlink_release_hold",
      "agency_branding_update_release_hold",
      "agency_invoice_preview_release_hold",
      "agency_billing_mode_release_hold",
    ]);
    for (const result of results) {
      expect(result).toMatchObject({
        error: { kind: "http", status: 503 },
        retryability: "not-retryable",
      });
    }
  });
});
