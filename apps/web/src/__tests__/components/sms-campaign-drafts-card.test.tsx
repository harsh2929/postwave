// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
import { act, createElement } from "react";
import type { Dispatch, FormEvent, ReactNode, SetStateAction } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  SmsCampaignDraftsCard,
  type SmsCampaignDraft,
} from "@/app/(dashboard)/app/sms/sms-campaign-drafts-card";
import type {
  SmsCampaign,
  SmsCampaignReport,
  SmsCreditBalance,
  SmsList,
  SmsSenderProfile,
  SmsTemplate,
} from "@/lib/sms-api";

vi.mock("@/lib/sms-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/sms-api")>();
  return {
    ...actual,
    getSmsCreditUsageSeries: vi.fn().mockResolvedValue([]),
    listSmsCampaignVariants: vi.fn().mockResolvedValue([]),
  };
});

(
  globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  }
).IS_REACT_ACT_ENVIRONMENT = true;

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

function campaign(overrides: Partial<SmsCampaign>): SmsCampaign {
  return {
    id: "cmp_1",
    sender_profile_id: "sender_1",
    list_id: "list_1",
    name: "Launch sale",
    body: "Save 20% today",
    status: "draft",
    created_at: "2026-06-28T00:00:00.000Z",
    updated_at: "2026-06-28T00:00:00.000Z",
    ...overrides,
  };
}

function report(item: SmsCampaign): SmsCampaignReport {
  return {
    campaign: item,
    recipients: 120,
    queued: 120,
    sending: 0,
    sent: 118,
    blocked: 1,
    failed: 1,
    cancelled: 0,
    delivered: 110,
    undelivered: 2,
    clicks: 24,
    unique_clickers: 18,
    segments: 1,
    cost_micros: 420000,
    status_counts: { delivered: 110, failed: 1 },
  };
}

const draft: SmsCampaignDraft = {
  sender_profile_id: "sender_1",
  list_id: "list_1",
  name: "Launch sale",
  body: "Save 20% today",
  media_url: "",
  status: "draft",
  scheduled_at: "2026-06-29T09:30",
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
};

const senders: SmsSenderProfile[] = [
  {
    id: "sender_1",
    provider: "twilio",
    country: "US",
    sender_type: "10dlc",
    phone_number: "+14155550100",
    registration_status: "approved",
    created_at: "2026-06-28T00:00:00.000Z",
    updated_at: "2026-06-28T00:00:00.000Z",
  },
];

const lists: SmsList[] = [
  {
    id: "list_1",
    name: "VIP customers",
    description: "Consented customers",
    created_at: "2026-06-28T00:00:00.000Z",
    updated_at: "2026-06-28T00:00:00.000Z",
  },
];

const templates: SmsTemplate[] = [
  {
    id: "tpl_1",
    name: "Weekend sale",
    category: "promo",
    body: "This weekend only: {{discount_code}}",
    media_allowed: false,
    merge_fields: ["discount_code"],
    tags: ["promo"],
  },
];

const creditBalance: SmsCreditBalance = {
  plan: "growth",
  included_credits: 1000,
  purchased_credits: 500,
  used_credits: 250,
  available_credits: 1250,
  period_start: "2026-06-01T00:00:00.000Z",
  period_end: "2026-07-01T00:00:00.000Z",
  entitlements: {},
  ledger_mode: "test",
};

function setDraftHarness(initial: SmsCampaignDraft): {
  current: () => SmsCampaignDraft;
  setDraft: Dispatch<SetStateAction<SmsCampaignDraft>>;
} {
  let current = initial;
  const setDraft = vi.fn((update: SetStateAction<SmsCampaignDraft>) => {
    current = typeof update === "function" ? update(current) : update;
  });
  return { current: () => current, setDraft };
}

