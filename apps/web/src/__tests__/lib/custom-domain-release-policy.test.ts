import { afterEach, describe, expect, it, vi } from "vitest";

import { verifyArchiveDomain } from "@/lib/archive-admin-api";
import {
  CUSTOM_DOMAIN_AUTOMATED_TLS_AVAILABLE,
  CUSTOM_DOMAIN_DEPENDENCY_INVENTORY_AVAILABLE,
  CUSTOM_DOMAIN_PRODUCTION_ROUTING_AVAILABLE,
} from "@/lib/custom-domain-operational-availability";
import {
  createCustomDomain,
  deleteCustomDomain,
  getCustomDomainEvidence,
  listCustomDomains,
  parseCustomDomainList,
  verifyCustomDomain,
} from "@/lib/custom-domains-api";

const row = {
  id: "domain-1",
  tenantId: "tenant-1",
  domain: "news.example.test",
  purpose: "forms",
  verified: true,
  dns_records: [
    {
      type: "CNAME",
      name: "news.example.test",
      value: "edge.moosewave.com",
      verified: true,
    },
  ],
  createdAt: "2026-08-20T09:00:00Z",
  verifiedAt: "2026-08-21T09:00:00Z",
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("custom-domain release policy", () => {
  it("keeps every serving prerequisite and mutation fail-closed", async () => {
    expect(CUSTOM_DOMAIN_AUTOMATED_TLS_AVAILABLE).toBe(false);
    expect(CUSTOM_DOMAIN_DEPENDENCY_INVENTORY_AVAILABLE).toBe(false);
    expect(CUSTOM_DOMAIN_PRODUCTION_ROUTING_AVAILABLE).toBe(false);

    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    for (const [operation, invoke] of [
      [
        "registration",
        () =>
          createCustomDomain({ domain: "new.example.test", purpose: "forms" }),
      ],
      ["verification", () => verifyCustomDomain("domain-1")],
      ["removal", () => deleteCustomDomain("domain-1")],
      ["verification", () => verifyArchiveDomain()],
    ] as const) {
      await expect(invoke()).rejects.toMatchObject({
        code: `custom_domain_${operation}_unavailable`,
        retryable: false,
        status: 503,
      });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("accepts bounded tenant-owned legacy evidence and rejects mixed tenants", () => {
    expect(parseCustomDomainList([row], "tenant-1")).toEqual([row]);
    expect(() => parseCustomDomainList([row], "tenant-2")).toThrow(
      /workspace boundary/i,
    );
  });

  it("rejects duplicate identities and contradictory aggregate evidence", () => {
    expect(() => parseCustomDomainList([row, row], "tenant-1")).toThrow(
      /duplicate/i,
    );
    expect(() =>
      parseCustomDomainList(
        [
          {
            ...row,
            dns_records: [{ ...row.dns_records[0], verified: false }],
          },
        ],
        "tenant-1",
      ),
    ).toThrow(/contradicted/i);
    expect(() =>
      parseCustomDomainList([{ ...row, createdAt: "last Thursday" }]),
    ).toThrow(/creation time/i);
    expect(() =>
      parseCustomDomainList([{ ...row, verifiedAt: "2026-08-19T09:00:00Z" }]),
    ).toThrow(/preceded/i);
  });

  it("preserves the safe authenticated list read with abort and online-only options", async () => {
    const fetchMock = vi.fn(async (..._args: Parameters<typeof fetch>) =>
      Response.json([row]),
    );
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();

    await expect(
      listCustomDomains({
        signal: controller.signal,
        expectedTenantId: "tenant-1",
      }),
    ).resolves.toEqual([row]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("http://localhost:8080/api/v1/custom-domains");
    expect(init.method).toBe("GET");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.signal?.aborted).toBe(false);
  });

  it("minimizes list-cache evidence and fetches it only through an identity-bound detail read", async () => {
    const fetchMock = vi.fn(async () => Response.json([row]));
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      listCustomDomains({
        expectedTenantId: "tenant-1",
        minimizeDNSEvidence: true,
      }),
    ).resolves.toEqual([{ ...row, dns_records: [] }]);

    fetchMock.mockResolvedValueOnce(Response.json(row));
    await expect(
      getCustomDomainEvidence({
        id: "domain-1",
        expectedTenantId: "tenant-1",
      }),
    ).resolves.toEqual(row);
    const calls = fetchMock.mock.calls as unknown[][];
    expect(calls.at(1)?.at(0)).toBe(
      "http://localhost:8080/api/v1/custom-domains/domain-1",
    );

    fetchMock.mockResolvedValueOnce(Response.json({ ...row, id: "domain-2" }));
    await expect(
      getCustomDomainEvidence({
        id: "domain-1",
        expectedTenantId: "tenant-1",
      }),
    ).rejects.toThrow(/did not match/i);
  });
});
