// SPDX-License-Identifier: MIT

import { afterEach, describe, expect, it, vi } from "vitest";
import { createClient } from "../src/lib/client.js";
import {
  broadcastInputFromOptions,
  campaignInputFromOptions,
  consentInputFromOptions,
  senderInputFromOptions,
  smsA2PBrandSubmit,
  smsA2PCampaignSubmit,
  smsA2PPoll,
  smsCampaignCancel,
  smsCampaignPause,
  smsCampaignReport,
  smsCampaignReportExport,
  smsCampaignResume,
  smsCampaignSchedule,
  smsCampaignSend,
  smsCampaignsCreate,
  smsCampaignsGet,
  smsCampaignsList,
  smsCompliance,
  smsConsentRecord,
  smsListsCreate,
  smsListsList,
  smsPilotReadiness,
  smsSenderPause,
  smsSenderPilotCertification,
  smsSenderResume,
  smsSenderUpsert,
  smsSendersList,
  smsSetup,
  smsSuppressionAdd,
  smsSuppressionRemove,
  smsSuppressionsList,
  smsTestSend,
  testSendInputFromOptions,
} from "../src/commands/sms.js";

vi.mock("../src/lib/client.js", () => ({
  createClient: vi.fn(),
}));

function makeSmsResource() {
  return {
    setup: vi.fn(async () => ({
      senders: [],
      can_send: true,
      blocking_reasons: [],
    })),
    compliance: vi.fn(async () => ({
      can_send: true,
      senders: [],
      items: [{ key: "consent", label: "Consent", complete: true }],
    })),
    pilotReadiness: vi.fn(async () => ({
      can_pilot: true,
      counts: { senders: 1 },
      items: [{ key: "sender", label: "Sender", status: "pass" }],
    })),
    senderPilotCertification: vi.fn(async () => ({
      sender: senderFixture(),
      can_pilot: true,
      generated_at: "2026-06-17T00:00:00Z",
      items: [],
    })),
    listSenders: vi.fn(async () => ({ items: [senderFixture()] })),
    upsertSender: vi.fn(async () => senderFixture()),
    pauseSender: vi.fn(async () => ({
      ...senderFixture(),
      registration_status: "suspended",
    })),
    resumeSender: vi.fn(async () => senderFixture()),
    submitBrandRegistration: vi.fn(async () => ({
      sender: senderFixture(),
      brand: { sid: "BN123" },
    })),
    submitCampaignRegistration: vi.fn(async () => ({
      sender: senderFixture(),
      campaign: { sid: "CA123" },
    })),
    pollA2PRegistration: vi.fn(async () => ({
      sender: senderFixture(),
      message: "pending",
    })),
    listLists: vi.fn(async () => ({ items: [listFixture()] })),
    createList: vi.fn(async () => listFixture()),
    recordConsent: vi.fn(async () => ({ ok: true })),
    listSuppressions: vi.fn(async () => ({
      tenantId: "00000000-0000-0000-0000-000000000001",
      items: [],
      total: 0,
      snapshotAt: "2026-08-28T10:00:00Z",
    })),
    addSuppression: vi.fn(async () => ({
      id: "33333333-3333-4333-8333-333333333333",
      phone_e164: "+12025550101",
      reason: "manual",
      source: "manual",
      created_at: "2026-08-28T09:00:00Z",
      reversible: true,
    })),
    removeSuppression: vi.fn(async () => ({ ok: true as const })),
    listCampaigns: vi.fn(async () => ({ items: [campaignFixture()] })),
    getCampaign: vi.fn(async () => campaignFixture()),
    createCampaign: vi.fn(async () => campaignFixture()),
    campaignReport: vi.fn(async () => ({
      campaign: campaignFixture(),
      recipients: 10,
      queued: 10,
      sending: 0,
      sent: 9,
      blocked: 1,
      failed: 0,
      cancelled: 0,
      delivered: 8,
      undelivered: 1,
      clicks: 3,
      unique_clickers: 2,
      segments: 10,
      cost_micros: 1000,
      status_counts: {},
    })),
    exportCampaignReport: vi.fn(
      async () => "phone,status\n+15551234567,delivered\n",
    ),
    sendCampaign: vi.fn(async () => ({
      campaign: campaignFixture(),
      recipients: 10,
      queued: 10,
      accepted: 10,
      blocked: 0,
      failed: 0,
      segments: 10,
      cost_micros: 1000,
      link_tracking: true,
    })),
    scheduleCampaign: vi.fn(async () => ({
      ...campaignFixture(),
      status: "scheduled",
    })),
    pauseCampaign: vi.fn(async () => ({
      ...campaignFixture(),
      status: "paused",
    })),
    resumeCampaign: vi.fn(async () => ({
      ...campaignFixture(),
      status: "sending",
    })),
    cancelCampaign: vi.fn(async () => ({
      ...campaignFixture(),
      status: "cancelled",
    })),
    sendTest: vi.fn(async () => ({
      gate: { allowed: true, segments: 1 },
      message: {
        id: "msg_1",
        phone_e164: "+15551234567",
        provider: "twilio",
        direction: "outbound",
        body: "Hi",
        segments: 1,
        status: "queued",
        cost_micros: 100,
        created_at: "2026-06-17T00:00:00Z",
      },
    })),
  };
}

