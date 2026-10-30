// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
import { act, createElement, type FormEvent, useState } from "react";
import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useSmsCampaignActions } from "@/app/(dashboard)/app/sms/use-sms-campaign-actions";
import type { SmsCampaignDraft } from "@/app/(dashboard)/app/sms/sms-campaign-drafts-card";
import type {
  SmsCampaign,
  SmsCampaignReport,
  SmsCreditBalance,
  SmsDiscountCode,
  SmsSenderProfile,
  SmsTemplate,
} from "@/lib/sms-api";

(
  globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  }
).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  cancelSmsCampaign: vi.fn(),
  checkoutSmsCreditTopUp: vi.fn(),
  createSmsCampaign: vi.fn(),
  getSmsCampaignReport: vi.fn(),
  pauseSmsCampaign: vi.fn(),
  resumeSmsCampaign: vi.fn(),
  scheduleSmsCampaign: vi.fn(),
  sendSmsCampaign: vi.fn(),
  upsertSmsSender: vi.fn(),
  toastError: vi.fn(),
  toastInfo: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("@/lib/sms-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/sms-api")>();
  return {
    ...actual,
    cancelSmsCampaign: mocks.cancelSmsCampaign,
    checkoutSmsCreditTopUp: mocks.checkoutSmsCreditTopUp,
    createSmsCampaign: mocks.createSmsCampaign,
    getSmsCampaignReport: mocks.getSmsCampaignReport,
    pauseSmsCampaign: mocks.pauseSmsCampaign,
    resumeSmsCampaign: mocks.resumeSmsCampaign,
    scheduleSmsCampaign: mocks.scheduleSmsCampaign,
    sendSmsCampaign: mocks.sendSmsCampaign,
    upsertSmsSender: mocks.upsertSmsSender,
  };
});

vi.mock("sonner", () => ({
  toast: {
    error: mocks.toastError,
    info: mocks.toastInfo,
    success: mocks.toastSuccess,
  },
}));

afterEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = "";
});

function render(ui: ReactNode): Root {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => {
    root.render(ui);
  });
  return root;
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
  await act(async () => {
    await Promise.resolve();
  });
}

function draft(overrides: Partial<SmsCampaignDraft> = {}): SmsCampaignDraft {
  return {
    sender_profile_id: "sender_1",
    list_id: "list_1",
    name: "Launch sale",
    body: "Save today",
    media_url: "",
    status: "draft",
    scheduled_at: "",
    link_tracking: true,
    cost_cap_dollars: "",
    discount_code: "",
    send_timing: "fixed",
    local_time: "09:00",
    fallback_tz: "UTC",
    ab_enabled: false,
    ab_variants: [
      { label: "A", body: "", weight: "50" },
      { label: "B", body: "", weight: "50" },
    ],
    ...overrides,
  };
}

function campaign(overrides: Partial<SmsCampaign> = {}): SmsCampaign {
  return {
    id: "cmp_1",
    sender_profile_id: "sender_1",
    list_id: "list_1",
    name: "Launch sale",
    body: "Save today",
    status: "draft",
    created_at: "2026-06-28T00:00:00.000Z",
    updated_at: "2026-06-28T00:00:00.000Z",
    ...overrides,
  };
}

function report(item: SmsCampaign): SmsCampaignReport {
  return {
    campaign: item,
    recipients: 10,
    queued: 10,
    sending: 0,
    sent: 9,
    blocked: 0,
    failed: 1,
    cancelled: 0,
    delivered: 8,
    undelivered: 1,
    clicks: 2,
    unique_clickers: 2,
    segments: 1,
    cost_micros: 1000,
    status_counts: { delivered: 8 },
  };
}

const sender: SmsSenderProfile = {
  id: "sender_1",
  provider: "twilio",
  country: "US",
  sender_type: "10dlc",
  phone_number: "+14155550100",
  registration_status: "approved",
  created_at: "2026-06-28T00:00:00.000Z",
  updated_at: "2026-06-28T00:00:00.000Z",
};

