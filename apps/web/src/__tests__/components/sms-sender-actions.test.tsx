// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
import { act, createElement, type FormEvent, useState } from "react";
import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  SmsBrandRegistrationDraft,
  SmsCampaignRegistrationDraft,
  SmsSenderDraft,
} from "@/app/(dashboard)/app/sms/sms-registration-drafts";
import { useSmsSenderActions } from "@/app/(dashboard)/app/sms/use-sms-sender-actions";
import type { SmsSenderProfile, SmsSetupStatus } from "@/lib/sms-api";

(
  globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  }
).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  pauseSmsSender: vi.fn(),
  pollSmsA2PRegistration: vi.fn(),
  resumeSmsSender: vi.fn(),
  submitSmsBrandRegistration: vi.fn(),
  submitSmsCampaignRegistration: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  upsertSmsSender: vi.fn(),
}));

vi.mock("@/lib/sms-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/sms-api")>();
  return {
    ...actual,
    pauseSmsSender: mocks.pauseSmsSender,
    pollSmsA2PRegistration: mocks.pollSmsA2PRegistration,
    resumeSmsSender: mocks.resumeSmsSender,
    submitSmsBrandRegistration: mocks.submitSmsBrandRegistration,
    submitSmsCampaignRegistration: mocks.submitSmsCampaignRegistration,
    upsertSmsSender: mocks.upsertSmsSender,
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

const activeSender: SmsSenderProfile = {
  id: "sender_1",
  provider: "twilio",
  country: "US",
  sender_type: "10dlc",
  phone_number: "+14155550100",
  messaging_service_sid: "MG_ACTIVE",
  brand_registration_sid: "BN_ACTIVE",
  campaign_registration_sid: "QE_ACTIVE",
  registration_status: "approved",
  metadata: {
    retained: "yes",
    quiet_hours: {
      timezone: "America/New_York",
      start: "20:00",
      end: "08:00",
    },
  },
  created_at: "2026-06-28T00:00:00.000Z",
  updated_at: "2026-06-28T00:00:00.000Z",
};

const setup: SmsSetupStatus = {
  senders: [activeSender],
  can_send: true,
  blocking_reasons: [],
};

function senderDraft(overrides: Partial<SmsSenderDraft> = {}): SmsSenderDraft {
  return {
    provider: "twilio",
    country: "US",
    sender_type: "10dlc",
    phone_number: "+14155550123",
    messaging_service_sid: "MG_DRAFT",
    brand_registration_sid: "",
    campaign_registration_sid: "",
    registration_status: "draft",
    quiet_hours_enabled: true,
    quiet_hours_timezone: "America/Chicago",
    quiet_hours_start: "21:00",
    quiet_hours_end: "07:00",
    ...overrides,
  };
}

function brandDraft(
  overrides: Partial<SmsBrandRegistrationDraft> = {},
): SmsBrandRegistrationDraft {
  return {
    customer_profile_bundle_sid: "BU_CUSTOMER",
    a2p_profile_bundle_sid: "BU_A2P",
    brand_type: "STANDARD",
    skip_automatic_sec_vet: false,
    entity_type: "PRIVATE_PROFIT",
    display_name: "Moosewave",
    company_name: "Moosewave Inc.",
    ein: "12-3456789",
    phone: "+14155550100",
    street: "1 Market St",
    city: "San Francisco",
    state: "CA",
    postal_code: "94105",
    country: "US",
    email: "ops@example.com",
    website: "https://example.com",
    vertical: "RETAIL",
    business_contact_email: "compliance@example.com",
    ...overrides,
  };
}

function campaignRegistrationDraft(
  overrides: Partial<SmsCampaignRegistrationDraft> = {},
): SmsCampaignRegistrationDraft {
  return {
    usecase: "MARKETING",
    vertical: "RETAIL",
    description: "Promotional SMS for opted-in customers.",
    message_flow: "Customers opt in at checkout.",
    message_samples: "Sale starts today\n\n  Reply STOP to opt out  ",
    subscriber_opt_in: true,
    has_embedded_links: true,
    has_embedded_phone: false,
    number_pool: false,
    affiliate_marketing: false,
    auto_renewal: true,
    terms_and_conditions_link: "https://example.com/terms",
    privacy_policy_link: "https://example.com/privacy",
    ...overrides,
  };
}

let latest: ReturnType<typeof useSmsSenderActions> | null = null;

function Harness({
  active = activeSender,
  brandRegistration = brandDraft(),
  campaignRegistration = campaignRegistrationDraft(),
  refresh = vi.fn(async () => undefined),
  sender = senderDraft(),
  setupValue = setup,
}: {
  active?: SmsSenderProfile | null;
  brandRegistration?: SmsBrandRegistrationDraft;
  campaignRegistration?: SmsCampaignRegistrationDraft;
  refresh?: () => Promise<void>;
  sender?: SmsSenderDraft;
  setupValue?: SmsSetupStatus | null;
}) {
  const [, setPending] = useState<string | null>(null);
  const [, setCampaignRegistration] = useState(campaignRegistration);
  latest = useSmsSenderActions({
    activeSender: active ?? undefined,
    brandRegistration,
    campaignRegistration,
    refresh,
    sender,
    setCampaignRegistration,
    setPending,
    setup: setupValue,
  });
  return null;
}

describe("useSmsSenderActions", () => {
  it("saves sender profile metadata and refreshes SMS data", async () => {
    const refresh = vi.fn(async () => undefined);
    mocks.upsertSmsSender.mockResolvedValue(activeSender);
    const root = render(createElement(Harness, { refresh }));

    try {
      await act(async () => {
        await latest?.saveSender({
          preventDefault: vi.fn(),
        } as unknown as FormEvent<HTMLFormElement>);
      });

      expect(mocks.upsertSmsSender).toHaveBeenCalledWith({
        provider: "twilio",
        country: "US",
        sender_type: "10dlc",
        phone_number: "+14155550123",
        messaging_service_sid: "MG_DRAFT",
        registration_status: "draft",
        metadata: {
          retained: "yes",
          quiet_hours: {
            timezone: "America/Chicago",
            start: "21:00",
            end: "07:00",
          },
        },
      });
      expect(mocks.toastSuccess).toHaveBeenCalledWith("SMS sender saved");
      expect(refresh).toHaveBeenCalledOnce();
    } finally {
      act(() => root.unmount());
    }
  });

  it("does not submit caller-supplied carrier evidence or authoritative status", async () => {
    const refresh = vi.fn(async () => undefined);
    const root = render(
      createElement(Harness, {
        refresh,
        sender: senderDraft({
          brand_registration_sid: "BN_PRIVATE",
          campaign_registration_sid: "QE_PRIVATE",
          registration_status: "approved",
        }),
      }),
    );

    try {
      await act(async () => {
        await latest?.saveSender({
          preventDefault: vi.fn(),
        } as unknown as FormEvent<HTMLFormElement>);
      });
      expect(mocks.upsertSmsSender).not.toHaveBeenCalled();
      expect(refresh).not.toHaveBeenCalled();
      expect(mocks.toastError).toHaveBeenCalledWith(
        "Carrier registration evidence is read-only",
        {
          description:
            "sms_registration_evidence_authority_required: nothing was saved.",
        },
      );
    } finally {
      act(() => root.unmount());
    }
  });

  it("holds A2P actions even when an SMS sender exists", async () => {
    const refresh = vi.fn(async () => undefined);
    const root = render(
      createElement(Harness, {
        refresh,
      }),
    );

    try {
      await act(async () => {
        await latest?.submitBrand();
        await latest?.submitCampaignRegistration();
        await latest?.pollRegistration();
      });

      expect(mocks.toastError).toHaveBeenCalledTimes(3);
      for (const call of mocks.toastError.mock.calls) {
        expect(call).toEqual([
          "A2P registration automation is release-held",
          {
            description:
              "sms_a2p_registration_release_held: nothing was submitted.",
          },
        ]);
      }
      expect(mocks.submitSmsBrandRegistration).not.toHaveBeenCalled();
      expect(mocks.submitSmsCampaignRegistration).not.toHaveBeenCalled();
      expect(mocks.pollSmsA2PRegistration).not.toHaveBeenCalled();
      expect(refresh).not.toHaveBeenCalled();
    } finally {
      act(() => root.unmount());
    }
  });

  it("pauses and resumes sender delivery through the kill switch", async () => {
    const refresh = vi.fn(async () => undefined);
    mocks.pauseSmsSender.mockResolvedValue(activeSender);
    mocks.resumeSmsSender.mockResolvedValue(activeSender);
    const root = render(createElement(Harness, { refresh }));

    try {
      await act(async () => {
        await latest?.setSenderKillSwitch(activeSender, true);
      });
      expect(mocks.pauseSmsSender).toHaveBeenCalledWith(
        "sender_1",
        "Paused from SMS operations dashboard before or during pilot.",
      );
      expect(mocks.toastSuccess).toHaveBeenCalledWith("Sender paused");

      await act(async () => {
        await latest?.setSenderKillSwitch(activeSender, false);
      });
      expect(mocks.resumeSmsSender).toHaveBeenCalledWith("sender_1");
      expect(mocks.toastSuccess).toHaveBeenCalledWith("Sender resumed");
      expect(refresh).toHaveBeenCalledTimes(2);
    } finally {
      act(() => root.unmount());
    }
  });
});
