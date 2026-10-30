// SPDX-License-Identifier: MIT

import { afterEach, describe, expect, it, vi } from "vitest";
import type { Campaign, CampaignQueueResponse } from "@postwave/sdk";
import { createClient } from "../src/lib/client.js";
import {
  campaignCreateInputFromOptions,
  campaignPatchFromOptions,
  campaignsCreate,
  campaignsDelete,
  campaignsQueue,
  campaignsSend,
  campaignsUpdate,
} from "../src/commands/campaigns.js";

vi.mock("../src/lib/client.js", () => ({
  createClient: vi.fn(),
}));

function campaignFixture(): Campaign {
  return {
    id: "cmp_1",
    tenant_id: "t_1",
    name: "Launch",
    subject: "Hi",
    status: "draft",
    created_at: "2026-06-20T00:00:00Z",
    updated_at: "2026-06-20T00:00:00Z",
  };
}

function makeCampaigns() {
  return {
    create: vi.fn(async (): Promise<Campaign> => campaignFixture()),
    update: vi.fn(
      async (): Promise<Campaign> => ({ ...campaignFixture(), subject: "Hello" }),
    ),
    delete: vi.fn(async (): Promise<void> => undefined),
    queue: vi.fn(
      async (): Promise<CampaignQueueResponse> => ({
        campaign_id: "cmp_1",
        recipients_queued: 10,
        status: "sending",
      }),
    ),
    send: vi.fn(
      async (): Promise<Campaign | CampaignQueueResponse> => ({
        ...campaignFixture(),
        status: "sending",
      }),
    ),
  };
}

function mockClient() {
  const campaigns = makeCampaigns();
  vi.mocked(createClient).mockReturnValue({ campaigns } as unknown as ReturnType<
    typeof createClient
  >);
  return campaigns;
}

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

describe("campaign payload builders", () => {
  it("builds a create input", () => {
    expect(
      campaignCreateInputFromOptions({
        name: "Launch",
        subject: "Hi",
        bodyHtml: "<p>x</p>",
        segmentId: "seg_1",
      }),
    ).toEqual({
      name: "Launch",
      subject: "Hi",
      body_html: "<p>x</p>",
      segment_id: "seg_1",
    });
  });

  it("requires --name and --subject on create", () => {
    expect(() => campaignCreateInputFromOptions({ subject: "Hi" })).toThrow(/--name/);
    expect(() => campaignCreateInputFromOptions({ name: "Launch" })).toThrow(/--subject/);
  });

  it("builds a patch with only provided fields", () => {
    expect(campaignPatchFromOptions({ subject: "Hello" })).toEqual({ subject: "Hello" });
  });

  it("throws when the patch is empty", () => {
    expect(() => campaignPatchFromOptions({})).toThrow(/at least one/i);
  });

  // Finding 4: `--scheduled-at ""` (CAC surfaces this as the number 0) must
  // unschedule by sending scheduled_at: null, not silently no-op or crash.
  it("unschedules on an explicit empty --scheduled-at (CAC number 0)", () => {
    expect(campaignPatchFromOptions({ scheduledAt: 0 })).toEqual({
      scheduled_at: null,
    });
  });

  it("unschedules on an explicit empty-string --scheduled-at", () => {
    expect(campaignPatchFromOptions({ scheduledAt: "  " })).toEqual({
      scheduled_at: null,
    });
  });

  it("leaves scheduled_at untouched when the flag is absent", () => {
    expect(() => campaignPatchFromOptions({ scheduledAt: undefined })).toThrow(
      /at least one/i,
    );
    expect(campaignPatchFromOptions({ subject: "Hi", scheduledAt: undefined })).toEqual({
      subject: "Hi",
    });
  });

  it("sets a concrete scheduled_at when provided", () => {
    expect(campaignPatchFromOptions({ scheduledAt: "2026-07-01T00:00:00Z" })).toEqual({
      scheduled_at: "2026-07-01T00:00:00Z",
    });
  });
});

describe("campaigns lifecycle commands", () => {
  it("create calls the SDK", async () => {
    const campaigns = mockClient();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    await campaignsCreate({ name: "Launch", subject: "Hi" });
    expect(campaigns.create).toHaveBeenCalledWith({ name: "Launch", subject: "Hi" });
  });

  it("update passes id + patch", async () => {
    const campaigns = mockClient();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    await campaignsUpdate("cmp_1", { subject: "Hello" });
    expect(campaigns.update).toHaveBeenCalledWith("cmp_1", { subject: "Hello" });
  });

  it("queue requires confirmation and calls the SDK with --yes", async () => {
    const campaigns = mockClient();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await campaignsQueue("cmp_1", {});
    expect(campaigns.queue).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);

    process.exitCode = undefined;
    await campaignsQueue("cmp_1", { yes: true });
    expect(campaigns.queue).toHaveBeenCalledWith("cmp_1", { sandbox: false });
  });

  it("queue allows --sandbox without --yes", async () => {
    const campaigns = mockClient();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    await campaignsQueue("cmp_1", { sandbox: true });
    expect(campaigns.queue).toHaveBeenCalledWith("cmp_1", { sandbox: true });
  });

  it("send requires confirmation and calls the SDK with --yes", async () => {
    const campaigns = mockClient();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await campaignsSend("cmp_1", {});
    expect(campaigns.send).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);

    process.exitCode = undefined;
    await campaignsSend("cmp_1", { yes: true });
    expect(campaigns.send).toHaveBeenCalledWith("cmp_1", { sandbox: false });
  });

  // Finding 1: an approval-required response is a 200 from the SDK but means the
  // campaign was NOT dispatched. The CLI must exit non-zero so scripts notice.
  it("queue exits non-zero when the dispatch is blocked (approval_required)", async () => {
    const campaigns = mockClient();
    campaigns.queue.mockResolvedValueOnce({
      campaign_id: "cmp_1",
      recipients_queued: 0,
      status: "approval_required",
      approval_id: "apr_1",
      approval_status: "pending",
      message: "Awaiting approver sign-off.",
    });
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await campaignsQueue("cmp_1", { yes: true });
    expect(campaigns.queue).toHaveBeenCalledWith("cmp_1", { sandbox: false });
    expect(process.exitCode).toBe(1);
    expect(errSpy).toHaveBeenCalled();
  });

  it("send exits non-zero when send returns approval_required", async () => {
    const campaigns = mockClient();
    campaigns.send.mockResolvedValueOnce({
      campaign_id: "cmp_1",
      recipients_queued: 0,
      status: "approval_required",
    });
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await campaignsSend("cmp_1", { yes: true });
    expect(process.exitCode).toBe(1);
  });

  it("queue exits 0 on a normal queued response", async () => {
    const campaigns = mockClient();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    await campaignsQueue("cmp_1", { yes: true });
    expect(campaigns.queue).toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });

  it("send exits 0 when send returns a plain Campaign (no campaign_id gate)", async () => {
    const campaigns = mockClient();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    await campaignsSend("cmp_1", { yes: true });
    expect(process.exitCode).toBeUndefined();
  });

  it("delete requires --yes", async () => {
    const campaigns = mockClient();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await campaignsDelete("cmp_1", {});
    expect(campaigns.delete).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);

    process.exitCode = undefined;
    await campaignsDelete("cmp_1", { yes: true });
    expect(campaigns.delete).toHaveBeenCalledWith("cmp_1");
  });
});
