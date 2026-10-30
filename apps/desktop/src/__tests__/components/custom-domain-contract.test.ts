import { describe, expect, it } from "vitest";

import type { CustomDomain } from "../../lib/api-client";
import {
  CUSTOM_DOMAIN_LIST_LIMIT,
  customDomainPurposeLabel,
  filterAndSortCustomDomains,
  inventoryForCustomDomains,
  parseCustomDomainList,
  parseDomainVerification,
} from "../../components/domains/custom-domain-contract";

const VALID_RECORD = {
  type: "cname",
  name: "mail.example.test",
  value: "target.example.test.",
  verified: true,
  error: "DNS answer has not propagated yet",
};

const VALID_DOMAIN = {
  id: "domain_1:primary",
  tenantId: "tenant-1",
  domain: "MAIL.Example.Test",
  purpose: "forms",
  verified: true,
  dns_records: [VALID_RECORD],
  createdAt: "2026-08-03T10:00:00.000Z",
  verifiedAt: "2026-08-03T10:05:00.000Z",
};

function withRecord(record: unknown): Record<string, unknown> {
  return { ...VALID_DOMAIN, dns_records: [record] };
}

function row(overrides: Partial<CustomDomain> = {}): CustomDomain {
  return {
    id: "domain-1",
    domain: "mail.example.test",
    purpose: "forms",
    verified: false,
    dns_records: [],
    ...overrides,
  };
}

