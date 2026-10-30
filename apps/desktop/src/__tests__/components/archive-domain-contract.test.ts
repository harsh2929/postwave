import { describe, expect, it } from "vitest";

import { parseArchiveCustomDomainStatus } from "../../components/settings/archive-domain-contract";

const valid = {
  domain: "news.example.com",
  cname_target: "custom-domains.moosewave.com",
  verification_token: "token",
  status: "verified",
  ssl_status: "issued",
};

describe("archive domain runtime contract", () => {
  it("accepts a complete status envelope", () => {
    expect(parseArchiveCustomDomainStatus(valid)).toEqual(valid);
  });

  it("rejects incomplete successful responses", () => {
    expect(parseArchiveCustomDomainStatus({})).toBeNull();
    expect(
      parseArchiveCustomDomainStatus({ ...valid, domain: undefined }),
    ).toBeNull();
  });

  it("rejects unknown lifecycle states", () => {
    expect(
      parseArchiveCustomDomainStatus({ ...valid, ssl_status: "ready" }),
    ).toBeNull();
  });
});
