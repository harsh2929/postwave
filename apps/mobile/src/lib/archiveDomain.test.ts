import { describe, expect, it } from "vitest";

import {
  ARCHIVE_DOMAIN_INVALID,
  ARCHIVE_DOMAIN_RESERVED,
  archiveCnameSentence,
  archiveDnsRecord,
  archiveDomainDirty,
  archiveDomainShouldPoll,
  archiveDomainWriteError,
  archivePublicUrl,
  archiveSslSentence,
  archiveTxtRecord,
  archiveVerifyOutcome,
  isArchiveDomainStatus,
  normalizeArchiveDomainSettings,
  normalizeArchiveDomainStatus,
  validateArchiveDomain,
  type ArchiveDomainStatus,
} from "./archiveDomain";

/** The envelope LookupCustomDomain answers for a configured, pending host. */
const WIRE = {
  domain: "news.example.com",
  cname_target: "custom-domains.moosewave.com",
  verification_token: "abc123",
  status: "pending",
  ssl_status: "pending",
  last_checked_at: "2026-09-03T10:00:00Z",
  verified_at: "",
  last_error: "",
  ssl_last_error: "",
};

const PENDING: ArchiveDomainStatus = {
  domain: "news.example.com",
  cnameTarget: "custom-domains.moosewave.com",
  verificationToken: "abc123",
  status: "pending",
  sslStatus: "pending",
  lastCheckedAt: "2026-09-03T10:00:00Z",
  verifiedAt: "",
  lastError: "",
  sslLastError: "",
};

describe("normalizeArchiveDomainStatus", () => {
  it("reads the handler's envelope", () => {
    expect(normalizeArchiveDomainStatus(WIRE)).toEqual(PENDING);
  });

  it("reads the ZERO-VALUE envelope an unconfigured tenant gets", () => {
    expect(
      normalizeArchiveDomainStatus({
        domain: "",
        cname_target: "custom-domains.moosewave.com",
        verification_token: "",
        status: "pending",
        ssl_status: "pending",
      }),
    ).toEqual({
      domain: "",
      cnameTarget: "custom-domains.moosewave.com",
      verificationToken: "",
      status: "pending",
      sslStatus: "pending",
      lastCheckedAt: "",
      verifiedAt: "",
      lastError: "",
      sslLastError: "",
    });
  });

  it("refuses an enum value this client does not know — never coerces to pending", () => {
    expect(
      normalizeArchiveDomainStatus({ ...WIRE, status: "provisioning" }),
    ).toBeNull();
    expect(
      normalizeArchiveDomainStatus({ ...WIRE, ssl_status: "renewing" }),
    ).toBeNull();
    expect(normalizeArchiveDomainStatus({ ...WIRE, status: "" })).toBeNull();
  });

  it("refuses the shapes a shared cache can hold instead of a row", () => {
    expect(normalizeArchiveDomainStatus(null)).toBeNull();
    expect(normalizeArchiveDomainStatus([WIRE])).toBeNull();
    expect(normalizeArchiveDomainStatus("pending")).toBeNull();
  });

  it("canonicalises the host the way the citext column does", () => {
    expect(
      normalizeArchiveDomainStatus({ ...WIRE, domain: "  News.Example.COM " })
        ?.domain,
    ).toBe("news.example.com");
  });
});

describe("isArchiveDomainStatus", () => {
  it("accepts a normalized row and rejects everything else", () => {
    expect(isArchiveDomainStatus(PENDING)).toBe(true);
    expect(isArchiveDomainStatus([PENDING])).toBe(false);
    expect(isArchiveDomainStatus({ ...PENDING, status: "provisioning" })).toBe(
      false,
    );
    expect(isArchiveDomainStatus(undefined)).toBe(false);
  });
});

