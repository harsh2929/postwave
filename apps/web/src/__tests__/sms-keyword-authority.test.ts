// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  delete: vi.fn(),
  get: vi.fn(),
  patch: vi.fn(),
  post: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  api: {
    delete: mocks.delete,
    get: mocks.get,
    patch: mocks.patch,
    post: mocks.post,
  },
}));

import { canToggleSmsKeywordResponse } from "@/app/(dashboard)/app/sms/sms-keyword-responses-card";
import {
  createSmsKeywordResponse,
  deleteSmsKeywordResponse,
  listSmsKeywordResponses,
  updateSmsKeywordResponse,
  type SmsKeywordResponseInput,
} from "@/lib/sms-api";

beforeEach(() => {
  mocks.delete.mockReset();
  mocks.patch.mockReset();
  mocks.post.mockReset();
  mocks.get.mockReset();
});

const TENANT = "22222222-2222-4222-8222-222222222222";
const ROW_ID = "11111111-1111-4111-8111-111111111111";
const VERSION = "2026-08-21T09:00:00Z";

function keywordRow(over: Record<string, unknown> = {}) {
  return {
    id: ROW_ID,
    tenant_id: TENANT,
    keyword: "LEAVE",
    response_body:
      "You are unsubscribed from SMS marketing messages from this sender.",
    response_text:
      "You are unsubscribed from SMS marketing messages from this sender.",
    action: "opt_out",
    enabled: true,
    autoReplyDispatchAvailable: false,
    autoReplyDispatchUnavailableReason: "sms_auto_reply_dispatch_release_held",
    opt_in_count: 0,
    created_at: "2026-08-21T09:00:00Z",
    updated_at: "2026-08-21T09:00:00Z",
    ...over,
  };
}

