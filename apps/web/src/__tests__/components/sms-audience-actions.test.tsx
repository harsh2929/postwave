// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
import { act, createElement, type FormEvent, useState } from "react";
import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { SmsCampaignDraft } from "@/app/(dashboard)/app/sms/sms-campaign-drafts-card";
import type { SmsConsentDraft } from "@/app/(dashboard)/app/sms/sms-consent-card";
import type { SmsListDraft } from "@/app/(dashboard)/app/sms/sms-lists-card";
import type { SmsTestSendDraft } from "@/app/(dashboard)/app/sms/sms-test-send-card";
import { useSmsAudienceActions } from "@/app/(dashboard)/app/sms/use-sms-audience-actions";
import { ApiError } from "@/lib/api";
import type { SmsList } from "@/lib/sms-api";

(
  globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  }
).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  createSmsList: vi.fn(),
  recordSmsConsent: vi.fn(),
  sendSmsTest: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("@/lib/sms-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/sms-api")>();
  return {
    ...actual,
    createSmsList: mocks.createSmsList,
    recordSmsConsent: mocks.recordSmsConsent,
    sendSmsTest: mocks.sendSmsTest,
  };
});

vi.mock("sonner", () => ({
  toast: {
    error: mocks.toastError,
    success: mocks.toastSuccess,
  },
}));

