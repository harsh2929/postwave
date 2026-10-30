// SPDX-License-Identifier: AGPL-3.0-only

import type { SmsSenderProfile } from "@/lib/sms-api";

export interface SmsSenderDraft {
  provider: SmsSenderProfile["provider"];
  country: SmsSenderProfile["country"];
  sender_type: SmsSenderProfile["sender_type"];
  phone_number: string;
  messaging_service_sid: string;
  brand_registration_sid: string;
  campaign_registration_sid: string;
  registration_status: string;
  quiet_hours_enabled: boolean;
  quiet_hours_timezone: string;
  quiet_hours_start: string;
  quiet_hours_end: string;
}

export const PRISTINE_SENDER_DRAFT: SmsSenderDraft = {
  provider: "twilio",
  country: "US",
  sender_type: "10dlc",
  phone_number: "",
  messaging_service_sid: "",
  brand_registration_sid: "",
  campaign_registration_sid: "",
  registration_status: "not_started",
  quiet_hours_enabled: false,
  quiet_hours_timezone: "America/New_York",
  quiet_hours_start: "20:00",
  quiet_hours_end: "08:00",
};

export function senderRegistrationEvidenceLocked(
  sender: SmsSenderDraft,
): boolean {
  const status = sender.registration_status.trim().toLowerCase();
  return Boolean(
    sender.brand_registration_sid.trim() ||
    sender.campaign_registration_sid.trim() ||
    (status !== "" && status !== "not_started" && status !== "draft"),
  );
}

export interface SmsBrandRegistrationDraft {
  customer_profile_bundle_sid: string;
  a2p_profile_bundle_sid: string;
  brand_type: string;
  skip_automatic_sec_vet: boolean;
  entity_type: string;
  display_name: string;
  company_name: string;
  ein: string;
  phone: string;
  street: string;
  city: string;
  state: string;
  postal_code: string;
  country: string;
  email: string;
  website: string;
  vertical: string;
  business_contact_email: string;
}

export interface SmsCampaignRegistrationDraft {
  usecase: string;
  vertical: string;
  description: string;
  message_flow: string;
  message_samples: string;
  subscriber_opt_in: boolean;
  has_embedded_links: boolean;
  has_embedded_phone: boolean;
  number_pool: boolean;
  affiliate_marketing: boolean;
  auto_renewal: boolean;
  terms_and_conditions_link: string;
  privacy_policy_link: string;
}