const template: SmsTemplate = {
  id: "tpl_1",
  name: "Weekend sale",
  category: "promo",
  body: "Use {{discount_code}} for {{product_name}} by {{date}}",
  media_allowed: false,
  merge_fields: ["discount_code"],
  tags: [],
};

const creditBalance: SmsCreditBalance = {
  plan: "growth",
  included_credits: 1000,
  purchased_credits: 0,
  used_credits: 0,
  available_credits: 1000,
  period_start: "2026-06-01T00:00:00.000Z",
  period_end: "2026-07-01T00:00:00.000Z",
  entitlements: {},
  ledger_mode: "test",
};

const discountCodes: SmsDiscountCode[] = [
  {
    id: "disc_1",
    code: "VIP20",
    label: "VIP 20%",
    source: "shopify",
    currently_redeemable: true,
    times_redeemed: 0,
    applies_to: "all products",
    created_at: "2026-06-28T00:00:00.000Z",
  },
];

let latest: ReturnType<typeof useSmsCampaignActions> | null = null;
let latestDraft: SmsCampaignDraft | null = null;
let latestReports: Record<string, SmsCampaignReport> = {};

function Harness({
  initialDraft = draft(),
  initialReports = {},
  refresh = vi.fn(async () => undefined),
}: {
  initialDraft?: SmsCampaignDraft;
  initialReports?: Record<string, SmsCampaignReport>;
  refresh?: () => Promise<void>;
}) {
  const [campaignDraft, setCampaignDraft] = useState(initialDraft);
  const [reports, setReports] = useState(initialReports);
  const [, setPending] = useState<string | null>(null);
  latestDraft = campaignDraft;
  latestReports = reports;
  latest = useSmsCampaignActions({
    activeSender: sender,
    campaignCreditPreview: null,
    campaignDraft,
    campaignSender: sender,
    reports,
    refresh,
    setCampaignDraft,
    setPending,
    setReports,
    setup: { senders: [sender], can_send: true, blocking_reasons: [] },
    smsCreditBalance: creditBalance,
    smsDiscountCodes: discountCodes,
    smsTopUpQuote: null,
  });
  return null;
}