afterEach(() => {
  latest = null;
  latestCampaignDraft = null;
  latestConsent = null;
  latestListDraft = null;
  latestTestSend = null;
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

function formEvent(): FormEvent<HTMLFormElement> {
  return {
    preventDefault: vi.fn(),
  } as unknown as FormEvent<HTMLFormElement>;
}

function list(overrides: Partial<SmsList> = {}): SmsList {
  return {
    id: "list_2",
    name: "VIP shoppers",
    description: "Opted-in VIP audience",
    keyword: "VIP",
    created_at: "2026-06-28T00:00:00.000Z",
    updated_at: "2026-06-28T00:00:00.000Z",
    ...overrides,
  };
}

function listDraft(overrides: Partial<SmsListDraft> = {}): SmsListDraft {
  return {
    name: "VIP shoppers",
    description: "Opted-in VIP audience",
    keyword: "VIP",
    ...overrides,
  };
}

function consentDraft(
  overrides: Partial<SmsConsentDraft> = {},
): SmsConsentDraft {
  return {
    list_id: "33333333-3333-4333-8333-333333333333",
    phone_e164: "+14155550123",
    proof_text: "Operator requested a manual safety opt-out",
    action: "revoked",
    source: "manual",
    ...overrides,
  };
}

function campaignDraft(
  overrides: Partial<SmsCampaignDraft> = {},
): SmsCampaignDraft {
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

function testSendDraft(
  overrides: Partial<SmsTestSendDraft> = {},
): SmsTestSendDraft {
  return {
    sender_profile_id: "sender_1",
    list_id: "list_1",
    to: "+14155550123",
    body: "Test message",
    media_url: "",
    ...overrides,
  };
}

let latest: ReturnType<typeof useSmsAudienceActions> | null = null;
let latestCampaignDraft: SmsCampaignDraft | null = null;
let latestConsent: SmsConsentDraft | null = null;
let latestListDraft: SmsListDraft | null = null;
let latestTestSend: SmsTestSendDraft | null = null;

function Harness({
  initialCampaignDraft = campaignDraft(),
  initialConsent = consentDraft(),
  initialListDraft = listDraft(),
  initialTestSend = testSendDraft(),
  refresh = vi.fn(async () => undefined),
}: {
  initialCampaignDraft?: SmsCampaignDraft;
  initialConsent?: SmsConsentDraft;
  initialListDraft?: SmsListDraft;
  initialTestSend?: SmsTestSendDraft;
  refresh?: () => Promise<void>;
}) {
  const [campaignDraftValue, setCampaignDraft] = useState(initialCampaignDraft);
  const [consent, setConsent] = useState(initialConsent);
  const [listDraftValue, setListDraft] = useState(initialListDraft);
  const [, setPending] = useState<string | null>(null);
  const [testSend, setTestSend] = useState(initialTestSend);
  latestCampaignDraft = campaignDraftValue;
  latestConsent = consent;
  latestListDraft = listDraftValue;
  latestTestSend = testSend;
  latest = useSmsAudienceActions({
    consent,
    tenantId: "11111111-1111-4111-8111-111111111111",
    listDraft: listDraftValue,
    refresh,
    setCampaignDraft,
    setConsent,
    setListDraft,
    setPending,
    setTestSend,
    testSend,
  });
  return null;
}

describe("useSmsAudienceActions", () => {
  it("creates SMS lists and seeds dependent drafts", async () => {
    const refresh = vi.fn(async () => undefined);
    mocks.createSmsList.mockResolvedValue(list({ id: "list_new" }));
    const root = render(createElement(Harness, { refresh }));

    try {
      await act(async () => {
        await latest?.createList(formEvent());
      });

      expect(mocks.createSmsList).toHaveBeenCalledWith({
        name: "VIP shoppers",
        description: "Opted-in VIP audience",
        keyword: "VIP",
      });
      expect(mocks.toastSuccess).toHaveBeenCalledWith("SMS list saved");
      expect(latestListDraft).toEqual({
        name: "",
        description: "",
        keyword: "",
      });
      expect(latestConsent?.list_id).toBe("list_new");
      expect(latestTestSend?.list_id).toBe("list_new");
      expect(latestCampaignDraft?.list_id).toBe("list_new");
      expect(refresh).toHaveBeenCalledOnce();
    } finally {
      act(() => root.unmount());
    }
  });

  it("validates consent phone numbers before recording an opt-out", async () => {
    const root = render(
      createElement(Harness, {
        initialConsent: consentDraft({ phone_e164: "4155550123" }),
      }),
    );

    try {
      await act(async () => {
        await latest?.recordOptOut(formEvent());
      });

      expect(mocks.toastError).toHaveBeenCalledWith(
        "Enter a valid phone number in E.164 format, e.g. +14155551212",
      );
      expect(mocks.recordSmsConsent).not.toHaveBeenCalled();
    } finally {
      act(() => root.unmount());
    }
  });

  it("records only a manual revocation and never seeds a send target", async () => {
    mocks.recordSmsConsent.mockResolvedValue({ ok: true });
    const root = render(createElement(Harness));

    try {
      await act(async () => {
        await latest?.recordOptOut(formEvent());
      });

      expect(mocks.recordSmsConsent).toHaveBeenCalledWith(
        {
          list_id: "33333333-3333-4333-8333-333333333333",
          phone_e164: "+14155550123",
          action: "revoked",
          source: "manual",
          proof_text: "Operator requested a manual safety opt-out",
        },
        "11111111-1111-4111-8111-111111111111",
      );
      expect(mocks.toastSuccess).toHaveBeenCalledWith("SMS opt-out recorded", {
        description: "+14155550123",
      });
      expect(latestTestSend).toEqual(testSendDraft());
    } finally {
      act(() => root.unmount());
    }
  });

  it("holds an injected grant before any consent or proof-asset request", async () => {
    const unsafe = {
      ...consentDraft(),
      action: "granted",
      evidence_file: new File(["proof"], "proof.png", { type: "image/png" }),
    } as unknown as SmsConsentDraft;
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const root = render(
      createElement(Harness, {
        initialConsent: unsafe,
      }),
    );

    try {
      await act(async () => {
        await latest?.recordOptOut(formEvent());
      });
      expect(mocks.recordSmsConsent).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(mocks.toastError).toHaveBeenCalledWith(
        "Only manual SMS opt-out recording is available; no request was sent",
      );
    } finally {
      act(() => root.unmount());
    }
  });

  it("validates and submits test sends with segment feedback", async () => {
    mocks.sendSmsTest.mockResolvedValue({
      gate: { allowed: true, segments: 2 },
      message: {
        id: "msg_1",
        phone_e164: "+14155550123",
        provider: "twilio",
        direction: "outbound",
        body: "Test message",
        segments: 2,
        status: "queued",
        cost_micros: 2500,
        created_at: "2026-06-28T00:00:00.000Z",
      },
    });
    const root = render(createElement(Harness));

    try {
      await act(async () => {
        await latest?.sendTest(formEvent());
      });

      expect(mocks.sendSmsTest).toHaveBeenCalledWith({
        sender_profile_id: "sender_1",
        list_id: "list_1",
        to: "+14155550123",
        body: "Test message",
        media_url: "",
      });
      expect(mocks.toastSuccess).toHaveBeenCalledWith("SMS accepted", {
        description: "queued · 2 segments",
      });
    } finally {
      act(() => root.unmount());
    }
  });

  it("shows the SMS gate reason when a test send is blocked", async () => {
    mocks.sendSmsTest.mockRejectedValue(
      new ApiError("POST failed", 409, {
        gate: {
          allowed: false,
          reason: "Recipient has not granted SMS consent",
          segments: 1,
        },
      }),
    );
    const root = render(createElement(Harness));

    try {
      await act(async () => {
        await latest?.sendTest(formEvent());
      });

      expect(mocks.toastError).toHaveBeenCalledWith("SMS was not sent", {
        description: "Recipient has not granted SMS consent",
      });
    } finally {
      act(() => root.unmount());
    }
  });
});
