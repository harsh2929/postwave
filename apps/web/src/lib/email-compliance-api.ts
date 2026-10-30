// SPDX-License-Identifier: AGPL-3.0-only
//
// Sender identity compliance-profile client.

import { api } from "./api";

export interface EmailComplianceProfile {
  tenant_id: string;
  legal_sender_name: string;
  physical_address_line1: string;
  physical_address_line2: string;
  physical_address_city: string;
  physical_address_region: string;
  physical_address_postal_code: string;
  physical_address_country: string;
  compliance_contact_email?: string;
  default_footer_text: string;
  list_unsubscribe_enabled: boolean;
  one_click_unsubscribe_enabled: boolean;
  verified_sender_domain: boolean;
  updated_by_user_id?: string | null;
  created_at?: string;
  updated_at?: string;
}

export type EmailComplianceProfileInput = Omit<
  EmailComplianceProfile,
  | "tenant_id"
  | "updated_by_user_id"
  | "created_at"
  | "updated_at"
  | "verified_sender_domain"
>;

export const emailComplianceApi = {
  get: () =>
    api.get<EmailComplianceProfile>("/api/v1/settings/email-compliance"),
  put: (profile: EmailComplianceProfileInput, signal?: AbortSignal) =>
    api.put<EmailComplianceProfile>(
      "/api/v1/settings/email-compliance",
      profile,
      { signal, requireOnline: true, maxAttempts: 1 },
    ),
};
