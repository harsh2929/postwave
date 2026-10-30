// SPDX-License-Identifier: AGPL-3.0-only

import type { MeResponse } from "@/lib/auth-api";
import {
  emailComplianceApi,
  type EmailComplianceProfile,
  type EmailComplianceProfileInput,
} from "@/lib/email-compliance-api";
import type { AuthRecord } from "@/lib/inbox-reality-types";
import {
  sendingControlsApi,
  type EmailSendingControl,
  type SendingReadiness,
} from "@/lib/sending-controls-api";
import {
  sendingSettingsApi,
  type SendingSettings,
} from "@/lib/sending-settings-api";

export const DEFAULT_PAUSE_REASON = "Pilot safety pause";

export type EmailComplianceProfileDraft = EmailComplianceProfileInput &
  Pick<EmailComplianceProfile, "verified_sender_domain">;

export const EMPTY_PROFILE: EmailComplianceProfileDraft = {
  legal_sender_name: "",
  physical_address_line1: "",
  physical_address_line2: "",
  physical_address_city: "",
  physical_address_region: "",
  physical_address_postal_code: "",
  physical_address_country: "US",
  compliance_contact_email: "",
  default_footer_text: "",
  list_unsubscribe_enabled: true,
  one_click_unsubscribe_enabled: true,
  verified_sender_domain: false,
};

/**
 * The sender page's own records. Authentication health is not among them: it
 * comes from the deliverability service, which answers slowest and which an
 * environment may not run, so the page reads it separately and it can never
 * hold back the compliance, limits and kill-switch cards.
 */
export interface SenderSettingsData {
  complianceProfile: EmailComplianceProfile;
  control: EmailSendingControl;
  readiness: SendingReadiness;
  sendingSettings: SendingSettings | null;
}

export function requireTenantSendingSettings(
  settings: SendingSettings,
  expectedTenantId: string,
): SendingSettings {
  if (!expectedTenantId || settings.tenant_id !== expectedTenantId) {
    throw new Error(
      "The sending-settings response did not match the active workspace.",
    );
  }
  return settings;
}

export async function loadSenderSettings(
  includeExactSendingSettings = false,
  expectedTenantId = "",
): Promise<SenderSettingsData> {
  const [complianceProfile, control, readiness, sendingSettings] =
    await Promise.all([
      emailComplianceApi.get(),
      sendingControlsApi.get(),
      sendingControlsApi.readiness(),
      includeExactSendingSettings
        ? sendingSettingsApi
            .get()
            .then((settings) =>
              requireTenantSendingSettings(settings, expectedTenantId),
            )
        : Promise.resolve(null),
    ]);
  return {
    complianceProfile,
    control,
    readiness,
    sendingSettings,
  };
}

export function profileInputFromCompliance(
  complianceProfile: EmailComplianceProfile,
  account: MeResponse | null,
): EmailComplianceProfileDraft {
  return {
    legal_sender_name:
      complianceProfile.legal_sender_name || account?.workspace_name || "",
    physical_address_line1: complianceProfile.physical_address_line1,
    physical_address_line2: complianceProfile.physical_address_line2,
    physical_address_city: complianceProfile.physical_address_city,
    physical_address_region: complianceProfile.physical_address_region,
    physical_address_postal_code:
      complianceProfile.physical_address_postal_code,
    physical_address_country:
      complianceProfile.physical_address_country || "US",
    compliance_contact_email:
      complianceProfile.compliance_contact_email || account?.email || "",
    default_footer_text: complianceProfile.default_footer_text,
    list_unsubscribe_enabled: complianceProfile.list_unsubscribe_enabled,
    one_click_unsubscribe_enabled:
      complianceProfile.one_click_unsubscribe_enabled,
    verified_sender_domain: complianceProfile.verified_sender_domain,
  };
}

export function isComplianceReady(
  profile: EmailComplianceProfileDraft,
): boolean {
  return (
    Object.keys(complianceFieldErrors(profile)).length === 0 &&
    profile.list_unsubscribe_enabled &&
    profile.one_click_unsubscribe_enabled &&
    profile.verified_sender_domain
  );
}

export function profilePayloadForSave(
  profile: EmailComplianceProfileDraft,
): EmailComplianceProfileInput {
  const { verified_sender_domain: serverOwned, ...payload } = profile;
  void serverOwned;
  return payload;
}

