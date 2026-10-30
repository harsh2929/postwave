import { describe, expect, it, vi } from "vitest";

vi.mock("./request", () => ({ rawRequest: vi.fn() }));

const {
  formatSessionTtl,
  isPolicyHidden,
  normalizeSecurityPolicy,
  SecurityPolicyError,
  ssoProviderHint,
  ssoProviderLabel,
  twoFactorPolicyLabel,
} = await import("./securitySettings");

describe("normalizeSecurityPolicy", () => {
  it("reads the wire shape the Go handler actually writes", () => {
    expect(
      normalizeSecurityPolicy({
        require_2fa_for_admins: true,
        require_2fa_for_all: false,
        sso_provider: "okta",
        sso_metadata_url: "https://idp.example/metadata",
        session_max_minutes: 480,
      }),
    ).toEqual({
      require2faForAdmins: true,
      require2faForAll: false,
      ssoProvider: "okta",
      sessionMaxMinutes: 480,
    });
  });

  it("treats an unvisited tenant's zero value as 'nothing enforced'", () => {
    // security.go answers pgx.ErrNoRows with SecuritySettings{}, so the omitempty
    // pointers vanish entirely rather than arriving as nulls.
    expect(normalizeSecurityPolicy({})).toEqual({
      require2faForAdmins: false,
      require2faForAll: false,
      ssoProvider: null,
      sessionMaxMinutes: null,
    });
  });

  it("never invents a policy out of a malformed payload", () => {
    // A truthy string must not read as "two-factor is required" — that would
    // tell a user their account is protected when it is not.
    const policy = normalizeSecurityPolicy({
      require_2fa_for_all: "true",
      sso_provider: "   ",
      session_max_minutes: -30,
    });
    expect(policy.require2faForAll).toBe(false);
    expect(policy.ssoProvider).toBeNull();
    expect(policy.sessionMaxMinutes).toBeNull();
  });

  it("survives a non-object body", () => {
    expect(normalizeSecurityPolicy(null).require2faForAdmins).toBe(false);
    expect(normalizeSecurityPolicy("nope").sessionMaxMinutes).toBeNull();
  });
});

describe("twoFactorPolicyLabel", () => {
  const base = {
    require2faForAdmins: false,
    require2faForAll: false,
    ssoProvider: null,
    sessionMaxMinutes: null,
  };

  it("lets the all-users rule win over the admin rule", () => {
    // mfa_gate.go checks require_2fa_for_all first; reporting "admins and
    // owners" for a workspace that requires it of everyone would tell a member
    // they are exempt when the server will refuse their session.
    expect(
      twoFactorPolicyLabel({
        ...base,
        require2faForAdmins: true,
        require2faForAll: true,
      }),
    ).toBe("Required for everyone");
  });

  it("names the admin-only policy", () => {
    expect(
      twoFactorPolicyLabel({ ...base, require2faForAdmins: true }),
    ).toBe("Required for admins and owners");
  });

  it("says plainly when nothing is enforced", () => {
    expect(twoFactorPolicyLabel(base)).toBe(
      "Optional — not enforced by this workspace",
    );
  });
});

describe("formatSessionTtl", () => {
  it("falls back to the server default rather than inventing a number", () => {
    expect(formatSessionTtl(null)).toBe("Server default");
    expect(formatSessionTtl(0)).toBe("Server default");
    expect(formatSessionTtl(Number.NaN)).toBe("Server default");
  });

  it("renders whole units without a trailing zero part", () => {
    expect(formatSessionTtl(480)).toBe("8 hours");
    expect(formatSessionTtl(1440)).toBe("1 day");
    expect(formatSessionTtl(60)).toBe("1 hour");
  });

  it("keeps the remainder visible", () => {
    expect(formatSessionTtl(45)).toBe("45 minutes");
    expect(formatSessionTtl(1)).toBe("1 minute");
    expect(formatSessionTtl(1530)).toBe("1 day 1 hour 30 minutes");
  });
});

describe("ssoProviderLabel", () => {
  const withProvider = (ssoProvider: string | null) => ({
    require2faForAdmins: false,
    require2faForAll: false,
    ssoProvider,
    sessionMaxMinutes: null,
  });

  it("states the absence instead of rendering an em dash", () => {
    expect(ssoProviderLabel(withProvider(null))).toBe("Not configured");
  });

  // A bare "okta" told an admin their workspace was federated. Nothing in the
  // API consumes sso_provider — no ACS route, no SAML handler, SAMLJITProvision
  // has zero callers — so the stored value must never render as an active
  // sign-in method.
  it("never renders a stored provider as though it were active", () => {
    const label = ssoProviderLabel(withProvider("okta"));
    expect(label).toContain("okta");
    expect(label).toContain("not enforced");
    expect(label).not.toBe("okta");
  });

  it("qualifies every provider, not just the ones we thought of", () => {
    for (const provider of ["okta", "azure-ad", "onelogin", "saml-custom"]) {
      expect(ssoProviderLabel(withProvider(provider))).toBe(
        `${provider} — not enforced`,
      );
    }
  });
});

describe("ssoProviderHint", () => {
  const withProvider = (ssoProvider: string | null) => ({
    require2faForAdmins: false,
    require2faForAll: false,
    ssoProvider,
    sessionMaxMinutes: null,
  });

  it("says nothing when there is no stored provider", () => {
    expect(ssoProviderHint(withProvider(null))).toBeNull();
  });

  // The regression this locks down: the card used to assert "Sign-in is
  // delegated to this identity provider." The hint must state the opposite,
  // because the opposite is what is true.
  it("contradicts the old claim that sign-in is delegated", () => {
    const hint = ssoProviderHint(withProvider("okta"));
    expect(hint).not.toBeNull();
    expect(hint).toContain("not delegated");
    expect(hint).toContain("Moosewave credentials");
    expect(hint).not.toContain("Sign-in is delegated to this identity provider");
  });
});

describe("isPolicyHidden", () => {
  it("hides the card for the statuses that mean 'not yours to see'", () => {
    expect(isPolicyHidden(new SecurityPolicyError(403, ""))).toBe(true);
    expect(isPolicyHidden(new SecurityPolicyError(404, ""))).toBe(true);
  });

  it("keeps genuine failures visible", () => {
    // A 500 or a dropped connection is a real error and must not masquerade as
    // "you are not an admin" by silently removing the card.
    expect(isPolicyHidden(new SecurityPolicyError(500, ""))).toBe(false);
    expect(isPolicyHidden(new SecurityPolicyError(0, "offline"))).toBe(false);
    expect(isPolicyHidden(new Error("boom"))).toBe(false);
  });
});
