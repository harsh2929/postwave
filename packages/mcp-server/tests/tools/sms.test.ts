// SPDX-License-Identifier: MIT
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { smsTools } from "../../src/tools/sms.js";

function senderFixture() {
  return {
    id: "sender_1",
    provider: "twilio",
    country: "US",
    sender_type: "10dlc",
    registration_status: "approved",
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
    body: "Hi",
    status: "draft",
    created_at: "2026-06-17T00:00:00Z",
    updated_at: "2026-06-17T00:00:00Z",
  };
}

function makeClient() {
  const sms = {
    setup: vi.fn().mockResolvedValue({ senders: [], can_send: true, blocking_reasons: [] }),
    compliance: vi.fn().mockResolvedValue({ can_send: true, senders: [], items: [] }),
    pilotReadiness: vi.fn().mockResolvedValue({ can_pilot: true, counts: {}, items: [] }),
    listSenders: vi.fn().mockResolvedValue({ items: [senderFixture()] }),
    upsertSender: vi.fn().mockResolvedValue(senderFixture()),
    pauseSender: vi.fn().mockResolvedValue(senderFixture()),
    resumeSender: vi.fn().mockResolvedValue(senderFixture()),
    senderPilotCertification: vi.fn().mockResolvedValue({
      sender: senderFixture(),
      can_pilot: true,
      generated_at: "2026-06-17T00:00:00Z",
      items: [],
    }),
    submitBrandRegistration: vi.fn().mockResolvedValue({ sender: senderFixture() }),
    submitCampaignRegistration: vi.fn().mockResolvedValue({ sender: senderFixture() }),
    pollA2PRegistration: vi.fn().mockResolvedValue({ sender: senderFixture() }),
    listLists: vi.fn().mockResolvedValue({ items: [] }),
    createList: vi.fn().mockResolvedValue({ id: "sms_list_1", name: "SMS VIP" }),
    recordConsent: vi.fn().mockResolvedValue({ ok: true }),
    listSuppressions: vi.fn().mockResolvedValue({
      tenantId: "00000000-0000-0000-0000-000000000001",
      items: [],
      total: 0,
      snapshotAt: "2026-08-28T10:00:00Z",
    }),
    addSuppression: vi.fn().mockResolvedValue({
      id: "33333333-3333-4333-8333-333333333333",
      phone_e164: "+12025550101",
      reason: "manual",
      source: "manual",
      created_at: "2026-08-28T09:00:00Z",
      reversible: true,
    }),
    removeSuppression: vi.fn().mockResolvedValue({
      ok: true,
      tenantId: "00000000-0000-0000-0000-000000000001",
      id: "33333333-3333-4333-8333-333333333333",
    }),
    listCampaigns: vi.fn().mockResolvedValue({ items: [campaignFixture()] }),
    getCampaign: vi.fn().mockResolvedValue(campaignFixture()),
    createCampaign: vi.fn().mockResolvedValue(campaignFixture()),
    campaignReport: vi.fn().mockResolvedValue({ campaign: campaignFixture(), recipients: 10 }),
    exportCampaignReport: vi.fn().mockResolvedValue("phone,status\n+15551234567,delivered\n"),
    sendCampaign: vi.fn().mockResolvedValue({ campaign: campaignFixture(), queued: 10 }),
    scheduleCampaign: vi.fn().mockResolvedValue({ ...campaignFixture(), status: "scheduled" }),
    pauseCampaign: vi.fn().mockResolvedValue({ ...campaignFixture(), status: "paused" }),
    resumeCampaign: vi.fn().mockResolvedValue({ ...campaignFixture(), status: "sending" }),
    cancelCampaign: vi.fn().mockResolvedValue({ ...campaignFixture(), status: "cancelled" }),
    sendTest: vi.fn().mockResolvedValue({ gate: { allowed: true }, message: { id: "msg_1" } }),
  };
  return { client: { sms }, sms };
}