describe("useSmsCampaignActions", () => {
  it("holds financial checkout and MMS certification locally with zero effect", async () => {
    const root = render(createElement(Harness));
    try {
      await act(async () => {
        await latest?.startSmsTopUpCheckout();
        await latest?.recordMmsSmokePass();
      });

      expect(mocks.checkoutSmsCreditTopUp).not.toHaveBeenCalled();
      expect(mocks.upsertSmsSender).not.toHaveBeenCalled();
      expect(mocks.toastError).toHaveBeenCalledWith(
        "SMS credit checkout is release-held.",
        expect.objectContaining({
          description: expect.stringContaining(
            "sms_financial_ledger_release_held",
          ),
        }),
      );
      expect(mocks.toastError).toHaveBeenCalledWith(
        "MMS readiness certification is release-held.",
        expect.objectContaining({
          description: expect.stringContaining(
            "sms_mms_readiness_release_held",
          ),
        }),
      );
    } finally {
      act(() => root.unmount());
    }
  });

  it("saves campaign drafts through the API and resets editable fields", async () => {
    const refresh = vi.fn(async () => undefined);
    mocks.createSmsCampaign.mockResolvedValue(campaign());
    const root = render(createElement(Harness, { refresh }));

    try {
      await act(async () => {
        await latest?.saveCampaign({
          preventDefault: vi.fn(),
        } as unknown as FormEvent);
      });

      expect(mocks.createSmsCampaign).toHaveBeenCalledWith({
        sender_profile_id: "sender_1",
        list_id: "list_1",
        name: "Launch sale",
        body: "Save today",
        media_url: undefined,
        status: "draft",
        scheduled_at: undefined,
        metadata: { link_tracking: true },
      });
      expect(mocks.toastSuccess).toHaveBeenCalledWith(
        "SMS campaign draft saved",
        expect.objectContaining({ description: "1 segment" }),
      );
      expect(refresh).toHaveBeenCalledTimes(1);
      expect(latestDraft).toEqual(
        expect.objectContaining({
          name: "",
          body: "",
          media_url: "",
          cost_cap_dollars: "",
          discount_code: "",
        }),
      );
    } finally {
      act(() => root.unmount());
    }
  });

  it("clears saved A/B content before starting another campaign", async () => {
    mocks.createSmsCampaign.mockResolvedValue(campaign());
    const root = render(
      createElement(Harness, {
        initialDraft: draft({
          ab_enabled: true,
          ab_variants: [
            { label: "A", body: "Old audience offer", weight: "50" },
            { label: "B", body: "Old audience reminder", weight: "50" },
          ],
        }),
      }),
    );
    try {
      await act(async () => {
        await latest?.saveCampaign({
          preventDefault: vi.fn(),
        } as unknown as FormEvent);
      });
      expect(
        mocks.createSmsCampaign.mock.calls.at(-1)?.[0].metadata.ab_variants,
      ).toHaveLength(2);
      expect(latestDraft?.ab_enabled).toBe(false);
      expect(
        latestDraft?.ab_variants.every((variant) => variant.body === ""),
      ).toBe(true);
    } finally {
      act(() => root.unmount());
    }
  });

  it("does not carry another campaign's variants into a non-A/B draft", () => {
    const root = render(
      createElement(Harness, {
        initialDraft: draft({
          ab_enabled: true,
          ab_variants: [
            { label: "A", body: "Other campaign A", weight: "50" },
            { label: "B", body: "Other campaign B", weight: "50" },
          ],
        }),
      }),
    );
    try {
      act(() => {
        latest?.editCampaign(campaign({ metadata: { link_tracking: true } }));
      });
      expect(latestDraft?.ab_enabled).toBe(false);
      expect(
        latestDraft?.ab_variants.every((variant) => variant.body === ""),
      ).toBe(true);
      expect(latestDraft?.body).toBe("Save today");
    } finally {
      act(() => root.unmount());
    }
  });

  it("applies templates and discount codes into the campaign draft", async () => {
    const root = render(
      createElement(Harness, {
        initialDraft: draft({ name: "", body: "", discount_code: "" }),
      }),
    );

    try {
      act(() => {
        latest?.applySmsTemplate(template);
      });
      await flush();
      expect(latestDraft).toEqual(
        expect.objectContaining({
          name: "Weekend sale",
          body: "Use VIP20 for your favorite item by Friday",
        }),
      );

      act(() => {
        latest?.insertDiscountCode("SAVE30");
      });
      await flush();
      expect(latestDraft?.discount_code).toBe("SAVE30");
      expect(latestDraft?.body).toContain("Use code SAVE30 at checkout.");
    } finally {
      act(() => root.unmount());
    }
  });

  it("validates scheduling and refreshes open reports after lifecycle changes", async () => {
    const refresh = vi.fn(async () => undefined);
    const item = campaign({ id: "cmp_sched", status: "draft" });
    const nextReport = report(item);
    mocks.scheduleSmsCampaign.mockResolvedValue({ ok: true });
    mocks.getSmsCampaignReport.mockResolvedValue(nextReport);
    const root = render(
      createElement(Harness, {
        initialDraft: draft({ scheduled_at: "2999-01-01T09:30" }),
        initialReports: { [item.id]: report(item) },
        refresh,
      }),
    );

    try {
      await act(async () => {
        latest?.scheduleCampaignFromDraft(item);
        await flush();
      });

      expect(mocks.scheduleSmsCampaign).toHaveBeenCalledWith(
        item.id,
        expect.stringMatching(/^2999-01-01T/),
      );
      expect(refresh).toHaveBeenCalledTimes(1);
      expect(mocks.getSmsCampaignReport).toHaveBeenCalledWith(item.id);
      expect(latestReports[item.id]).toBe(nextReport);
    } finally {
      act(() => root.unmount());
    }
  });
});