describe("parseCustomDomainList", () => {
  it("accepts the complete current wire shape and canonicalizes rendered fields", () => {
    expect(
      parseCustomDomainList([
        {
          ...VALID_DOMAIN,
          ignored_private_field: "must not cross the contract",
          dns_records: [
            {
              ...VALID_RECORD,
              ignored_private_field: "must not cross the contract",
            },
          ],
        },
      ]),
    ).toEqual([
      {
        id: "domain_1:primary",
        tenantId: "tenant-1",
        domain: "mail.example.test",
        purpose: "forms",
        verified: true,
        dns_records: [
          {
            type: "CNAME",
            name: "mail.example.test",
            value: "target.example.test.",
            verified: true,
            error: "DNS answer has not propagated yet",
          },
        ],
        createdAt: "2026-08-03T10:00:00.000Z",
        verifiedAt: "2026-08-03T10:05:00.000Z",
      },
    ]);
    expect(parseCustomDomainList([])).toEqual([]);
  });

  it("preserves explicit null verification time and omits empty optional dates", () => {
    expect(
      parseCustomDomainList([
        {
          ...VALID_DOMAIN,
          createdAt: "",
          verifiedAt: null,
          dns_records: [
            {
              type: "txt",
              name: "mail.example.test",
              value: "v=spf1 -all",
              error: "",
            },
          ],
        },
      ]),
    ).toEqual([
      {
        id: VALID_DOMAIN.id,
        tenantId: VALID_DOMAIN.tenantId,
        domain: "mail.example.test",
        purpose: VALID_DOMAIN.purpose,
        verified: true,
        dns_records: [
          {
            type: "TXT",
            name: "mail.example.test",
            value: "v=spf1 -all",
          },
        ],
        verifiedAt: null,
      },
    ]);
  });

  it("accepts every exact documented size boundary", () => {
    const boundaryRecord = {
      type: "a".repeat(16),
      name: "n".repeat(270),
      value: "v".repeat(2_048),
      error: "e".repeat(512),
    };
    const boundaryDomain = {
      ...VALID_DOMAIN,
      id: `a${"b".repeat(127)}`,
      tenantId: "t".repeat(128),
      domain: "d".repeat(253),
      purpose: "p".repeat(32),
      dns_records: Array.from({ length: 16 }, () => boundaryRecord),
    };
    const maximumList = Array.from(
      { length: CUSTOM_DOMAIN_LIST_LIMIT },
      (_, index) => ({ ...VALID_DOMAIN, id: `domain-${index}` }),
    );

    expect(
      parseCustomDomainList([boundaryDomain])?.[0]?.dns_records,
    ).toHaveLength(16);
    expect(parseCustomDomainList(maximumList)).toHaveLength(
      CUSTOM_DOMAIN_LIST_LIMIT,
    );
  });

  it.each([
    ["null", null],
    ["an object envelope", { domains: [VALID_DOMAIN] }],
    ["a string", "domains"],
    [
      "a list over the hard cap",
      Array.from({ length: CUSTOM_DOMAIN_LIST_LIMIT + 1 }, () => VALID_DOMAIN),
    ],
  ])("fails closed for %s", (_label, candidate) => {
    expect(parseCustomDomainList(candidate)).toBeNull();
  });

  it.each([
    ["a non-object row", null],
    ["an array row", []],
    ["a missing id", { ...VALID_DOMAIN, id: undefined }],
    ["an empty id", { ...VALID_DOMAIN, id: "" }],
    ["an invalid id prefix", { ...VALID_DOMAIN, id: "-domain" }],
    ["id whitespace", { ...VALID_DOMAIN, id: "domain one" }],
    ["an oversized id", { ...VALID_DOMAIN, id: "a".repeat(129) }],
    ["an empty domain", { ...VALID_DOMAIN, domain: "" }],
    ["a control in domain", { ...VALID_DOMAIN, domain: "mail\nexample.test" }],
    ["an oversized domain", { ...VALID_DOMAIN, domain: "d".repeat(254) }],
    ["an empty purpose", { ...VALID_DOMAIN, purpose: "" }],
    ["a control in purpose", { ...VALID_DOMAIN, purpose: "send\u0000ing" }],
    ["an oversized purpose", { ...VALID_DOMAIN, purpose: "p".repeat(33) }],
    ["a non-boolean status", { ...VALID_DOMAIN, verified: "true" }],
    ["missing records", { ...VALID_DOMAIN, dns_records: undefined }],
    ["non-array records", { ...VALID_DOMAIN, dns_records: {} }],
    [
      "too many records",
      {
        ...VALID_DOMAIN,
        dns_records: Array.from({ length: 17 }, () => VALID_RECORD),
      },
    ],
    ["a non-string creation date", { ...VALID_DOMAIN, createdAt: 1 }],
    ["an unparseable creation date", { ...VALID_DOMAIN, createdAt: "later" }],
    [
      "a normalized impossible creation date",
      { ...VALID_DOMAIN, createdAt: "2026-02-30T09:00:00Z" },
    ],
    [
      "an invalid verification timezone",
      { ...VALID_DOMAIN, verifiedAt: "2026-02-02T09:00:00+25:00" },
    ],
    [
      "a control-bearing tenant id",
      { ...VALID_DOMAIN, tenantId: "tenant\u0000spoof" },
    ],
  ])("rejects a domain row with %s", (_label, candidate) => {
    expect(parseCustomDomainList([candidate])).toBeNull();
  });

  it.each([
    ["a non-object record", null],
    ["a missing type", { ...VALID_RECORD, type: undefined }],
    ["an empty type", { ...VALID_RECORD, type: "" }],
    ["an invalid type token", { ...VALID_RECORD, type: "C NAME" }],
    ["an oversized type", { ...VALID_RECORD, type: "a".repeat(17) }],
    ["a missing name", { ...VALID_RECORD, name: undefined }],
    ["an empty name", { ...VALID_RECORD, name: "" }],
    ["a control in name", { ...VALID_RECORD, name: "mail\n.example.test" }],
    ["an oversized name", { ...VALID_RECORD, name: "n".repeat(271) }],
    ["a missing value", { ...VALID_RECORD, value: undefined }],
    ["an empty value", { ...VALID_RECORD, value: "" }],
    ["a control in value", { ...VALID_RECORD, value: "safe\u007funsafe" }],
    ["an oversized value", { ...VALID_RECORD, value: "v".repeat(2_049) }],
    ["a non-boolean result", { ...VALID_RECORD, verified: "yes" }],
    ["a non-string error", { ...VALID_RECORD, error: 500 }],
    ["an oversized error", { ...VALID_RECORD, error: "e".repeat(513) }],
    [
      "a control-bearing error",
      { ...VALID_RECORD, error: "lookup failed\nprivate detail" },
    ],
  ])("rejects a domain containing %s", (_label, candidate) => {
    expect(parseCustomDomainList([withRecord(candidate)])).toBeNull();
  });
});

describe("parseDomainVerification", () => {
  it("accepts a result without record detail and projects no unknown fields", () => {
    expect(
      parseDomainVerification({
        verified: false,
        private_detail: "not renderer data",
      }),
    ).toEqual({ verified: false });
  });

  it("strictly parses and normalizes every verification record", () => {
    expect(
      parseDomainVerification({
        verified: true,
        records: [
          {
            type: "txt",
            name: "_dmarc.example.test",
            value: "v=DMARC1; p=reject",
            verified: true,
          },
        ],
      }),
    ).toEqual({
      verified: true,
      records: [
        {
          type: "TXT",
          name: "_dmarc.example.test",
          value: "v=DMARC1; p=reject",
          verified: true,
        },
      ],
    });
  });

  it.each([
    ["a non-object envelope", null],
    ["a missing result", {}],
    ["a non-boolean result", { verified: "true" }],
    ["non-array records", { verified: true, records: {} }],
    [
      "too many records",
      {
        verified: true,
        records: Array.from({ length: 17 }, () => VALID_RECORD),
      },
    ],
    [
      "one malformed record",
      {
        verified: true,
        records: [{ ...VALID_RECORD, value: "" }],
      },
    ],
  ])("fails closed for %s", (_label, candidate) => {
    expect(parseDomainVerification(candidate)).toBeNull();
  });
});