describe("normalizeArchiveDomainSettings", () => {
  it("reads archive_domain back off a PUT answer", () => {
    expect(
      normalizeArchiveDomainSettings({ archive_domain: "News.Example.com" }),
    ).toEqual({ archiveDomain: "news.example.com" });
    expect(normalizeArchiveDomainSettings({ archive_domain: "" })).toEqual({
      archiveDomain: "",
    });
  });

  it("is null when the answer never mentioned the column", () => {
    expect(normalizeArchiveDomainSettings({ archive_title: "x" })).toBeNull();
    expect(normalizeArchiveDomainSettings(null)).toBeNull();
  });
});

describe("validateArchiveDomain", () => {
  it("accepts a sub-domain and canonicalises it", () => {
    expect(validateArchiveDomain(" News.Example.com ")).toEqual({
      ok: true,
      value: "news.example.com",
    });
    expect(validateArchiveDomain("a-b.c-d.example.co.uk").ok).toBe(true);
  });

  it("accepts empty — that is how the column is cleared", () => {
    expect(validateArchiveDomain("")).toEqual({ ok: true, value: "" });
    expect(validateArchiveDomain("   ")).toEqual({ ok: true, value: "" });
  });

  it("refuses schemes, paths, ports and single labels, in the server's words", () => {
    for (const bad of [
      "https://news.example.com",
      "news.example.com/archive",
      "news.example.com:443",
      "example",
      "news_example.com",
      "-news.example.com",
      "news.example.c",
    ]) {
      expect(validateArchiveDomain(bad)).toEqual({
        ok: false,
        message: ARCHIVE_DOMAIN_INVALID,
      });
    }
  });

  it("refuses a host longer than the 253-character bound", () => {
    const long = `${"a".repeat(250)}.com`;
    expect(long.length).toBeGreaterThan(253);
    expect(validateArchiveDomain(long)).toEqual({
      ok: false,
      message: ARCHIVE_DOMAIN_INVALID,
    });
  });

  it("refuses the Moosewave edge suffixes a tenant must not shadow", () => {
    for (const reserved of [
      "archive.moosewave.com",
      "x.postwave.dev",
      "y.postwave.io",
    ]) {
      expect(validateArchiveDomain(reserved)).toEqual({
        ok: false,
        message: ARCHIVE_DOMAIN_RESERVED,
      });
    }
    // Not a suffix match — a tenant CAN own this one.
    expect(validateArchiveDomain("postwave.example.com").ok).toBe(true);
  });
});

describe("archiveDomainDirty", () => {
  it("compares case- and space-insensitively, as the column does", () => {
    expect(archiveDomainDirty(PENDING, "news.example.com")).toBe(false);
    expect(archiveDomainDirty(PENDING, " NEWS.example.com ")).toBe(false);
    expect(archiveDomainDirty(PENDING, "other.example.com")).toBe(true);
    expect(archiveDomainDirty(PENDING, "")).toBe(true);
  });
});

describe("the DNS records to publish", () => {
  it("names the CNAME host and target", () => {
    expect(archiveDnsRecord(PENDING)).toEqual({
      host: "news.example.com",
      target: "custom-domains.moosewave.com",
    });
  });

  it("offers the TXT alternative only when the server issued a token", () => {
    expect(archiveTxtRecord(PENDING)).toEqual({
      host: "_postwave-verify.news.example.com",
      value: "postwave-verify=abc123",
    });
    expect(archiveTxtRecord({ ...PENDING, verificationToken: "" })).toBeNull();
  });

  it("has no record to publish before a domain is configured", () => {
    const empty = { ...PENDING, domain: "", verificationToken: "" };
    expect(archiveDnsRecord(empty)).toBeNull();
    expect(archiveTxtRecord(empty)).toBeNull();
  });
});

describe("archiveCnameSentence", () => {
  it("prefers the server's own failure reason", () => {
    expect(
      archiveCnameSentence({
        ...PENDING,
        status: "failed",
        lastError: "CNAME points at cdn.other.net",
      }),
    ).toBe("CNAME points at cdn.other.net");
  });

  it("still says something when a failure carried no reason", () => {
    expect(archiveCnameSentence({ ...PENDING, status: "failed" })).toBe(
      "The last check could not resolve this host to Moosewave.",
    );
  });

  it("describes waiting and success", () => {
    expect(archiveCnameSentence(PENDING)).toBe(
      "Waiting for DNS propagation — tap Verify once the CNAME below exists.",
    );
    expect(archiveCnameSentence({ ...PENDING, status: "verified" })).toBe(
      "The CNAME resolves to Moosewave. This host serves your archive.",
    );
  });
});

