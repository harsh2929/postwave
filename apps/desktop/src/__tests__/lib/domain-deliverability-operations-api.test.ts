import { describe, expect, it } from "vitest";

import { api } from "../../lib/api-client";
import {
  createDomainDeliverabilityOperationsMethods,
  type DomainDeliverabilityOperationsDependencies,
  type DomainDeliverabilityRequester,
  type DomainDeliverabilityRequestOptions,
} from "../../lib/api/domain-deliverability-operations";
import type { ApiResult } from "../../lib/api/result";

interface RequestCall {
  path: string;
  init: RequestInit | undefined;
  opts: DomainDeliverabilityRequestOptions | undefined;
}

const METHOD_NAMES = [
  "listCustomDomains",
  "createCustomDomain",
  "getCustomDomain",
  "verifyCustomDomain",
  "deleteCustomDomain",
  "listDnsHealth",
  "listDnsHealthIssues",
  "runDnsHealthNow",
  "getSenderReputation",
  "getSenderReputationHistory",
  "listDmarcReports",
  "getDmarcInsights",
  "getDmarcSourceDetail",
  "ackDmarcSuggestion",
  "unackDmarcSuggestion",
] as const;

const METHOD_NAME_SET = new Set<string>(METHOD_NAMES);

function createHarness(responses: ApiResult<unknown>[] = []) {
  const calls: RequestCall[] = [];
  const queuedResponses = [...responses];
  const request: DomainDeliverabilityRequester = async <T>(
    path: string,
    init?: RequestInit,
    opts?: DomainDeliverabilityRequestOptions,
  ): Promise<ApiResult<T>> => {
    calls.push({ path, init, opts });
    return (queuedResponses.shift() ?? { data: {} }) as ApiResult<T>;
  };
  const dependencies: DomainDeliverabilityOperationsDependencies = {
    request,
  };
  return {
    calls,
    methods: createDomainDeliverabilityOperationsMethods(dependencies),
  };
}

describe("domain and deliverability operations API extraction contracts", () => {
  it("retains the exact ordered 15-method inventory without eager work", () => {
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

  it("preserves safe reads and DNS-health transports while holding every custom-domain mutation", async () => {
    const { calls, methods } = createHarness();

    await methods.listCustomDomains();
    await methods.getCustomDomain("domain/one");
    await methods.listDnsHealth();
    await methods.listDnsHealthIssues();
    await methods.runDnsHealthNow();

    await expect(
      methods.createCustomDomain({
        domain: " Example.COM ",
        purpose: "links",
      }),
    ).resolves.toMatchObject({
      error: { code: "custom_domain_registration_unavailable", status: 503 },
      retryability: "not-retryable",
    });
    await expect(methods.verifyCustomDomain("domain/one")).resolves.toMatchObject(
      {
        error: { code: "custom_domain_verification_unavailable", status: 503 },
        retryability: "not-retryable",
      },
    );
    await expect(methods.deleteCustomDomain("domain/one")).resolves.toMatchObject(
      {
        error: { code: "custom_domain_removal_unavailable", status: 503 },
        retryability: "not-retryable",
      },
    );

    expect(calls).toEqual([
      {
        path: "/api/v1/custom-domains",
        init: { cache: "no-store" },
        opts: undefined,
      },
      {
        path: "/api/v1/custom-domains/domain%2Fone",
        init: { cache: "no-store" },
        opts: undefined,
      },
      { path: "/api/v1/dns-health", init: undefined, opts: undefined },
      {
        path: "/api/v1/dns-health/issues",
        init: undefined,
        opts: undefined,
      },
      {
        path: "/api/v1/dns-health/run-now",
        init: { method: "POST", body: "{}" },
        opts: undefined,
      },
    ]);
  });

  it("preserves sender-reputation summary and encoded history transports", async () => {
    const { calls, methods } = createHarness();

    await methods.getSenderReputation();
    await methods.getSenderReputationHistory("mail/example.com");

    expect(calls).toEqual([
      {
        path: "/api/v1/sender-reputation",
        init: undefined,
        opts: undefined,
      },
      {
        path: "/api/v1/sender-reputation/mail%2Fexample.com/history",
        init: undefined,
        opts: undefined,
      },
    ]);
  });

  it("preserves DMARC report, insight, and source-detail query transports", async () => {
    const { calls, methods } = createHarness();
    const controller = new AbortController();

    await methods.listDmarcReports({
      domain: "example.com",
      from: "2026-07-01",
      to: "2026-07-16",
      limit: 50,
      signal: controller.signal,
    });
    await methods.getDmarcInsights({
      domain: "example.com",
      days: 30,
      signal: controller.signal,
    });
    await methods.getDmarcSourceDetail({
      ip: "192.0.2.1",
      domain: "example.com",
      days: 14,
      signal: controller.signal,
    });

    expect(calls).toEqual([
      {
        path: "/api/v1/deliverability/dmarc-reports?domain=example.com&from=2026-07-01&to=2026-07-16&limit=50",
        init: { cache: "no-store" },
        opts: { signal: controller.signal },
      },
      {
        path: "/api/v1/deliverability/dmarc-insights?domain=example.com&days=30",
        init: { cache: "no-store" },
        opts: { signal: controller.signal },
      },
      {
        path: "/api/v1/deliverability/dmarc-sources?ip=192.0.2.1&domain=example.com&days=14",
        init: { cache: "no-store" },
        opts: { signal: controller.signal },
      },
    ]);
  });

  it("preserves DMARC suggestion acknowledgement and restoration transports", async () => {
    const { calls, methods } = createHarness();

    await methods.ackDmarcSuggestion("policy/reject", "Investigating");
    await methods.unackDmarcSuggestion("policy/reject");

    expect(calls).toEqual([
      {
        path: "/api/v1/deliverability/dmarc-suggestions/ack",
        init: {
          method: "POST",
          body: JSON.stringify({
            code: "policy/reject",
            note: "Investigating",
          }),
        },
        opts: undefined,
      },
      {
        path: "/api/v1/deliverability/dmarc-suggestions/ack/policy%2Freject",
        init: { method: "DELETE" },
        opts: undefined,
      },
    ]);
  });

  it("retains empty-query defaults and passes request errors through unchanged", async () => {
    const expectedError = {
      error: { kind: "http" as const, status: 503, message: "Unavailable" },
    };
    const { calls, methods } = createHarness([expectedError]);

    await expect(methods.listDmarcReports()).resolves.toBe(expectedError);
    await methods.getDmarcInsights();
    await methods.getDmarcSourceDetail({ ip: "192.0.2.1" });
    await methods.ackDmarcSuggestion("policy/reject");

    expect(calls).toEqual([
      {
        path: "/api/v1/deliverability/dmarc-reports",
        init: { cache: "no-store" },
        opts: undefined,
      },
      {
        path: "/api/v1/deliverability/dmarc-insights",
        init: { cache: "no-store" },
        opts: undefined,
      },
      {
        path: "/api/v1/deliverability/dmarc-sources?ip=192.0.2.1",
        init: { cache: "no-store" },
        opts: undefined,
      },
      {
        path: "/api/v1/deliverability/dmarc-suggestions/ack",
        init: {
          method: "POST",
          body: JSON.stringify({ code: "policy/reject", note: "" }),
        },
        opts: undefined,
      },
    ]);
  });
});
