// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from "vitest";

import {
  authRecordBadgeVariant,
  authRecordLabel,
  isComplianceReady,
  loadSenderSettings,
  profileInputFromCompliance,
  profilePayloadForSave,
  requireTenantSendingSettings,
} from "@/app/(dashboard)/app/settings/sender/sender-settings-helpers";
import type { MeResponse } from "@/lib/auth-api";
import { emailComplianceApi } from "@/lib/email-compliance-api";
import { getAuthChecks } from "@/lib/inbox-reality-api";
import { sendingControlsApi } from "@/lib/sending-controls-api";
import { sendingSettingsApi } from "@/lib/sending-settings-api";

vi.mock("@/lib/email-compliance-api", () => ({
  emailComplianceApi: {
    get: vi.fn(),
  },
}));

vi.mock("@/lib/inbox-reality-api", () => ({
  getAuthChecks: vi.fn(),
}));

vi.mock("@/lib/sending-controls-api", () => ({
  sendingControlsApi: {
    get: vi.fn(),
    readiness: vi.fn(),
  },
}));

vi.mock("@/lib/sending-settings-api", () => ({
  sendingSettingsApi: {
    get: vi.fn(),
  },
}));

const compliance = {
  compliance_contact_email: "",
  created_at: "",
  default_footer_text: "",
  legal_sender_name: "",
  list_unsubscribe_enabled: true,
  one_click_unsubscribe_enabled: true,
  physical_address_city: "SF",
  physical_address_country: "US",
  physical_address_line1: "1 Market",
  physical_address_line2: "",
  physical_address_postal_code: "94105",
  physical_address_region: "CA",
  tenant_id: "tenant-1",
  updated_at: "",
  verified_sender_domain: true,
};

const account = {
  auth_provider: "password",
  email: "owner@example.com",
  email_verified: true,
  role: "owner",
  tenant_id: "tenant-1",
  user_id: "user-1",
  workspace_name: "Moosewave",
  workspace_slug: "postwave",
} satisfies MeResponse;

describe("sender settings helpers", () => {
  it("maps compliance profiles into an editable draft with account fallbacks", () => {
    const draft = profileInputFromCompliance(compliance, account);

    expect(draft.legal_sender_name).toBe("Moosewave");
    expect(draft.compliance_contact_email).toBe("owner@example.com");
    expect(draft.verified_sender_domain).toBe(true);
  });

  it("strips server-owned verification from save payloads", () => {
    const draft = profileInputFromCompliance(
      {
        ...compliance,
        compliance_contact_email: "ops@example.com",
        legal_sender_name: "Acme",
      },
      account,
    );

    expect(profilePayloadForSave(draft)).toEqual({
      compliance_contact_email: "ops@example.com",
      default_footer_text: "",
      legal_sender_name: "Acme",
      list_unsubscribe_enabled: true,
      one_click_unsubscribe_enabled: true,
      physical_address_city: "SF",
      physical_address_country: "US",
      physical_address_line1: "1 Market",
      physical_address_line2: "",
      physical_address_postal_code: "94105",
      physical_address_region: "CA",
    });
  });

  it("keeps sender readiness gated on server-computed domain verification", () => {
    const ready = profileInputFromCompliance(
      {
        ...compliance,
        compliance_contact_email: "ops@example.com",
        legal_sender_name: "Acme",
        verified_sender_domain: true,
      },
      null,
    );
    const unverified = { ...ready, verified_sender_domain: false };

    expect(isComplianceReady(ready)).toBe(true);
    expect(isComplianceReady(unverified)).toBe(false);
    expect(
      isComplianceReady({ ...ready, list_unsubscribe_enabled: false }),
    ).toBe(false);
  });

  it("maps auth record badges", () => {
    expect(authRecordBadgeVariant({ detail: "", status: "ok" })).toBe(
      "success",
    );
    expect(authRecordLabel({ detail: "", status: "warn" })).toBe("Warn");
    expect(authRecordBadgeVariant({ detail: "", status: "fail" })).toBe(
      "destructive",
    );
  });

  it("loads core sender settings without waiting on authentication health", async () => {
    vi.mocked(emailComplianceApi.get).mockResolvedValueOnce(compliance);
    vi.mocked(sendingControlsApi.get).mockResolvedValueOnce({
      paused: false,
      source: "default",
      tenant_id: "tenant-1",
    });
    vi.mocked(sendingControlsApi.readiness).mockResolvedValueOnce({
      compliance: {
        complete: true,
        exists: true,
        list_unsubscribe_enabled: true,
        missing_compliance_email: false,
        missing_legal_sender_name: false,
        missing_physical_address: false,
        one_click_unsubscribe_enabled: true,
        verified_sender_domain: true,
      },
      controls: {
        paused: false,
        source: "default",
        tenant_id: "tenant-1",
      },
      items: [],
      ready: true,
      sending_provisioned: true,
      settings: {
        exists: true,
        quiet_hours_enabled: false,
      },
      warmup_started: false,
    });
    // The deliverability service's DNS read can be slow or absent; the
    // page's own records must not wait on it (the page reads it separately).
    vi.mocked(getAuthChecks).mockReturnValue(new Promise(() => {}));

    vi.mocked(sendingSettingsApi.get).mockResolvedValueOnce({
      tenant_id: "tenant-1",
      max_sends_per_hour: 5000,
      quiet_hours_per_recipient: true,
      updated_at: "2026-08-30T10:00:00Z",
    });

    const result = await loadSenderSettings(true, "tenant-1");

    expect(result.complianceProfile).toEqual(compliance);
    expect(result.control.paused).toBe(false);
    expect(result.sendingSettings?.updated_at).toBe("2026-08-30T10:00:00Z");
    expect(getAuthChecks).not.toHaveBeenCalled();
  });

  it("rejects an exact settings row from a different workspace", () => {
    expect(() =>
      requireTenantSendingSettings(
        {
          tenant_id: "tenant-b",
          quiet_hours_per_recipient: true,
          updated_at: "2026-08-30T10:00:00Z",
        },
        "tenant-a",
      ),
    ).toThrow(/did not match the active workspace/u);
  });
});
