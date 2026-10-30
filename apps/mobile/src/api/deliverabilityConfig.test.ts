/**
 * Transport-seam tests for the configuration-side modules: providers,
 * verification policy, bot-open signatures, the control-panel reads, warm-up
 * bookends, DMARC source detail and the reputation trend. Same rule as the
 * ops file: drive each function with exactly the {data, error} envelope
 * `rawRequest` resolves to, and assert on bodies going up as well as rows
 * coming down.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  createProviderConnection,
  deleteProviderConnection,
  fetchProviderConnections,
  setProviderConnection,
  type ProviderConnection,
} from "./deliverabilityProviders";
import {
  fetchVerificationCredits,
  fetchVerificationPolicy,
  setVerificationMode,
} from "./verificationPolicy";
import { fetchBotOpenSignatures, fetchBotOpenStats } from "./botOpens";
import {
  fetchClickTrackingPolicy,
  fetchControlDomainSetups,
  fetchRoutingPolicy,
  fetchSendingEntitlement,
} from "./deliverabilityControl";
import { createWarmupPlan, deleteWarmupPlan } from "./domainWarmupOps";
import { fetchDmarcSourceDetail } from "./dmarcSources";
import { fetchReputationHistory } from "./customDomainReputation";

const { rawRequest } = vi.hoisted(() => ({ rawRequest: vi.fn() }));
vi.mock("@/api/request", () => ({ rawRequest }));

beforeEach(() => {
  rawRequest.mockReset();
});

describe("provider connections", () => {
  it("reads the {items} envelope and derives presence-only config", async () => {
    rawRequest.mockResolvedValue({
      data: {
        items: [
          {
            id: "p1",
            provider: "postmark",
            display_name: "Postmark prod",
            active: true,
            updated_at: "t",
            config: { webhook_token_hash: "xx" },
          },
          { provider: "no-id-dropped" },
        ],
      },
      error: null,
    });
    const rows = await fetchProviderConnections();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.config).toEqual({ webhook_token_hash: "xx" });
  });

  it("creates with a snake_case body and unwraps the {item} receipt", async () => {
    rawRequest.mockResolvedValue({
      data: {
        item: { id: "p2", provider: "ses", display_name: "SES", active: true },
      },
      error: null,
    });
    const saved = await createProviderConnection({
      provider: "ses",
      displayName: "SES",
      webhookToken: "a".repeat(40),
      credentialRef: "vault/ses",
    });
    expect(saved.id).toBe("p2");
    expect(rawRequest).toHaveBeenCalledWith(
      "POST",
      "/api/v1/deliverability/providers",
      {
        provider: "ses",
        display_name: "SES",
        config: { webhook_token: "a".repeat(40), credential_ref: "vault/ses" },
      },
    );
  });

  it("PATCH echoes the FULL redacted config so stored secrets survive", async () => {
    const connection: ProviderConnection = {
      id: "p1",
      provider: "postmark",
      displayName: "Postmark",
      active: true,
      updatedAt: "t",
      config: { webhook_token: "redacted" },
    };
    rawRequest.mockResolvedValue({
      data: { item: { id: "p1", provider: "postmark", active: false } },
      error: null,
    });
    await setProviderConnection(connection, { active: false });
    expect(rawRequest).toHaveBeenCalledWith(
      "PATCH",
      "/api/v1/deliverability/providers/p1",
      {
        provider: "postmark",
        display_name: "Postmark",
        config: { webhook_token: "redacted" },
        active: false,
      },
    );
  });

  it("DELETE requires the server's {ok: true} confirmation", async () => {
    rawRequest.mockResolvedValue({ data: { ok: true }, error: null });
    await expect(deleteProviderConnection("p1")).resolves.toBeUndefined();
    rawRequest.mockResolvedValue({ data: {}, error: null });
    await expect(deleteProviderConnection("p1")).rejects.toThrow(
      /did not confirm/,
    );
  });
});

describe("verification policy", () => {
  const WIRE_POLICY = {
    policy: {
      forms_mode: "local",
      forms_reject_statuses: ["undeliverable", "risky"],
      import_mode: "off",
      updated_at: "t",
    },
    modes: ["off", "local", "full"],
    rejectable_statuses: ["undeliverable", "risky", "unknown"],
  };

  it("parses the envelope and keeps the tri-state typo flag honest", async () => {
    rawRequest.mockResolvedValue({ data: WIRE_POLICY, error: null });
    const envelope = await fetchVerificationPolicy();
    expect(envelope.policy.formsMode).toBe("local");
    // Omitted on the wire → null, never a fabricated boolean.
    expect(envelope.policy.formsSuggestTypos).toBeNull();
  });

  it("PUT is a FULL REPLACE — one changed mode still echoes the lists", async () => {
    rawRequest.mockResolvedValue({
      data: {
        policy: { ...WIRE_POLICY.policy, import_mode: "full" },
        warning: "w",
      },
      error: null,
    });
    const result = await setVerificationMode(
      {
        formsMode: "local",
        formsRejectStatuses: ["undeliverable", "risky"],
        formsSuggestTypos: null,
        importMode: "off",
        updatedAt: "t",
      },
      "import",
      "full",
    );
    expect(rawRequest).toHaveBeenCalledWith(
      "PUT",
      "/api/v1/verification/policy",
      {
        forms_mode: "local",
        forms_reject_statuses: ["undeliverable", "risky"],
        import_mode: "full",
      },
    );
    expect(result.warning).toBe("w");
  });

  it("keeps a null credit balance null instead of rendering zero", async () => {
    rawRequest.mockResolvedValue({
      data: {
        totals: {
          verified: 10,
          credits_spent: 4,
          local_filtered: 3,
          cache_hits: 2,
          credits_saved: 6,
        },
        provider: "kickbox",
        balance: null,
      },
      error: null,
    });
    const credits = await fetchVerificationCredits();
    expect(credits.balance).toBeNull();
    expect(credits.totals.creditsSaved).toBe(6);
  });

  it.each([
    ["missing totals", { provider: null, balance: null }],
    [
      "partial totals",
      {
        totals: { verified: 10, credits_spent: 4 },
        provider: "kickbox",
        balance: 12,
      },
    ],
    [
      "malformed totals",
      {
        totals: {
          verified: "10",
          credits_spent: 4,
          local_filtered: 3,
          cache_hits: 2,
          credits_saved: 6,
        },
        provider: "kickbox",
        balance: 12,
      },
    ],
  ])("does not turn %s into known zero credits", async (_label, data) => {
    rawRequest.mockResolvedValue({ data, error: null });
    await expect(fetchVerificationCredits()).rejects.toMatchObject({
      code: "wire_shape",
    });
  });
});

describe("bot opens", () => {
  it("reads stats with per-signature buckets", async () => {
    rawRequest.mockResolvedValue({
      data: {
        total_opens: 100,
        bot_opens: 40,
        human_opens: 60,
        since: "t",
        by_signature: [{ label: "Apple MPP", opens: 30 }, { opens: 5 }],
      },
      error: null,
    });
    const stats = await fetchBotOpenStats();
    expect(stats.botOpens).toBe(40);
    expect(stats.bySignature).toEqual([{ label: "Apple MPP", opens: 30 }]);
  });

  it("marks platform-shipped signatures undeletable via isDefault", async () => {
    rawRequest.mockResolvedValue({
      data: [
        {
          id: "s1",
          label: "Mine",
          pattern: "x",
          enabled: true,
          tenant_id: "t1",
        },
        {
          id: "s2",
          label: "Default",
          pattern: "y",
          enabled: true,
          tenant_id: "",
        },
      ],
      error: null,
    });
    const signatures = await fetchBotOpenSignatures();
    expect(signatures[0]?.isDefault).toBe(false);
    expect(signatures[1]?.isDefault).toBe(true);
  });
});

describe("deliverability-control reads", () => {
  it("reads domain setups from the {items} envelope", async () => {
    rawRequest.mockResolvedValue({
      data: {
        items: [
          {
            domain: "mail.a.com",
            setup_mode: "static_dns",
            status: "active",
            ssl_status: "active",
            routing_status: "ok",
          },
        ],
      },
      error: null,
    });
    const setups = await fetchControlDomainSetups();
    expect(setups[0]).toMatchObject({ domain: "mail.a.com", status: "active" });
  });

  it("summarises the click-tracking policy's last untracked report", async () => {
    rawRequest.mockResolvedValue({
      data: {
        tracking_domain: "click.a.com",
        status: "active",
        ssl_status: "active",
        disable_syntax: ["#notrack"],
        last_untracked_report: { untracked_links: 3, created_at: "t" },
      },
      error: null,
    });
    const policy = await fetchClickTrackingPolicy();
    expect(policy.lastUntrackedCount).toBe(3);
    expect(policy.disableSyntax).toEqual(["#notrack"]);
  });

  it("recomputes a 0% dedicated share that omitempty dropped", async () => {
    rawRequest.mockResolvedValue({
      data: {
        status: "active",
        strategy: "blend",
        dedicated_pool: "",
        shared_pool: "shared-1",
        dedicated_percentage_bp: 0,
        max_dedicated_percentage_bp: 5000,
      },
      error: null,
    });
    const policy = await fetchRoutingPolicy();
    expect(policy.effectiveDedicatedPercent).toBe(0);
    expect(policy.effectiveSharedPercent).toBe(100);
  });

  it("reads the entitlement meter", async () => {
    rawRequest.mockResolvedValue({
      data: {
        plan_tier: "growth",
        period_start: "2026-08-01",
        inbox_tests_monthly: 30,
        inbox_tests_used: 12,
        inbox_tests_remaining: 18,
        render_previews_monthly: 100,
        render_previews_used: 5,
        render_previews_remaining: 95,
        overage_policy: "block",
      },
      error: null,
    });
    const entitlement = await fetchSendingEntitlement();
    expect(entitlement.inboxTestsRemaining).toBe(18);
    expect(entitlement.overagePolicy).toBe("block");
  });
});

describe("warm-up bookends", () => {
  it("POSTs the create body and echoes the created plan", async () => {
    rawRequest.mockResolvedValue({
      data: { id: "w1", domain: "mail.a.com", target_daily: 5000, days: 30 },
      error: null,
    });
    const plan = await createWarmupPlan({
      domain: "mail.a.com",
      targetDaily: 5000,
      days: 30,
    });
    expect(rawRequest).toHaveBeenCalledWith("POST", "/api/v1/domain-warmup", {
      domain: "mail.a.com",
      target_daily: 5000,
      days: 30,
    });
    expect(plan.targetDaily).toBe(5000);
  });

  it("DELETEs the domain's route and surfaces a failure", async () => {
    rawRequest.mockResolvedValue({ data: { ok: true }, error: null });
    await deleteWarmupPlan("mail.a.com");
    expect(rawRequest).toHaveBeenCalledWith(
      "DELETE",
      "/api/v1/domain-warmup/mail.a.com",
    );
    rawRequest.mockResolvedValue({
      data: null,
      error: { status: 404, message: "no plan" },
    });
    await expect(deleteWarmupPlan("mail.a.com")).rejects.toThrow("no plan");
  });
});

describe("fetchDmarcSourceDetail", () => {
  it("builds the query string and reads the service's camelCase keys", async () => {
    rawRequest.mockResolvedValue({
      data: {
        sourceIp: "203.0.113.9",
        periodDays: 30,
        domain: "a.com",
        hasMore: true,
        summary: {
          messages: 120,
          dkimPass: 110,
          spfPass: 10,
          alignedPct: 12.5,
          primaryDisposition: "quarantine",
        },
        perReport: [
          {
            reportId: "r1",
            orgName: "google.com",
            dateBegin: "t0",
            dateEnd: "t1",
            messages: 60,
            alignedPct: 10,
            primaryDisposition: "quarantine",
          },
        ],
      },
      error: null,
    });
    const detail = await fetchDmarcSourceDetail({
      ip: "203.0.113.9",
      days: 30,
      domain: "a.com",
    });
    expect(rawRequest).toHaveBeenCalledWith(
      "GET",
      "/api/v1/deliverability/dmarc-sources?ip=203.0.113.9&days=30&domain=a.com",
    );
    expect(detail.summary.dkimPass).toBe(110);
    expect(detail.perReport[0]?.orgName).toBe("google.com");
    expect(detail.hasMore).toBe(true);
  });
});

describe("fetchReputationHistory", () => {
  it("keeps the server's PERCENTAGE rates as percentages", async () => {
    rawRequest.mockResolvedValue({
      data: {
        days: [
          {
            day: "2026-08-28",
            score: 82,
            sends: 1000,
            bounce_rate: 1.4,
            complaint_rate: 0.02,
          },
          { score: 10 }, // no day key → dropped
        ],
      },
      error: null,
    });
    const points = await fetchReputationHistory("a.com");
    expect(points).toHaveLength(1);
    expect(points[0]?.bounceRatePct).toBe(1.4);
    expect(rawRequest).toHaveBeenCalledWith(
      "GET",
      "/api/v1/sender-reputation/a.com/history",
    );
  });
});