function senderFixture() {
  return {
    id: "sender_1",
    provider: "twilio",
    country: "US",
    sender_type: "10dlc",
    phone_number: "+15551234567",
    registration_status: "approved",
    created_at: "2026-06-17T00:00:00Z",
    updated_at: "2026-06-17T00:00:00Z",
  };
}

function listFixture() {
  return {
    id: "sms_list_1",
    name: "SMS VIP",
    description: "VIP customers",
    keyword: "VIP",
    sender_profile_id: "sender_1",
    created_at: "2026-06-17T00:00:00Z",
    updated_at: "2026-06-17T00:00:00Z",
  };
}

function campaignFixture() {
  return {
    id: "sms_cmp_1",
    sender_profile_id: "sender_1",
    list_id: "sms_list_1",
    name: "Launch",
    body: "Hello",
    status: "draft",
    created_at: "2026-06-17T00:00:00Z",
    updated_at: "2026-06-17T00:00:00Z",
  };
}

function mockClient() {
  const sms = makeSmsResource();
  vi.mocked(createClient).mockReturnValue({ sms } as unknown as ReturnType<
    typeof createClient
  >);
  return sms;
}

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

describe("SMS CLI payload builders", () => {
  it("builds sender, consent, campaign, broadcast, and test-send payloads", () => {
    expect(
      senderInputFromOptions({
        provider: "twilio",
        country: "us",
        senderType: "10dlc",
        phoneNumber: "+15551234567",
        capabilities: '{"mms":true}',
        metadata: '{"owner":"growth"}',
      }),
    ).toEqual({
      provider: "twilio",
      country: "US",
      sender_type: "10dlc",
      phone_number: "+15551234567",
      capabilities: { mms: true },
      metadata: { owner: "growth" },
    });

    expect(
      consentInputFromOptions({
        phone: "+14155550123",
        action: "revoked",
        source: "manual",
        listId: "11111111-1111-4111-8111-111111111111",
        proofText: "  Operator revocation request  ",
      }),
    ).toEqual({
      phone_e164: "+14155550123",
      action: "revoked",
      source: "manual",
      list_id: "11111111-1111-4111-8111-111111111111",
      proof_text: "Operator revocation request",
    });

    expect(() =>
      campaignInputFromOptions({
        senderProfileId: "sender_1",
        listId: "sms_list_1",
        name: "Launch",
        body: "Hi",
        status: "scheduled",
        scheduledAt: "2026-07-01T10:00:00Z",
      }),
    ).toThrow(/sms_campaign_schedule_release_held/u);
    expect(
      campaignInputFromOptions({
        senderProfileId: "sender_1",
        listId: "sms_list_1",
        name: "Launch",
        body: "Hi",
        status: "draft",
      }),
    ).toEqual({
      sender_profile_id: "sender_1",
      list_id: "sms_list_1",
      name: "Launch",
      body: "Hi",
      status: "draft",
    });

    expect(
      broadcastInputFromOptions({ limit: "25", linkTracking: "false" }),
    ).toEqual({
      limit: 25,
      link_tracking: false,
    });

    expect(
      testSendInputFromOptions({
        senderProfileId: "sender_1",
        listId: "sms_list_1",
        phone: "+15551234567",
        body: "Hi",
      }),
    ).toEqual({
      sender_profile_id: "sender_1",
      list_id: "sms_list_1",
      to: "+15551234567",
      body: "Hi",
    });
  });

  it("rejects unsafe SMS option values before SDK calls", () => {
    expect(() => senderInputFromOptions({ provider: "carrier" })).toThrow(
      /--provider/,
    );
    for (const held of [
      { brandRegistrationSid: "BN_PRIVATE" },
      { campaignRegistrationSid: "QE_PRIVATE" },
      { registrationStatus: "approved" },
      { payload: '{"brand_registration_sid":"BN_PRIVATE"}' },
    ]) {
      expect(() => senderInputFromOptions(held)).toThrow(
        /sms_registration_evidence_authority_required/u,
      );
    }
    expect(() =>
      consentInputFromOptions({ phone: "+1", action: "ok", source: "form" }),
    ).toThrow(/--action/);
    expect(() =>
      consentInputFromOptions({
        phone: "+14155550123",
        action: "revoked",
        source: "manual",
        proofText: "Private proof",
        email: "private@example.test",
      }),
    ).toThrow(/operator revocation fields/u);
    expect(() => campaignInputFromOptions({ name: "Launch" })).toThrow(
      /--body/,
    );
    expect(() => broadcastInputFromOptions({ limit: "0" })).toThrow(/--limit/);
    expect(() =>
      testSendInputFromOptions({
        senderProfileId: "sender_1",
        listId: "list_1",
        body: "Hi",
      }),
    ).toThrow(/--phone/);
  });
});