describe("archiveSslSentence", () => {
  it("uses desktop's wording for each certificate state", () => {
    expect(archiveSslSentence({ ...PENDING, sslStatus: "issued" })).toBe(
      "Let's Encrypt cert is live — HTTPS works.",
    );
    expect(archiveSslSentence({ ...PENDING, sslStatus: "issuing" })).toBe(
      "Provisioning certificate via Let's Encrypt — usually < 90 seconds after verification.",
    );
    expect(
      archiveSslSentence({
        ...PENDING,
        sslStatus: "failed",
        sslLastError: "acme: rate limited",
      }),
    ).toBe("acme: rate limited");
    expect(archiveSslSentence({ ...PENDING, sslStatus: "failed" })).toBe(
      "Cert issuance failed. Check that your DNS still points to the CNAME target.",
    );
  });

  it("distinguishes 'verified, cert pending' from 'not verified yet'", () => {
    expect(archiveSslSentence({ ...PENDING, status: "verified" })).toBe(
      "Cert will be issued automatically once the edge picks up this domain.",
    );
    expect(archiveSslSentence(PENDING)).toBe(
      "SSL provisioning starts after CNAME verification succeeds.",
    );
  });
});

describe("archiveDomainShouldPoll", () => {
  it("polls only while the edge is issuing", () => {
    expect(archiveDomainShouldPoll({ ...PENDING, sslStatus: "issuing" })).toBe(
      true,
    );
    for (const done of ["pending", "issued", "failed"] as const) {
      expect(archiveDomainShouldPoll({ ...PENDING, sslStatus: done })).toBe(
        false,
      );
    }
    expect(archiveDomainShouldPoll(null)).toBe(false);
  });
});

describe("archivePublicUrl", () => {
  it("is the vanity host only once the server says verified", () => {
    expect(archivePublicUrl({ ...PENDING, status: "verified" })).toBe(
      "https://news.example.com",
    );
    expect(archivePublicUrl(PENDING)).toBeNull();
    expect(
      archivePublicUrl({ ...PENDING, status: "verified", domain: "" }),
    ).toBeNull();
  });
});

describe("archiveVerifyOutcome", () => {
  it("celebrates a verified row and quotes the reason otherwise", () => {
    expect(archiveVerifyOutcome({ ...PENDING, status: "verified" })).toEqual({
      kind: "success",
      message: "Domain verified! SSL is being provisioned.",
    });
    expect(
      archiveVerifyOutcome({
        ...PENDING,
        status: "failed",
        lastError: "no CNAME record found",
      }),
    ).toEqual({ kind: "error", message: "no CNAME record found" });
    expect(archiveVerifyOutcome(PENDING)).toEqual({
      kind: "error",
      message: "Verification failed. Check the CNAME record and try again.",
    });
  });
});

describe("archiveDomainWriteError", () => {
  it("shows the handler's 400/409 sentences verbatim", () => {
    expect(
      archiveDomainWriteError({
        status: 400,
        code: "no_domain",
        message: "no custom archive domain configured; set archive_domain first",
      }),
    ).toBe("no custom archive domain configured; set archive_domain first");
    expect(
      archiveDomainWriteError({
        status: 409,
        code: "domain_taken",
        message: "that domain is already claimed by another publication",
      }),
    ).toBe("that domain is already claimed by another publication");
  });

  it("answers a 403 with who can act", () => {
    expect(
      archiveDomainWriteError({ status: 403, message: "forbidden" }),
    ).toBe("Only workspace admins can change the archive domain.");
  });

  it("never renders an empty sentence", () => {
    expect(archiveDomainWriteError({ status: 500, message: "  " })).toBe(
      "Couldn't reach the archive-domain settings.",
    );
  });
});