describe("custom-domain inventory and purpose labels", () => {
  it("counts verified and pending rows without exposing a mutable input array", () => {
    const rows = [
      row({ id: "verified-1", verified: true }),
      row({ id: "pending-1" }),
      row({ id: "verified-2", verified: true }),
    ];
    const inventory = inventoryForCustomDomains(rows);

    expect(inventory).toEqual({
      rows,
      total: 3,
      verified: 2,
      pending: 1,
    });
    expect(inventory.rows).not.toBe(rows);
    inventory.rows.pop();
    expect(rows).toHaveLength(3);
  });

  it("labels every closed purpose and uses an honest forward-compatible fallback", () => {
    expect(customDomainPurposeLabel("forms")).toBe("Legacy form hostname");
    expect(customDomainPurposeLabel("links")).toBe("Legacy link hostname");
    expect(customDomainPurposeLabel("web")).toBe("Legacy hosted-web hostname");
    expect(customDomainPurposeLabel("tracking")).toBe(
      "Legacy tracking hostname",
    );
    expect(customDomainPurposeLabel("sending")).toBe("Legacy custom hostname");
    expect(customDomainPurposeLabel("future-purpose")).toBe(
      "Legacy custom hostname",
    );
  });
});

describe("filterAndSortCustomDomains", () => {
  const rows = [
    row({
      id: "zeta",
      domain: "zeta.example.test",
      purpose: "forms",
      verified: true,
      createdAt: "2026-08-03T00:00:00Z",
    }),
    row({
      id: "alpha",
      domain: "alpha.example.test",
      purpose: "links",
      createdAt: "2026-08-01T00:00:00Z",
    }),
    row({
      id: "middle",
      domain: "middle.example.test",
      purpose: "tracking",
      verified: true,
    }),
    row({
      id: "beta",
      domain: "beta.example.test",
      purpose: "web",
      createdAt: "2026-08-02T00:00:00Z",
    }),
  ] satisfies CustomDomain[];

  it("matches trimmed case-insensitive domain and human purpose-label queries", () => {
    expect(
      filterAndSortCustomDomains(rows, "  ZETA.EXAMPLE  ", "all", "domain").map(
        ({ id }) => id,
      ),
    ).toEqual(["zeta"]);
    expect(
      filterAndSortCustomDomains(rows, " HOSTED-WEB ", "all", "domain").map(
        ({ id }) => id,
      ),
    ).toEqual(["beta"]);
    expect(
      filterAndSortCustomDomains(
        rows,
        "tracking hostname",
        "all",
        "domain",
      ).map(({ id }) => id),
    ).toEqual(["middle"]);
  });

  it("bounds an oversized query before matching", () => {
    const maximumDomain = "a".repeat(253);
    expect(
      filterAndSortCustomDomains(
        [row({ domain: maximumDomain })],
        `${maximumDomain}ignored-suffix`,
        "all",
        "domain",
      ),
    ).toHaveLength(1);
  });

  it("applies verified and pending filters", () => {
    expect(
      filterAndSortCustomDomains(rows, "", "verified", "domain").map(
        ({ id }) => id,
      ),
    ).toEqual(["middle", "zeta"]);
    expect(
      filterAndSortCustomDomains(rows, "", "pending", "domain").map(
        ({ id }) => id,
      ),
    ).toEqual(["alpha", "beta"]);
    expect(
      filterAndSortCustomDomains(rows, "no-match", "all", "domain"),
    ).toEqual([]);
  });

  it("sorts alphabetically and by pending-before-verified status", () => {
    expect(
      filterAndSortCustomDomains(rows, "", "all", "domain").map(({ id }) => id),
    ).toEqual(["alpha", "beta", "middle", "zeta"]);
    expect(
      filterAndSortCustomDomains(rows, "", "all", "status").map(({ id }) => id),
    ).toEqual(["alpha", "beta", "middle", "zeta"]);
  });

  it("sorts dates in both directions and treats missing dates as epoch-zero", () => {
    expect(
      filterAndSortCustomDomains(rows, "", "all", "oldest").map(({ id }) => id),
    ).toEqual(["middle", "alpha", "beta", "zeta"]);
    expect(
      filterAndSortCustomDomains(rows, "", "all", "newest").map(({ id }) => id),
    ).toEqual(["zeta", "beta", "alpha", "middle"]);
  });

  it("returns a new collection and never reorders the caller's rows", () => {
    const originalOrder = rows.map(({ id }) => id);
    const sorted = filterAndSortCustomDomains(rows, "", "all", "domain");

    expect(sorted).not.toBe(rows);
    expect(rows.map(({ id }) => id)).toEqual(originalOrder);
  });
});