function buttonsByText(text: string): HTMLButtonElement[] {
  return Array.from(document.querySelectorAll("button")).filter(
    (element): element is HTMLButtonElement =>
      element instanceof HTMLButtonElement &&
      element.textContent?.includes(text) === true,
  );
}

function exactButton(
  text: string,
  scope: ParentNode = document,
): HTMLButtonElement {
  const match = Array.from(scope.querySelectorAll("button")).find(
    (element): element is HTMLButtonElement =>
      element instanceof HTMLButtonElement &&
      element.textContent?.trim() === text,
  );
  if (!match) throw new Error(`Button not found: ${text}`);
  return match;
}

async function escapeDialogAndExpectFocus(
  trigger: HTMLButtonElement,
): Promise<void> {
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
  expect(dialog).not.toBeNull();
  expect(dialog?.contains(document.activeElement)).toBe(true);
  expect(document.activeElement).not.toBe(trigger);

  await act(async () => {
    document.dispatchEvent(
      new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "Escape",
      }),
    );
    await Promise.resolve();
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => requestAnimationFrame(resolve));
  });

  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(document.activeElement).toBe(trigger);
}

function changeInput(input: HTMLInputElement, value: string): void {
  const valueSetter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )?.set;
  valueSetter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

function renderCard(
  overrides: Partial<Parameters<typeof SmsCampaignDraftsCard>[0]> = {},
): {
  root: Root;
  callbacks: {
    onApplyTemplate: ReturnType<typeof vi.fn>;
    onBroadcastCampaign: ReturnType<typeof vi.fn>;
    onCampaignLifecycle: ReturnType<typeof vi.fn>;
    onDraftWithAI: ReturnType<typeof vi.fn>;
    onDuplicateCampaign: ReturnType<typeof vi.fn>;
    onEditCampaign: ReturnType<typeof vi.fn>;
    onExportReport: ReturnType<typeof vi.fn>;
    onInsertDiscountCode: ReturnType<typeof vi.fn>;
    onLoadCampaignReport: ReturnType<typeof vi.fn>;
    onRecordMmsSmokePass: ReturnType<typeof vi.fn>;
    onSaveDraftAsTemplate: ReturnType<typeof vi.fn>;
    onScheduleCampaign: ReturnType<typeof vi.fn>;
    onStartTopUpCheckout: ReturnType<typeof vi.fn>;
    onSubmit: ReturnType<typeof vi.fn>;
  };
  draftState: ReturnType<typeof setDraftHarness>;
} {
  const draftState = setDraftHarness(draft);
  const callbacks = {
    onApplyTemplate: vi.fn(),
    onBroadcastCampaign: vi.fn(),
    onCampaignLifecycle: vi.fn(),
    onDraftWithAI: vi.fn(),
    onDuplicateCampaign: vi.fn(),
    onEditCampaign: vi.fn(),
    onExportReport: vi.fn(),
    onInsertDiscountCode: vi.fn(),
    onLoadCampaignReport: vi.fn(),
    onRecordMmsSmokePass: vi.fn(),
    onSaveDraftAsTemplate: vi.fn(),
    onScheduleCampaign: vi.fn(),
    onStartTopUpCheckout: vi.fn(),
    onSubmit: vi.fn((event: FormEvent<HTMLFormElement>) =>
      event.preventDefault(),
    ),
  };
  const root = render(
    createElement(SmsCampaignDraftsCard, {
      campaignCredits: 1,
      campaignSendDuration: "instant",
      campaignSegments: 1,
      campaigns: [],
      creditBalance,
      creditPreview: null,
      discountCodes: [],
      dispatchAvailable: true,
      reportExportAvailable: true,
      draft,
      lists,
      loading: false,
      mmsReadiness: null,
      pending: null,
      programRegions: [],
      reports: {},
      senders,
      setupCanSend: true,
      templates,
      quickReplies: [],
      topUpQuote: null,
      setDraft: draftState.setDraft,
      onApplyQuickReply: vi.fn(),
      onEditQuickReply: vi.fn(),
      onDeleteQuickReply: vi.fn(),
      onRetryFailed: vi.fn(),
      ...callbacks,
      ...overrides,
    }),
  );
  return { root, callbacks, draftState };
}