export function authRecordBadgeVariant(
  record: AuthRecord,
): "success" | "warning" | "destructive" {
  if (record.status === "ok") return "success";
  if (record.status === "warn") return "warning";
  return "destructive";
}

export function authRecordLabel(record: AuthRecord): string {
  if (record.status === "ok") return "Pass";
  if (record.status === "warn") return "Warn";
  return "Fail";
}

// ---------------------------------------------------------------------------
// SETC-027: compliance validation + required-field markers
// ---------------------------------------------------------------------------

/** ISO 3166-1 alpha-2 country code (two uppercase letters). */
export function isValidCountryCode(value: string): boolean {
  return /^[A-Za-z]{2}$/.test(value.trim());
}

/** Pragmatic email shape check for client-side inline validation. */
export function isValidEmail(value: string): boolean {
  const v = value.trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
}

export type ComplianceField =
  | "legal_sender_name"
  | "physical_address_line1"
  | "physical_address_city"
  | "physical_address_country"
  | "compliance_contact_email";

/**
 * Inline errors for the compliance fields that gate production sends, so the
 * user can see exactly which fields are missing/invalid instead of a generic
 * "profile incomplete" banner (SETC-027). Empty required fields are only
 * flagged once the user has touched them; format checks always apply.
 */
export function complianceFieldErrors(
  profile: EmailComplianceProfileDraft,
): Partial<Record<ComplianceField, string>> {
  const errors: Partial<Record<ComplianceField, string>> = {};
  if (!profile.legal_sender_name.trim()) {
    errors.legal_sender_name = "Required for production sends.";
  }
  if (!profile.physical_address_line1.trim()) {
    errors.physical_address_line1 = "Required for CAN-SPAM.";
  }
  if (!profile.physical_address_city.trim()) {
    errors.physical_address_city = "Required.";
  }
  const country = profile.physical_address_country.trim();
  if (!country) {
    errors.physical_address_country = "Required.";
  } else if (!isValidCountryCode(country)) {
    errors.physical_address_country = "Use a 2-letter ISO code (e.g. US).";
  }
  const email = (profile.compliance_contact_email ?? "").trim();
  if (!email) {
    errors.compliance_contact_email = "Required for production sends.";
  } else if (!isValidEmail(email)) {
    errors.compliance_contact_email = "Enter a valid email address.";
  }
  return errors;
}

// ---------------------------------------------------------------------------
// SETC-049: title-cased readiness severity labels
// ---------------------------------------------------------------------------

export function severityLabel(severity: string): string {
  switch (severity) {
    case "blocker":
      return "Required";
    case "warning":
      return "Recommended";
    default:
      return severity
        ? severity.charAt(0).toUpperCase() + severity.slice(1)
        : "";
  }
}

// ---------------------------------------------------------------------------
// SETC-005: make each readiness checklist item actionable
// ---------------------------------------------------------------------------

export type ReadinessHint =
  | { kind: "anchor"; target: string; label: string }
  | { kind: "link"; href: string; label: string }
  | { kind: "note"; text: string };

/**
 * Resolves a readiness item to a fix affordance: an in-page anchor to the
 * relevant editor, a link to another settings tab, or explanatory copy when
 * there's no self-serve fix. Matches on the item's key/label so it's resilient
 * to the exact backend key set.
 */
export function readinessItemHint(item: {
  key: string;
  label: string;
}): ReadinessHint {
  const hay = `${item.key} ${item.label}`.toLowerCase();
  if (
    hay.includes("quiet") ||
    hay.includes("cap") ||
    hay.includes("per hour") ||
    hay.includes("rate") ||
    hay.includes("hourly")
  ) {
    return { kind: "anchor", target: "sending-limits", label: "Configure" };
  }
  if (
    hay.includes("spf") ||
    hay.includes("dkim") ||
    hay.includes("dmarc") ||
    hay.includes("domain")
  ) {
    return { kind: "anchor", target: "auth-health", label: "Check auth" };
  }
  if (
    hay.includes("compliance") ||
    hay.includes("address") ||
    hay.includes("sender name") ||
    hay.includes("unsubscribe") ||
    hay.includes("legal")
  ) {
    return { kind: "anchor", target: "compliance-profile", label: "Complete" };
  }
  if (hay.includes("warmup")) {
    return {
      kind: "note",
      text: "Warms up automatically as you send — no action needed.",
    };
  }
  return {
    kind: "note",
    text: "Managed by the platform.",
  };
}