describe("web SMS custom keyword consent authority", () => {
  it.each([
    { items: [] },
    { tenantId: "33333333-3333-4333-8333-333333333333", items: [] },
    { tenantId: TENANT, items: [], extra: true },
  ])("rejects an unbound or malformed empty list envelope", async (payload) => {
    mocks.get.mockResolvedValue(payload);
    await expect(listSmsKeywordResponses(TENANT)).rejects.toThrow(
      /keyword-response envelope/u,
    );
  });

  it("allows only current opt-out rows to be toggled", () => {
    expect(canToggleSmsKeywordResponse({ action: "reply_only" })).toBe(false);
    expect(canToggleSmsKeywordResponse({ action: "opt_out" })).toBe(true);
  });

  it("rejects rows that omit or misstate the frozen dispatch availability", async () => {
    mocks.get.mockResolvedValue({
      tenantId: TENANT,
      items: [
        {
          id: ROW_ID,
          tenant_id: TENANT,
          keyword: "LEAVE",
          response_body:
            "You are unsubscribed from SMS marketing messages from this sender.",
          response_text: "Different stored response text.",
          action: "opt_out",
          enabled: true,
          opt_in_count: 0,
          created_at: "2026-08-21T09:00:00Z",
          updated_at: "2026-08-21T09:00:00Z",
        },
      ],
    });
    await expect(listSmsKeywordResponses(TENANT)).rejects.toThrow(
      /keyword-response row/u,
    );
  });

  it("holds reply-only creation/enabling locally but preserves opt-out state changes", async () => {
    const replyOnly = {
      keyword: "INFO",
      response_body: "Private reply +15552345678",
      action: "reply_only",
      enabled: true,
    } as unknown as SmsKeywordResponseInput;
    await expect(
      Promise.resolve().then(() => createSmsKeywordResponse(replyOnly, TENANT)),
    ).rejects.toMatchObject({
      code: "sms_auto_reply_dispatch_release_held",
      status: 503,
    });
    await expect(
      Promise.resolve().then(() =>
        updateSmsKeywordResponse(
          ROW_ID,
          { action: "reply_only", enabled: true } as never,
          VERSION,
          TENANT,
        ),
      ),
    ).rejects.toMatchObject({
      code: "sms_auto_reply_dispatch_release_held",
      status: 503,
    });
    expect(mocks.post).not.toHaveBeenCalled();
    expect(mocks.patch).not.toHaveBeenCalled();
  });

  it("rejects injected custom opt-in creates and updates with zero network", async () => {
    const optIn = {
      keyword: "JOIN",
      response_body: "Welcome",
      action: "opt_in",
    } as unknown as SmsKeywordResponseInput;

    await expect(
      Promise.resolve().then(() => createSmsKeywordResponse(optIn, TENANT)),
    ).rejects.toMatchObject({ code: "validation_failed", status: 422 });
    await expect(
      Promise.resolve().then(() =>
        updateSmsKeywordResponse(
          ROW_ID,
          { action: "opt_in" } as never,
          VERSION,
          TENANT,
        ),
      ),
    ).rejects.toMatchObject({ code: "validation_failed", status: 422 });
    expect(mocks.post).not.toHaveBeenCalled();
    expect(mocks.patch).not.toHaveBeenCalled();
  });

  it.each([
    keywordRow({ tenant_id: "33333333-3333-4333-8333-333333333333" }),
    keywordRow({ id: "11111111-1111-1111-8111-111111111111" }),
    keywordRow({ action: "opt_in" }),
    keywordRow({ keyword: "leave" }),
    keywordRow({ keyword: "STOP" }),
    keywordRow({ autoReplyDispatchAvailable: true }),
    keywordRow({ response_text: "different" }),
    keywordRow({ created_at: "1999-12-31T23:59:59Z" }),
    keywordRow({ created_at: "2000-01-01T00:00:00+14:00" }),
    keywordRow({ updated_at: "2100-01-01T00:00:00Z" }),
    keywordRow({ updated_at: "2099-12-31T23:59:59-14:00" }),
    { ...keywordRow(), surprise: true },
  ])(
    "rejects tenant, identifier, action, dispatch, and projection poison",
    async (row) => {
      mocks.get.mockResolvedValue({ tenantId: TENANT, items: [row] });
      await expect(listSmsKeywordResponses(TENANT)).rejects.toThrow(
        /keyword-response row/u,
      );
    },
  );

  it("binds create receipts to tenant, normalized keyword, and current action", async () => {
    mocks.post.mockResolvedValue(keywordRow());
    await expect(
      createSmsKeywordResponse(
        {
          keyword: "leave",
          response_body:
            "You are unsubscribed from SMS marketing messages from this sender.",
          action: "opt_out",
          enabled: true,
        },
        TENANT,
      ),
    ).resolves.toMatchObject({ tenant_id: TENANT, keyword: "LEAVE" });
    await expect(
      Promise.resolve().then(() =>
        createSmsKeywordResponse(
          {
            keyword: " leave ",
            response_body:
              "You are unsubscribed from SMS marketing messages from this sender.",
            action: "opt_out",
          },
          TENANT,
        ),
      ),
    ).rejects.toThrow(/invalid SMS keyword/iu);
    expect(mocks.post).toHaveBeenCalledTimes(1);
    mocks.post.mockResolvedValue(keywordRow({ keyword: "OTHER" }));
    await expect(
      createSmsKeywordResponse(
        {
          keyword: "LEAVE",
          response_body:
            "You are unsubscribed from SMS marketing messages from this sender.",
          action: "opt_out",
        },
        TENANT,
      ),
    ).rejects.toThrow(/receipt identity/u);
  });

  it("sends the selected row revision on PATCH and preserves typed stale conflicts", async () => {
    mocks.patch.mockResolvedValue(
      keywordRow({ enabled: false, updated_at: "2026-08-21T10:00:00Z" }),
    );
    await expect(
      updateSmsKeywordResponse(
        ROW_ID,
        { action: "opt_out", enabled: false },
        VERSION,
        TENANT,
      ),
    ).resolves.toMatchObject({ id: ROW_ID, enabled: false });
    expect(mocks.patch).toHaveBeenCalledWith(
      `/api/v1/sms/keyword-responses/${ROW_ID}`,
      {
        action: "opt_out",
        enabled: false,
        expected_updated_at: VERSION,
      },
      { signal: undefined },
    );

    const stale = Object.assign(new Error("policy changed"), {
      code: "policy_changed",
      status: 409,
    });
    mocks.patch.mockRejectedValueOnce(stale);
    await expect(
      updateSmsKeywordResponse(
        ROW_ID,
        { action: "opt_out", enabled: false },
        VERSION,
        TENANT,
      ),
    ).rejects.toBe(stale);
  });

  it("renames an opt-out keyword with a revision-bound PATCH body", async () => {
    const canonical =
      "You are unsubscribed from SMS marketing messages from this sender.";
    mocks.patch.mockResolvedValue(
      keywordRow({ keyword: "DEPART", updated_at: "2026-08-21T10:00:00Z" }),
    );
    await expect(
      updateSmsKeywordResponse(
        ROW_ID,
        { keyword: "depart", action: "opt_out", response_body: canonical },
        VERSION,
        TENANT,
      ),
    ).resolves.toMatchObject({ id: ROW_ID, keyword: "DEPART" });
    expect(mocks.patch).toHaveBeenCalledWith(
      `/api/v1/sms/keyword-responses/${ROW_ID}`,
      {
        keyword: "depart",
        action: "opt_out",
        response_body: canonical,
        expected_updated_at: VERSION,
      },
      { signal: undefined },
    );

    mocks.patch.mockResolvedValueOnce(keywordRow({ keyword: "OTHER" }));
    await expect(
      updateSmsKeywordResponse(
        ROW_ID,
        { keyword: "DEPART", action: "opt_out", response_body: canonical },
        VERSION,
        TENANT,
      ),
    ).rejects.toThrow(/receipt identity/u);
    await expect(
      Promise.resolve().then(() =>
        updateSmsKeywordResponse(
          ROW_ID,
          { keyword: "STOP", action: "opt_out" },
          VERSION,
          TENANT,
        ),
      ),
    ).rejects.toThrow(/invalid SMS keyword/iu);
    expect(mocks.patch).toHaveBeenCalledTimes(2);
  });

  it("requires an exact tenant/id-bound delete receipt", async () => {
    mocks.delete.mockResolvedValue({ ok: true, tenantId: TENANT, id: ROW_ID });
    await expect(
      deleteSmsKeywordResponse(ROW_ID, VERSION, TENANT),
    ).resolves.toEqual({ ok: true, tenantId: TENANT, id: ROW_ID });
    expect(mocks.delete).toHaveBeenCalledWith(
      `/api/v1/sms/keyword-responses/${ROW_ID}`,
      { body: { expected_updated_at: VERSION }, signal: undefined },
    );
    for (const receipt of [
      { ok: true },
      {
        ok: true,
        tenantId: TENANT,
        id: "33333333-3333-4333-8333-333333333333",
      },
      { ok: true, tenantId: TENANT, id: ROW_ID, extra: true },
    ]) {
      mocks.delete.mockResolvedValueOnce(receipt);
      await expect(
        deleteSmsKeywordResponse(ROW_ID, VERSION, TENANT),
      ).rejects.toThrow(/deletion receipt/u);
    }
  });
});