describe("smsTools", () => {
  it("exposes the first-party SMS tool surface with zod schemas", () => {
    const { client } = makeClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tools = smsTools(client as any);
    expect(tools.map((t) => t.name)).toEqual([
      "sms_setup",
      "sms_compliance",
      "sms_pilot_readiness",
      "sms_sender_list",
      "sms_sender_upsert",
      "sms_sender_pause",
      "sms_sender_resume",
      "sms_sender_pilot_certification",
      "sms_a2p_brand_submit",
      "sms_a2p_campaign_submit",
      "sms_a2p_poll",
      "sms_list_list",
      "sms_list_create",
      "sms_consent_record",
      "sms_suppression_list",
      "sms_suppression_add",
      "sms_suppression_remove",
      "sms_campaign_list",
      "sms_campaign_get",
      "sms_campaign_create",
      "sms_campaign_report",
      "sms_campaign_report_export",
      "sms_campaign_send",
      "sms_campaign_schedule",
      "sms_campaign_pause",
      "sms_campaign_resume",
      "sms_campaign_cancel",
      "sms_test_send",
    ]);
    for (const t of tools) expect(t.schema).toBeInstanceOf(z.ZodType);
    expect(tools.find((t) => t.name === "sms_sender_upsert")?.description).toBe(
      "Create or update a first-party SMS sender profile. Hosted mode has no configured or accepted process-global provider credentials. Provider effects and callbacks remain release-held until a tenant-bound encrypted credential vault and provider-account ownership resolver exists; this does not create provider messaging services, profiles, applications, or phone-number campaign assignments.",
    );
  });

  it("binds exact-admin suppression tools to explicit pages and receipts", async () => {
    const c = makeClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tools = smsTools(c.client as any);
    const list = tools.find((t) => t.name === "sms_suppression_list")!;
    const add = tools.find((t) => t.name === "sms_suppression_add")!;
    const remove = tools.find((t) => t.name === "sms_suppression_remove")!;
    expect(list.requiredScopes).toEqual(["admin"]);
    expect(list.annotations?.readOnlyHint).toBe(true);
    expect(remove.annotations?.destructiveHint).toBe(true);
    const exactInput = list.schema.parse({
      tenant_id: "00000000-0000-0000-0000-000000000001",
      phone: "+12025550101",
      reason: "manual",
    });
    await list.handler(exactInput);
    await add.handler({ phone: "+12025550101" });
    await remove.handler({
      suppression_id: "33333333-3333-4333-8333-333333333333",
      tenant_id: "00000000-0000-0000-0000-000000000001",
      confirm_manual_hold_removal: true,
    });
    expect(c.sms.listSuppressions).toHaveBeenCalledWith({
      tenantId: "00000000-0000-0000-0000-000000000001",
      phone: "+12025550101",
      reason: "manual",
    });
    expect(c.sms.addSuppression).toHaveBeenCalledWith({
      phone: "+12025550101",
      reason: "manual",
    });
    expect(c.sms.removeSuppression).toHaveBeenCalledWith(
      "33333333-3333-4333-8333-333333333333",
      "00000000-0000-0000-0000-000000000001",
    );
    expect(
      list.schema.safeParse({
        tenant_id: "00000000-0000-0000-0000-000000000001",
        phone: "+12025550101",
        limit: 1,
      }).success,
    ).toBe(false);
    expect(
      list.schema.safeParse({
        tenant_id: "00000000-0000-0000-0000-000000000001",
        phone: "+12025550101",
        cursor: "v1.b3BhcXVl",
      }).success,
    ).toBe(false);
  });

  it("dispatches safe sender, list, and revocation tools while holding A2P effects", async () => {
    const c = makeClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tools = smsTools(c.client as any);

    await tools.find((t) => t.name === "sms_setup")!.handler({});
    await tools.find((t) => t.name === "sms_sender_upsert")!.handler({
      provider: "twilio",
      country: "US",
      sender_type: "10dlc",
    });
    await tools.find((t) => t.name === "sms_sender_pause")!.handler({
      sender_id: "sender_1",
      reason: "registration expired",
    });
    await tools.find((t) => t.name === "sms_sender_resume")!.handler({ sender_id: "sender_1" });
    await tools.find((t) => t.name === "sms_sender_pilot_certification")!.handler({
      sender_id: "sender_1",
    });
    await expect(
      tools.find((t) => t.name === "sms_a2p_brand_submit")!.handler({
        sender_id: "sender_1",
        payload: { company_name: "Moosewave" },
      }),
    ).rejects.toThrow("sms_a2p_registration_release_held");
    await expect(
      tools.find((t) => t.name === "sms_a2p_campaign_submit")!.handler({
        sender_id: "sender_1",
        payload: { description: "Launch", message_flow: "Opt in", message_samples: ["Hi"] },
      }),
    ).rejects.toThrow("sms_a2p_registration_release_held");
    await expect(
      tools.find((t) => t.name === "sms_a2p_poll")!.handler({ sender_id: "sender_1" }),
    ).rejects.toThrow("sms_a2p_registration_release_held");
    await tools.find((t) => t.name === "sms_list_create")!.handler({
      name: "SMS VIP",
      keyword: "VIP",
    });
    await tools.find((t) => t.name === "sms_consent_record")!.handler({
      phone_e164: "+15551234567",
      action: "revoked",
      source: "manual",
      proof_text: "Operator received an explicit revocation request.",
    });

    expect(c.sms.setup).toHaveBeenCalledTimes(1);
    expect(c.sms.upsertSender).toHaveBeenCalledWith({
      provider: "twilio",
      country: "US",
      sender_type: "10dlc",
    });
    expect(c.sms.pauseSender).toHaveBeenCalledWith("sender_1", "registration expired");
    expect(c.sms.resumeSender).toHaveBeenCalledWith("sender_1");
    expect(c.sms.senderPilotCertification).toHaveBeenCalledWith("sender_1");
    expect(c.sms.submitBrandRegistration).not.toHaveBeenCalled();
    expect(c.sms.submitCampaignRegistration).not.toHaveBeenCalled();
    expect(c.sms.pollA2PRegistration).not.toHaveBeenCalled();
    expect(c.sms.createList).toHaveBeenCalledWith({ name: "SMS VIP", keyword: "VIP" });
    expect(c.sms.recordConsent).toHaveBeenCalledWith({
      phone_e164: "+15551234567",
      action: "revoked",
      source: "manual",
      proof_text: "Operator received an explicit revocation request.",
    });
  });

  it("dispatches safe campaign reads and draft mutations while holding evidence and effects", async () => {
    const c = makeClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tools = smsTools(c.client as any);

    await tools.find((t) => t.name === "sms_campaign_list")!.handler({});
    await tools.find((t) => t.name === "sms_campaign_get")!.handler({ campaign_id: "sms_cmp_1" });
    await tools.find((t) => t.name === "sms_campaign_create")!.handler({
      sender_profile_id: "sender_1",
      list_id: "sms_list_1",
      name: "Launch",
      body: "Hi",
    });
    await expect(
      tools.find((t) => t.name === "sms_campaign_report")!.handler({ campaign_id: "sms_cmp_1" }),
    ).rejects.toThrow("sms_evidence_read_release_held");
    await expect(
      tools.find((t) => t.name === "sms_campaign_report_export")!.handler({
        campaign_id: "sms_cmp_1",
        status: "problems",
        limit: 100,
      }),
    ).rejects.toThrow("sms_evidence_read_release_held");
    await expect(
      tools.find((t) => t.name === "sms_campaign_send")!.handler({
        campaign_id: "sms_cmp_1",
        options: { limit: 25, link_tracking: true },
      }),
    ).rejects.toThrow("sms_campaign_dispatch_release_held");
    await expect(
      tools.find((t) => t.name === "sms_campaign_schedule")!.handler({
        campaign_id: "sms_cmp_1",
        scheduled_at: "2026-07-01T10:00:00Z",
      }),
    ).rejects.toThrow("sms_campaign_schedule_release_held");
    await tools.find((t) => t.name === "sms_campaign_pause")!.handler({
      campaign_id: "sms_cmp_1",
    });
    await expect(
      tools.find((t) => t.name === "sms_campaign_resume")!.handler({ campaign_id: "sms_cmp_1" }),
    ).rejects.toThrow("sms_campaign_resume_release_held");
    await tools.find((t) => t.name === "sms_campaign_cancel")!.handler({
      campaign_id: "sms_cmp_1",
    });
    await expect(
      tools.find((t) => t.name === "sms_test_send")!.handler({
        sender_profile_id: "sender_1",
        list_id: "sms_list_1",
        to: "+15551234567",
        body: "Hi",
      }),
    ).rejects.toThrow("sms_test_dispatch_release_held");

    expect(c.sms.listCampaigns).toHaveBeenCalledTimes(1);
    expect(c.sms.getCampaign).toHaveBeenCalledWith("sms_cmp_1");
    expect(c.sms.createCampaign).toHaveBeenCalledWith({
      sender_profile_id: "sender_1",
      list_id: "sms_list_1",
      name: "Launch",
      body: "Hi",
    });
    expect(c.sms.campaignReport).not.toHaveBeenCalled();
    expect(c.sms.exportCampaignReport).not.toHaveBeenCalled();
    expect(c.sms.sendCampaign).not.toHaveBeenCalled();
    expect(c.sms.scheduleCampaign).not.toHaveBeenCalled();
    expect(c.sms.pauseCampaign).toHaveBeenCalledWith("sms_cmp_1");
    expect(c.sms.resumeCampaign).not.toHaveBeenCalled();
    expect(c.sms.cancelCampaign).toHaveBeenCalledWith("sms_cmp_1");
    expect(c.sms.sendTest).not.toHaveBeenCalled();
  });
});
