// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
import { act, createElement } from "react";
import type { Dispatch, ReactNode, SetStateAction } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  SmsSenderRegistrationCard,
  type SmsBrandRegistrationDraft,
  type SmsCampaignRegistrationDraft,
  type SmsSenderDraft,
} from "@/app/(dashboard)/app/sms/sms-sender-registration-card";

import { PRISTINE_SENDER_DRAFT } from "@/app/(dashboard)/app/sms/sms-registration-drafts";

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

function changeInput(
  input: HTMLInputElement | HTMLTextAreaElement,
  value: string,
): void {
  const valueSetter = Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(input) as typeof HTMLInputElement.prototype,
    "value",
  )?.set;
  valueSetter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

function checkboxByLabel(text: string): HTMLInputElement {
  const label = Array.from(document.querySelectorAll("label")).find(
    (element) => element.textContent?.includes(text) === true,
  );
  const checkbox = label?.querySelector<HTMLInputElement>(
    'input[type="checkbox"]',
  );
  if (!checkbox) throw new Error(`Checkbox not found: ${text}`);
  return checkbox;
}

function stateHarness<T>(initial: T): {
  current: () => T;
  setState: Dispatch<SetStateAction<T>>;
} {
  let current = initial;
  const setState = vi.fn((update: SetStateAction<T>) => {
    current =
      typeof update === "function"
        ? (update as (value: T) => T)(current)
        : update;
  });
  return { current: () => current, setState };
}

const senderDraft: SmsSenderDraft = { ...PRISTINE_SENDER_DRAFT };

const brandDraft: SmsBrandRegistrationDraft = {
  customer_profile_bundle_sid: "",
  a2p_profile_bundle_sid: "",
  brand_type: "STANDARD",
  skip_automatic_sec_vet: false,
  entity_type: "PRIVATE_PROFIT",
  display_name: "",
  company_name: "",
  ein: "",
  phone: "",
  street: "",
  city: "",
  state: "",
  postal_code: "",
  country: "US",
  email: "",
  website: "",
  vertical: "",
  business_contact_email: "",
};

const campaignDraft: SmsCampaignRegistrationDraft = {
  usecase: "MARKETING",
  vertical: "",
  description: "",
  message_flow: "",
  message_samples: "",
  subscriber_opt_in: true,
  has_embedded_links: true,
  has_embedded_phone: false,
  number_pool: false,
  affiliate_marketing: false,
  auto_renewal: true,
  terms_and_conditions_link: "",
  privacy_policy_link: "",
};

function renderCard(
  overrides: Partial<{
    pending: string | null;
    registrationProvider: SmsSenderDraft["provider"];
  }> = {},
): {
  brand: ReturnType<typeof stateHarness<SmsBrandRegistrationDraft>>;
  callbacks: {
    onPollRegistration: ReturnType<typeof vi.fn>;
    onSubmitBrand: ReturnType<typeof vi.fn>;
    onSubmitCampaignRegistration: ReturnType<typeof vi.fn>;
    onSubmitSender: ReturnType<typeof vi.fn>;
  };
  campaign: ReturnType<typeof stateHarness<SmsCampaignRegistrationDraft>>;
  root: Root;
  sender: ReturnType<typeof stateHarness<SmsSenderDraft>>;
} {
  const sender = stateHarness(senderDraft);
  const brand = stateHarness(brandDraft);
  const campaign = stateHarness(campaignDraft);
  const callbacks = {
    onGenerateA2PField: vi.fn(),
    onPollRegistration: vi.fn(),
    onSelectSender: vi.fn(),
    onSubmitBrand: vi.fn(),
    onSubmitCampaignRegistration: vi.fn(),
    onSubmitSender: vi.fn((event: React.FormEvent<HTMLFormElement>) =>
      event.preventDefault(),
    ),
  };
  const root = render(
    createElement(SmsSenderRegistrationCard, {
      brandRegistration: brand.current(),
      campaignRegistration: campaign.current(),
      pending: null,
      registrationProvider: "twilio",
      sender: sender.current(),
      senders: [],
      selectedSenderId: "",
      setBrandRegistration: brand.setState,
      setCampaignRegistration: campaign.setState,
      setSender: sender.setState,
      ...callbacks,
      ...overrides,
    }),
  );
  return { brand, callbacks, campaign, root, sender };
}

