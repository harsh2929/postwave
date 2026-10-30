import { describe, expect, it } from "vitest";

import {
  parseVerificationCredits,
  parseVerificationPolicy,
  parseVerificationProviders,
} from "../../components/deliverability/verification-response-contract";

const PRIVATE_DETAIL = "Bearer private-upstream-token at internal.example.test";

const PROVIDER = {
  id: "71000000-0000-4000-8000-000000000001",
  provider: "zerobounce",
  credential_ref: "zerobounce-primary",
  enabled: true,
  settings: {
    cache_ttl_days: 45,
    degrade_on_failure: true,
  },
  last_balance: 250,
  last_balance_at: "2026-08-02T09:00:00.000Z",
  last_error: PRIVATE_DETAIL,
  last_error_at: "2026-08-02T09:00:01.000Z",
  created_at: "2026-08-01T09:00:00.000Z",
  updated_at: "2026-08-02T09:00:00.000Z",
};

const POLICY = {
  forms_mode: "local",
  forms_reject_statuses: ["invalid", "spamtrap"],
  forms_suggest_typos: true,
  import_mode: "off",
  updated_at: "2026-08-02T10:00:00.000Z",
};

const POLICY_METADATA = {
  modes: ["off", "local", "full"],
  rejectable_statuses: [
    "invalid",
    "catch_all",
    "spamtrap",
    "abuse",
    "do_not_mail",
    "unknown",
  ],
};

const CREDITS = {
  usage: [
    {
      day: "2026-08-02",
      provider: "zerobounce",
      verified: 10,
      credits_spent: 2,
      local_filtered: 5,
      cache_hits: 3,
    },
    {
      day: "2026-08-01",
      provider: "local",
      verified: 4,
      credits_spent: 0,
      local_filtered: 2,
      cache_hits: 0,
    },
  ],
  totals: {
    verified: 14,
    credits_spent: 2,
    local_filtered: 7,
    cache_hits: 3,
    credits_saved: 12,
  },
  provider: "zerobounce",
  balance: 250,
  balance_checked_at: "2026-08-02T09:00:00.000Z",
  last_error: PRIVATE_DETAIL,
};