describe("SmsCampaignDraftsCard", () => {
  it("routes draft field changes and campaign actions through callbacks", () => {
    const draftCampaign = campaign({ id: "cmp_draft", status: "draft" });
    const sendingCampaign = campaign({ id: "cmp_sending", status: "sending" });
    const sentCampaign = campaign({ id: "cmp_sent", status: "sent" });
    const { root, callbacks, draftState } = renderCard({
      campaigns: [draftCampaign, sendingCampaign, sentCampaign],
    });

    try {
      act(() => {
        changeInput(
          document.querySelector("#campaign_name") as HTMLInputElement,
          "Weekend launch",
        );
      });
      expect(draftState.current().name).toBe("Weekend launch");

      act(() => {
        buttonsByText("Weekend sale")[0]?.click();
      });
      expect(callbacks.onApplyTemplate).toHaveBeenCalledWith(templates[0]);

      const saveAsTemplate = buttonsByText("Save as template");
      expect(saveAsTemplate).toHaveLength(1);
      expect(
        Array.from(document.querySelectorAll("button")).filter(
          (button) => button.textContent?.trim() === "Save draft",
        ),
      ).toHaveLength(1);
      act(() => {
        saveAsTemplate[0]?.click();
      });
      expect(callbacks.onSaveDraftAsTemplate).toHaveBeenCalledOnce();

      act(() => {
        buttonsByText("Report")[0]?.click();
      });
      expect(callbacks.onLoadCampaignReport).toHaveBeenCalledWith(
        draftCampaign,
      );

      // Queue is now gated behind a confirmation: the click opens a recap
      // dialog and does NOT send until confirmed (SMS-001).
      act(() => {
        buttonsByText("Queue")[0]?.click();
      });
      expect(callbacks.onBroadcastCampaign).not.toHaveBeenCalled();
      expect(document.body.textContent).toContain(
        "Send this SMS broadcast now?",
      );
      act(() => {
        buttonsByText("Send broadcast")[0]?.click();
      });
      expect(callbacks.onBroadcastCampaign).toHaveBeenCalledWith(draftCampaign);

      act(() => {
        buttonsByText("Schedule")[0]?.click();
      });
      expect(callbacks.onScheduleCampaign).toHaveBeenCalledWith(draftCampaign);

      act(() => {
        buttonsByText("Pause")[0]?.click();
      });
      expect(callbacks.onCampaignLifecycle).toHaveBeenCalledWith(
        sendingCampaign,
        "pause",
      );

      // Duplicate lives in the per-row overflow menu (SMS-032). Open the
      // draft campaign's menu and clone it into the composer.
      act(() => {
        (
          document.querySelector(
            '[aria-label="Actions for Launch sale"]',
          ) as HTMLButtonElement | null
        )?.click();
      });
      act(() => {
        buttonsByText("Duplicate")[0]?.click();
      });
      expect(callbacks.onDuplicateCampaign).toHaveBeenCalledWith(draftCampaign);
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it("renders campaign report metrics and respects paused senders", () => {
    const pausedSender: SmsSenderProfile = {
      ...senders[0],
      metadata: { sender_paused: true },
    };
    const draftCampaign = campaign({ id: "cmp_paused", status: "draft" });
    const { root, callbacks } = renderCard({
      campaigns: [draftCampaign],
      reports: { [draftCampaign.id]: report(draftCampaign) },
      senders: [pausedSender],
    });

    try {
      expect(document.body.textContent).toContain("sender paused");
      expect(document.body.textContent).toContain("Delivered");
      expect(document.body.textContent).toContain("Click rate");

      const queue = buttonsByText("Queue")[0];
      expect(queue?.disabled).toBe(true);

      act(() => {
        queue?.click();
      });
      expect(callbacks.onBroadcastCampaign).not.toHaveBeenCalled();
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it("returns focus to the exact Queue trigger when Escape closes broadcast confirmation", async () => {
    const first = campaign({ id: "cmp_first", name: "First campaign" });
    const second = campaign({ id: "cmp_second", name: "Second campaign" });
    const { root, callbacks } = renderCard({ campaigns: [first, second] });

    try {
      const queueButtons = Array.from(
        document.querySelectorAll<HTMLButtonElement>("button"),
      ).filter((button) => button.textContent?.trim() === "Queue");
      expect(queueButtons).toHaveLength(2);
      const trigger = queueButtons[1]!;
      trigger.focus();
      expect(document.activeElement).toBe(trigger);

      await act(async () => {
        trigger.click();
        await Promise.resolve();
      });
      expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
        '"Second campaign"',
      );

      await escapeDialogAndExpectFocus(trigger);
      expect(callbacks.onBroadcastCampaign).not.toHaveBeenCalled();
    } finally {
      act(() => root.unmount());
    }
  });

  it("returns focus to the originating ActionMenu trigger when Escape closes campaign cancellation", async () => {
    const first = campaign({ id: "cmp_first", name: "First campaign" });
    const second = campaign({ id: "cmp_second", name: "Second campaign" });
    const { root, callbacks } = renderCard({ campaigns: [first, second] });

    try {
      const trigger = document.querySelector<HTMLButtonElement>(
        '[aria-label="Actions for Second campaign"]',
      );
      expect(trigger).not.toBeNull();
      trigger!.focus();
      expect(document.activeElement).toBe(trigger);

      await act(async () => {
        trigger!.click();
        await Promise.resolve();
      });
      const cancelItem = exactButton(
        "Cancel campaign",
        document.querySelector('[role="menu"]')!,
      );
      expect(document.activeElement).not.toBe(trigger);

      await act(async () => {
        cancelItem.click();
        await Promise.resolve();
      });
      expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
        '"Second campaign"',
      );

      await escapeDialogAndExpectFocus(trigger!);
      expect(callbacks.onCampaignLifecycle).not.toHaveBeenCalledWith(
        second,
        "cancel",
      );
    } finally {
      act(() => root.unmount());
    }
  });

  it("structurally holds every dispatch path when readiness is unavailable", () => {
    const retryFailed = vi.fn();
    const draftCampaign = campaign({ id: "cmp_draft", status: "draft" });
    const pausedCampaign = campaign({ id: "cmp_paused", status: "paused" });
    const { root, callbacks } = renderCard({
      campaigns: [draftCampaign, pausedCampaign],
      dispatchAvailable: false,
      dispatchUnavailableReason: "Durable dispatch readiness is unavailable.",
      onRetryFailed: retryFailed,
      reports: { [draftCampaign.id]: report(draftCampaign) },
    });

    try {
      expect(document.body.textContent).toContain(
        "Durable dispatch readiness is unavailable.",
      );
      const queue = buttonsByText("Queue")[0];
      const schedule = buttonsByText("Schedule")[0];
      const resume = buttonsByText("Resume")[0];
      const retry = buttonsByText("Retry failed & undelivered")[0];
      expect(queue?.disabled).toBe(true);
      expect(schedule?.disabled).toBe(true);
      expect(resume?.disabled).toBe(true);
      expect(retry?.disabled).toBe(true);
      expect(
        (
          document.querySelector(
            '#campaign_status option[value="scheduled"]',
          ) as HTMLOptionElement
        ).disabled,
      ).toBe(true);

      act(() => {
        queue?.click();
        schedule?.click();
        resume?.click();
        retry?.click();
      });
      expect(callbacks.onBroadcastCampaign).not.toHaveBeenCalled();
      expect(callbacks.onScheduleCampaign).not.toHaveBeenCalled();
      expect(callbacks.onCampaignLifecycle).not.toHaveBeenCalledWith(
        pausedCampaign,
        "resume",
      );
      expect(retryFailed).not.toHaveBeenCalled();
      expect(document.body.textContent).not.toContain(
        "Send this SMS broadcast now?",
      );
    } finally {
      act(() => root.unmount());
    }
  });

  it("never renders purchasable credit or certified MMS actions from legacy values", () => {
    const { root, callbacks } = renderCard({
      creditBalance,
      creditPreview: {
        channel: "mms",
        country: "US",
        region_status: "active",
        mms: true,
        mms_supported: true,
        segments: 1,
        recipient_count: 1,
        per_recipient_credits: 3,
        total_credits: 3,
        credit_value_micros: 1_000,
        estimated_cost_micros: 3_000,
        estimated_duration_seconds: 1,
        send_duration_label: "instant",
        line_items: [],
      },
      mmsReadiness: {
        ready: true,
        live_smoke_required: true,
        warnings: [],
        supported_countries: ["US", "CA"],
        providers: [],
        senders: [],
      },
      topUpQuote: {
        credits: 1_000,
        unit_price_micros: 1_000,
        subtotal_micros: 1_000_000,
        bonus_credits: 0,
        total_credits: 1_000,
        checkout_mode: "legacy",
        entitlement_preview: creditBalance,
        line_items: [],
      },
    });

    try {
      expect(document.body.textContent).toContain(
        "sms_financial_ledger_release_held",
      );
      expect(document.body.textContent).toContain(
        "sms_mms_readiness_release_held",
      );
      expect(document.body.textContent).toContain(
        "not balance, price, reservation, dispatch, or delivery evidence",
      );
      expect(buttonsByText("Start credit checkout")).toHaveLength(0);
      expect(buttonsByText("Record passed MMS smoke")).toHaveLength(0);
      expect(callbacks.onStartTopUpCheckout).not.toHaveBeenCalled();
      expect(callbacks.onRecordMmsSmokePass).not.toHaveBeenCalled();
    } finally {
      act(() => root.unmount());
    }
  });

  it("hides recipient export actions and sends no export request while held", () => {
    const sentCampaign = campaign({ id: "cmp_sent", status: "sent" });
    const { root, callbacks } = renderCard({
      campaigns: [sentCampaign],
      reportExportAvailable: false,
      reportExportUnavailableReason:
        "The audited export contract is not available.",
    });

    try {
      expect(document.body.textContent).toContain(
        "The audited export contract is not available.",
      );
      const actions = document.querySelector<HTMLButtonElement>(
        '[aria-label="Actions for Launch sale"]',
      );
      expect(actions).not.toBeNull();
      act(() => actions?.click());
      expect(document.body.textContent).not.toContain("Export all recipients");
      expect(document.body.textContent).not.toContain("Export failures");
      const reportButton = buttonsByText("Report")[0];
      expect(reportButton?.disabled).toBe(true);
      act(() => reportButton?.click());
      expect(callbacks.onExportReport).not.toHaveBeenCalled();
      expect(callbacks.onLoadCampaignReport).not.toHaveBeenCalled();
    } finally {
      act(() => root.unmount());
    }
  });

  it("does not submit a scheduled draft through the release hold", () => {
    const scheduledDraft = { ...draft, status: "scheduled" };
    const { root, callbacks } = renderCard({
      dispatchAvailable: false,
      draft: scheduledDraft,
    });

    try {
      const form = document.querySelector("form") as HTMLFormElement;
      let accepted = true;
      act(() => {
        accepted = form.dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true }),
        );
      });
      expect(accepted).toBe(false);
      expect(callbacks.onSubmit).not.toHaveBeenCalled();
      expect(
        (form.querySelector('button[type="submit"]') as HTMLButtonElement)
          .disabled,
      ).toBe(true);
    } finally {
      act(() => root.unmount());
    }
  });
});