describe("SmsSenderRegistrationCard", () => {
  it("allows the first sender draft without granting carrier approval", () => {
    const { root } = renderCard();
    try {
      const save = Array.from(document.querySelectorAll("button")).find(
        (button) => button.textContent?.includes("Save sender"),
      );
      expect(save?.disabled).toBe(false);
      const status = document.querySelector<HTMLSelectElement>(
        "#registration_status",
      );
      expect(status?.value).toBe("not_started");
      expect(
        Array.from(status?.options ?? []).map((option) => option.value),
      ).toEqual(["not_started", "draft"]);
      expect(document.body.textContent).not.toContain(
        "Stored carrier evidence is read-only",
      );
    } finally {
      act(() => root.unmount());
    }
  });

  it("keeps sender editing but structurally removes A2P effects", () => {
    const { callbacks, root, sender } = renderCard();

    try {
      act(() => {
        changeInput(
          document.querySelector("#phone_number") as HTMLInputElement,
          "+14155551212",
        );
      });
      expect(sender.current().phone_number).toBe("+14155551212");

      act(() => {
        checkboxByLabel("Enforce quiet hours").click();
      });
      expect(sender.current().quiet_hours_enabled).toBe(true);

      expect(document.body.textContent).toContain(
        "A2P registration automation is release-held",
      );
      expect(document.body.textContent).toContain(
        "sms_a2p_registration_release_held",
      );
      // Desktop SmsA2PRegistrationCard's hold sentence, verbatim.
      expect(document.body.textContent).toContain(
        "A2P carrier registration is unavailable until durable idempotency, reconciliation, and minimized provider receipts are deployed.",
      );
      expect(document.body.textContent).toContain(
        "No sender read, brand submission, campaign submission, or provider status polling request is started",
      );
      expect(document.querySelector("#customer_profile_bundle_sid")).toBeNull();
      expect(document.querySelector("#a2p_description")).toBeNull();
      expect(document.body.textContent).not.toContain("Submit Brand");
      expect(document.body.textContent).not.toContain("Submit Campaign");
      expect(document.body.textContent).not.toContain("Poll Status");
      expect(callbacks.onSubmitBrand).not.toHaveBeenCalled();
      expect(callbacks.onSubmitCampaignRegistration).not.toHaveBeenCalled();
      expect(callbacks.onPollRegistration).not.toHaveBeenCalled();

      act(() => {
        document
          .querySelector("form")
          ?.dispatchEvent(
            new Event("submit", { bubbles: true, cancelable: true }),
          );
      });
      expect(callbacks.onSubmitSender).toHaveBeenCalledOnce();
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it("does not render provider-specific submission fields while held", () => {
    const { callbacks, root } = renderCard({
      pending: "brand-registration",
      registrationProvider: "telnyx",
    });

    try {
      expect(document.querySelector("#customer_profile_bundle_sid")).toBeNull();
      expect(document.querySelector("#carrier_company_name")).toBeNull();
      expect(callbacks.onSubmitBrand).not.toHaveBeenCalled();
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it("does not expose or submit historical carrier evidence", () => {
    const sender = stateHarness({
      ...senderDraft,
      brand_registration_sid: "BN_PRIVATE",
      campaign_registration_sid: "QE_PRIVATE",
      registration_status: "approved",
    });
    const callback = vi.fn((event: React.FormEvent<HTMLFormElement>) =>
      event.preventDefault(),
    );
    const root = render(
      createElement(SmsSenderRegistrationCard, {
        brandRegistration: brandDraft,
        campaignRegistration: campaignDraft,
        pending: null,
        registrationProvider: "twilio",
        sender: sender.current(),
        senders: [],
        selectedSenderId: "",
        setBrandRegistration: vi.fn(),
        setCampaignRegistration: vi.fn(),
        setSender: sender.setState,
        onGenerateA2PField: vi.fn(),
        onPollRegistration: vi.fn(),
        onSelectSender: vi.fn(),
        onSubmitBrand: vi.fn(),
        onSubmitCampaignRegistration: vi.fn(),
        onSubmitSender: callback,
      }),
    );

    try {
      expect(document.querySelector("#brand_registration_sid")).toBeNull();
      expect(document.querySelector("#campaign_registration_sid")).toBeNull();
      expect(document.body.textContent).not.toContain("BN_PRIVATE");
      expect(document.body.textContent).not.toContain("QE_PRIVATE");
      expect(document.body.textContent).toContain(
        "sms_registration_evidence_authority_required",
      );
      const save = Array.from(document.querySelectorAll("button")).find(
        (button) => button.textContent?.includes("Save sender"),
      );
      expect(save?.disabled).toBe(true);
      act(() => save?.click());
      expect(callback).not.toHaveBeenCalled();
    } finally {
      act(() => root.unmount());
    }
  });
});