describe("SMS CLI commands", () => {
  it("dispatches safe setup, sender, list, and revocation commands to the SDK", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const sms = mockClient();

    await smsSetup({ output: "json" });
    await smsCompliance({ output: "json" });
    await smsPilotReadiness({ output: "json" });
    await smsSendersList({ output: "json" });
    await smsSenderUpsert({
      provider: "twilio",
      country: "US",
      senderType: "10dlc",
      output: "json",
    });
    await smsSenderPause("sender_1", {
      reason: "registration expired",
      output: "json",
    });
    await smsSenderResume("sender_1", { output: "json" });
    await smsSenderPilotCertification("sender_1", { output: "json" });
    await smsListsList({ output: "json" });
    await smsListsCreate({ name: "SMS VIP", keyword: "VIP", output: "json" });
    await smsConsentRecord({
      phone: "+14155550123",
      action: "revoked",
      source: "manual",
      proofText: "Operator revocation request",
      output: "json",
    });

    expect(sms.setup).toHaveBeenCalledTimes(1);
    expect(sms.compliance).toHaveBeenCalledTimes(1);
    expect(sms.pilotReadiness).toHaveBeenCalledTimes(1);
    expect(sms.listSenders).toHaveBeenCalledTimes(1);
    expect(sms.upsertSender).toHaveBeenCalledWith({
      provider: "twilio",
      country: "US",
      sender_type: "10dlc",
    });
    expect(sms.pauseSender).toHaveBeenCalledWith(
      "sender_1",
      "registration expired",
    );
    expect(sms.resumeSender).toHaveBeenCalledWith("sender_1");
    expect(sms.senderPilotCertification).toHaveBeenCalledWith("sender_1");
    expect(sms.submitBrandRegistration).not.toHaveBeenCalled();
    expect(sms.submitCampaignRegistration).not.toHaveBeenCalled();
    expect(sms.pollA2PRegistration).not.toHaveBeenCalled();
    expect(sms.listLists).toHaveBeenCalledTimes(1);
    expect(sms.createList).toHaveBeenCalledWith({
      name: "SMS VIP",
      keyword: "VIP",
    });
    expect(sms.recordConsent).toHaveBeenCalledWith({
      phone_e164: "+14155550123",
      action: "revoked",
      source: "manual",
      proof_text: "Operator revocation request",
    });
  });

  it("dispatches SMS campaign lifecycle commands to the SDK", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const sms = mockClient();

    await smsCampaignsList({ output: "json" });
    await smsCampaignsGet("sms_cmp_1", { output: "json" });
    await smsCampaignsCreate({
      senderProfileId: "sender_1",
      listId: "sms_list_1",
      name: "Launch",
      body: "Hi",
      output: "json",
    });
    await smsCampaignReport("sms_cmp_1", { output: "json" });
    await smsCampaignReportExport("sms_cmp_1", {
      exportStatus: "problems",
      limit: 100,
      output: "json",
    });
    await smsCampaignSend("sms_cmp_1", {
      limit: 25,
      linkTracking: true,
      output: "json",
    });
    await smsCampaignSchedule("sms_cmp_1", {
      scheduledAt: "2026-07-01T10:00:00Z",
      output: "json",
    });
    await smsCampaignPause("sms_cmp_1", { output: "json" });
    await smsCampaignResume("sms_cmp_1", { output: "json" });
    await smsCampaignCancel("sms_cmp_1", { output: "json" });
    await smsTestSend({
      senderProfileId: "sender_1",
      listId: "sms_list_1",
      phone: "+15551234567",
      body: "Hi",
      output: "json",
    });

    expect(sms.listCampaigns).toHaveBeenCalledTimes(1);
    expect(sms.getCampaign).toHaveBeenCalledWith("sms_cmp_1");
    expect(sms.createCampaign).toHaveBeenCalledWith({
      sender_profile_id: "sender_1",
      list_id: "sms_list_1",
      name: "Launch",
      body: "Hi",
    });
    expect(sms.campaignReport).not.toHaveBeenCalled();
    expect(sms.exportCampaignReport).not.toHaveBeenCalled();
    expect(sms.sendCampaign).not.toHaveBeenCalled();
    expect(sms.scheduleCampaign).not.toHaveBeenCalled();
    expect(sms.pauseCampaign).toHaveBeenCalledWith("sms_cmp_1");
    expect(sms.resumeCampaign).not.toHaveBeenCalled();
    expect(sms.cancelCampaign).toHaveBeenCalledWith("sms_cmp_1");
    expect(sms.sendTest).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it("preserves bounded suppression pagination and exact manual receipts", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const sms = mockClient();
    await smsSuppressionsList({
      reason: "manual",
      cursor: "v1.b3BhcXVl",
      limit: "1",
      tenantUuid: "00000000-0000-0000-0000-000000000001",
    });
    await smsSuppressionsList({
      phone: "+12025550101",
      reason: "manual",
      tenantUuid: "00000000-0000-0000-0000-000000000001",
    });
    await smsSuppressionAdd({ phone: "+12025550101" });
    await smsSuppressionRemove("33333333-3333-4333-8333-333333333333", {
      yes: true,
      tenantUuid: "00000000-0000-0000-0000-000000000001",
    });
    expect(sms.listSuppressions).toHaveBeenCalledWith({
      reason: "manual",
      cursor: "v1.b3BhcXVl",
      limit: 1,
      tenantId: "00000000-0000-0000-0000-000000000001",
    });
    expect(sms.listSuppressions).toHaveBeenCalledWith({
      phone: "+12025550101",
      reason: "manual",
      tenantId: "00000000-0000-0000-0000-000000000001",
    });
    expect(sms.addSuppression).toHaveBeenCalledWith({
      phone: "+12025550101",
      reason: "manual",
    });
    expect(sms.removeSuppression).toHaveBeenCalledWith(
      "33333333-3333-4333-8333-333333333333",
      "00000000-0000-0000-0000-000000000001",
    );
  });

  it("refuses malformed suppression inputs before creating a client", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.mocked(createClient).mockClear();
    await smsSuppressionsList({ phone: "" });
    await smsSuppressionsList({ phone: "letters12025550101" });
    await smsSuppressionsList({ phone: "\u00a0+12025550101" });
    await smsSuppressionsList({ phone: "\t+12025550101" });
    await smsSuppressionsList({ phone: "+12025550101\u202e" });
    await smsSuppressionsList({
      tenantUuid: "\u00a000000000-0000-0000-0000-000000000001",
    });
    await smsSuppressionsList({ tenantUuid: "" });
    await smsSuppressionsList({ cursor: "" });
    await smsSuppressionsList({ cursor: " v1.b3BhcXVl" });
    await smsSuppressionsList({ reason: " " });
    await smsSuppressionAdd({ phone: "+12021230100" });
    await smsSuppressionAdd({ phone: "+12025550101\u00a0" });
    await smsSuppressionRemove("33333333-3333-4333-8333-333333333333", {});
    await smsSuppressionRemove("33333333-3333-4333-8333-333333333333", {
      yes: true,
      tenantUuid: "00000000-0000-0000-0000-000000000001\t",
    });
    expect(createClient).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it("holds SMS evidence, A2P, dispatch, and consent grants without identity data", async () => {
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    vi.mocked(createClient).mockClear();
    const privateId = "campaign/+15552345678/private-token";

    await smsCampaignReport(privateId, { apiKey: "secret-api-token" });
    await smsCampaignReportExport(privateId, {
      apiKey: "secret-api-token",
      exportStatus: "failed",
      limit: 100,
    });
    await smsA2PBrandSubmit(privateId, {
      apiKey: "secret-api-token",
      payload: '{"company_name":"Private company"}',
    });
    await smsA2PCampaignSubmit(privateId, {
      apiKey: "secret-api-token",
      payload: '{"description":"Private campaign"}',
    });
    await smsA2PPoll(privateId, { apiKey: "secret-api-token" });
    await smsSenderUpsert({
      apiKey: "secret-api-token",
      brandRegistrationSid: "BN_PRIVATE",
    });
    await smsCampaignsCreate({
      apiKey: "secret-api-token",
      name: "Private scheduled campaign",
      body: "Private body",
      status: "scheduled",
      scheduledAt: "2026-08-23T12:00:00Z",
    });
    await smsCampaignSend(privateId, {
      apiKey: "secret-api-token",
      payload: '{"private":"body"}',
    });
    await smsCampaignSchedule(privateId, {
      apiKey: "secret-api-token",
      scheduledAt: "2026-08-23T12:00:00Z",
    });
    await smsCampaignResume(privateId, { apiKey: "secret-api-token" });
    await smsTestSend({
      apiKey: "secret-api-token",
      phone: "+15552345678",
      body: "Private body",
    });
    await smsConsentRecord({
      apiKey: "secret-api-token",
      phone: "+15552345678",
      action: "granted",
      source: "manual",
      proofText: "Private proof",
    });

    expect(createClient).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(error).toHaveBeenCalledTimes(12);
    const emitted = error.mock.calls.flat().join(" ");
    expect(emitted).toContain("sms_evidence_read_release_held");
    expect(emitted).toContain("sms_a2p_registration_release_held");
    expect(emitted).toContain("sms_registration_evidence_authority_required");
    expect(emitted).toContain("sms_campaign_dispatch_release_held");
    expect(emitted).toContain("sms_campaign_schedule_release_held");
    expect(emitted).toContain("sms_campaign_resume_release_held");
    expect(emitted).toContain("sms_test_dispatch_release_held");
    expect(emitted).not.toContain(privateId);
    expect(emitted).not.toContain("+15552345678");
    expect(emitted).not.toContain("secret-api-token");
    expect(emitted).not.toContain("/api/v1/");
  });
});