describe("verification settings response contracts", () => {
  it("projects provider health without retaining raw errors or infrastructure fields", () => {
    const parsed = parseVerificationProviders({
      providers: [PROVIDER],
      available: ["zerobounce", "kickbox"],
    });

    expect(parsed).toEqual({
      providers: [
        {
          provider: "zerobounce",
          credential_ref: "zerobounce-primary",
          enabled: true,
          settings: {
            cache_ttl_days: 45,
            degrade_on_failure: true,
          },
          last_balance: 250,
          last_balance_at: "2026-08-02T09:00:00.000Z",
          has_error: true,
        },
      ],
      available: ["zerobounce", "kickbox"],
    });
    expect(JSON.stringify(parsed)).not.toContain(PRIVATE_DETAIL);
  });

  it.each([
    ["missing settings", { ...PROVIDER, settings: undefined }],
    ["unknown setting", { ...PROVIDER, settings: { private_key: "x" } }],
    [
      "removed endpoint override",
      { ...PROVIDER, settings: { base_url: "https://attacker.example" } },
    ],
    ["oversized TTL", { ...PROVIDER, settings: { cache_ttl_days: 181 } }],
    [
      "control in reference",
      { ...PROVIDER, credential_ref: "opaque\u0000bad" },
    ],
    ["bidi control", { ...PROVIDER, credential_ref: "opaque\u202ebad" }],
    [
      "global vault path",
      { ...PROVIDER, credential_ref: "vault://verification/zerobounce" },
    ],
    ["control in error", { ...PROVIDER, last_error: "failed\nsecret" }],
    ["invalid timestamp", { ...PROVIDER, updated_at: "yesterday" }],
    [
      "normalized calendar timestamp",
      { ...PROVIDER, updated_at: "2026-02-30T09:00:00Z" },
    ],
    [
      "invalid timezone offset",
      { ...PROVIDER, updated_at: "2026-02-02T09:00:00+25:00" },
    ],
    ["unsafe balance", { ...PROVIDER, last_balance: Number.MAX_VALUE }],
  ])("rejects a provider with %s", (_label, candidate) => {
    expect(
      parseVerificationProviders({
        providers: [candidate],
        available: ["zerobounce", "kickbox"],
      }),
    ).toBeNull();
  });

  it("rejects ambiguous provider inventories", () => {
    expect(
      parseVerificationProviders({
        providers: [PROVIDER, { ...PROVIDER, provider: "kickbox" }],
        available: ["zerobounce", "kickbox"],
      }),
    ).toBeNull();
    expect(
      parseVerificationProviders({
        providers: [PROVIDER],
        available: ["zerobounce"],
      }),
    ).toBeNull();
    expect(
      parseVerificationProviders({
        providers: [PROVIDER, { ...PROVIDER, enabled: false }],
        available: ["zerobounce", "kickbox"],
      }),
    ).toBeNull();
  });

  it("accepts both complete GET policy metadata and the bounded PUT receipt", () => {
    expect(
      parseVerificationPolicy({
        policy: POLICY,
        ...POLICY_METADATA,
        warning: "Full mode currently has no paid provider.",
      }),
    ).toEqual(POLICY);
    expect(parseVerificationPolicy({ policy: POLICY })).toEqual(POLICY);
  });

  it.each([
    ["empty refusal set", { ...POLICY, forms_reject_statuses: [] }],
    [
      "duplicate refusal",
      { ...POLICY, forms_reject_statuses: ["invalid", "invalid"] },
    ],
    ["valid as refused", { ...POLICY, forms_reject_statuses: ["valid"] }],
    ["unknown mode", { ...POLICY, forms_mode: "vendor" }],
    ["invalid update time", { ...POLICY, updated_at: "2026-02-30" }],
  ])("rejects a policy with %s", (_label, candidate) => {
    expect(parseVerificationPolicy({ policy: candidate })).toBeNull();
  });

  it("requires exact closed metadata and control-free warning text", () => {
    expect(
      parseVerificationPolicy({
        policy: POLICY,
        ...POLICY_METADATA,
        modes: ["off", "local"],
      }),
    ).toBeNull();
    expect(
      parseVerificationPolicy({
        policy: POLICY,
        ...POLICY_METADATA,
        warning: "safe\u0000unsafe",
      }),
    ).toBeNull();
  });

  it("accepts internally consistent measured usage and reduces raw balance errors to a flag", () => {
    const parsed = parseVerificationCredits(CREDITS);
    expect(parsed).toMatchObject({
      totals: CREDITS.totals,
      provider: "zerobounce",
      balance: 250,
      has_error: true,
    });
    expect(JSON.stringify(parsed)).not.toContain(PRIVATE_DETAIL);
  });

  it.each([
    ["invalid day", { ...CREDITS.usage[0], day: "2026-02-30" }],
    ["unknown source", { ...CREDITS.usage[0], provider: "smtp-probe" }],
    ["fractional count", { ...CREDITS.usage[0], verified: 1.5 }],
    ["overspent row", { ...CREDITS.usage[0], credits_spent: 11 }],
    ["control in source", { ...CREDITS.usage[0], provider: "local\u0000" }],
  ])("rejects a usage row with %s", (_label, row) => {
    expect(
      parseVerificationCredits({
        ...CREDITS,
        usage: [row, CREDITS.usage[1]],
      }),
    ).toBeNull();
  });

  it("rejects duplicated rows, forged totals, invalid provider coupling, and unsafe error text", () => {
    expect(
      parseVerificationCredits({
        ...CREDITS,
        usage: [CREDITS.usage[0], CREDITS.usage[0]],
      }),
    ).toBeNull();
    expect(
      parseVerificationCredits({
        ...CREDITS,
        totals: { ...CREDITS.totals, verified: 15, credits_saved: 13 },
      }),
    ).toBeNull();
    expect(
      parseVerificationCredits({
        ...CREDITS,
        provider: null,
        balance: 250,
      }),
    ).toBeNull();
    expect(
      parseVerificationCredits({
        ...CREDITS,
        last_error: "failed\nprivate detail",
      }),
    ).toBeNull();
  });
});
