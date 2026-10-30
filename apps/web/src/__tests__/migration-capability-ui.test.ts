import { describe, expect, it } from "vitest";

import {
  migrationAutomationCapabilityLabel,
  migrationCapabilityDescription,
} from "@/lib/migration-capability-copy";
import type { AdapterCapabilities } from "@/lib/types";

function mailchimp(
  automationMode: "runtime" | "rebuild_review" | "none",
): AdapterCapabilities {
  return {
    source: "mailchimp",
    auth_method: "oauth2",
    supports: {
      subscribers: true,
      segments: true,
      automations: automationMode !== "none",
      automation_mode: automationMode,
      campaign_archive: true,
      paid_subs: false,
      consent_timestamps: true,
    },
  };
}

function beehiiv(): AdapterCapabilities {
  return {
    source: "beehiiv",
    auth_method: "api_key",
    supports: {
      subscribers: true,
      segments: true,
      automations: true,
      automation_mode: "rebuild_review",
      campaign_archive: true,
      paid_subs: false,
      consent_timestamps: false,
    },
  };
}

function klaviyo(): AdapterCapabilities {
  return {
    source: "klaviyo",
    auth_method: "api_key",
    supports: {
      subscribers: true,
      segments: true,
      automations: true,
      automation_mode: "rebuild_review",
      campaign_archive: true,
      paid_subs: false,
      consent_timestamps: true,
    },
  };
}

function customerIO(): AdapterCapabilities {
  return {
    source: "customerio",
    auth_method: "api_key",
    supports: {
      subscribers: true,
      segments: true,
      automations: true,
      automation_mode: "rebuild_review",
      campaign_archive: true,
      paid_subs: false,
      consent_timestamps: false,
    },
  };
}

describe("web migration capability copy", () => {
  it("labels Mailchimp Classic Automations as runtime without claiming Journey support", () => {
    const capability = mailchimp("runtime");
    expect(migrationAutomationCapabilityLabel(capability)).toBe(
      "Validated Classic welcome series (runtime)",
    );
    expect(migrationCapabilityDescription(capability)).toContain(
      "validated Classic welcomeSeries subset can migrate to the Moosewave runtime, paused",
    );
    expect(migrationCapabilityDescription(capability)).toContain(
      "Customer Journeys require manual rebuild",
    );
  });

  it("uses rebuild-review copy when that is what the server advertises", () => {
    const capability = mailchimp("rebuild_review");
    expect(migrationAutomationCapabilityLabel(capability)).toBe(
      "Classic Automation rebuild review",
    );
    expect(migrationCapabilityDescription(capability)).toContain(
      "rebuild-review evidence",
    );
    expect(migrationCapabilityDescription(capability)).toContain(
      "Customer Journeys require manual rebuild",
    );
  });

  it("uses Beehiiv-specific rebuild and billing boundaries", () => {
    const capability = beehiiv();
    const description = migrationCapabilityDescription(capability);

    expect(migrationAutomationCapabilityLabel(capability)).toBe(
      "Automation rebuild review",
    );
    expect(description).toContain("sent-post archive");
    expect(description).toContain("Dynamic segment predicates");
    expect(description).toContain("premium membership metadata is archived");
    expect(description).toContain("Stripe billing continuity");
    expect(description).toContain("portable consent timestamps");
    expect(description).not.toContain("phone-only");
    expect(description).not.toContain("CRM");
  });

  it("uses Klaviyo-specific profile, segment, archive, and flow boundaries", () => {
    const capability = klaviyo();
    const description = migrationCapabilityDescription(capability);

    expect(migrationAutomationCapabilityLabel(capability)).toBe(
      "Flow rebuild review",
    );
    expect(description).toContain("primary email identity");
    expect(description).toContain("stable Get Profiles");
    expect(description).toContain("secondary email addresses");
    expect(description).toContain("independent per-address consent");
    expect(description).toContain(
      "automatic profile-identity or consent parity is unavailable",
    );
    expect(description).toContain("10 requests/second");
    expect(description).toContain("150 requests/minute");
    expect(description).toContain("Klaviyo list <id>");
    expect(description).toContain("Klaviyo segment <id>");
    expect(description).toContain(
      "stable profile ID changes from email A to B",
    );
    expect(description).toContain("full final snapshot");
    expect(description).toContain(
      "second job for the same tenant/account is rejected",
    );
    expect(description).toContain("send-targetable list/segment projection");
    expect(description).toContain(
      "Raw Klaviyo audience membership counts are not exposed separately",
    );
    expect(description).toContain(
      "Draft campaign-message definitions and flow definitions may be null",
    );
    expect(description).toContain("provider IDs only");
    expect(description).toContain(
      "always emits eight static product-area checklist records",
    );
    expect(description).toContain("not detected source inventory");
    expect(description).toContain("sent email campaign archive rows");
    expect(description).toContain(
      "Sent SMS and push records remain non-executable source-archive evidence",
    );
    expect(description).toContain("never become email campaigns");
    expect(description).toContain("Klaviyo flows");
    expect(description).toContain("reporting metrics");
    expect(description).toContain("non-email-only profiles");
    expect(description).not.toContain("phone-only, CRM");
  });

  it("uses Customer.io-specific identity, workspace, full-snapshot, and workflow boundaries", () => {
    const capability = customerIO();
    const description = migrationCapabilityDescription(capability);

    expect(migrationAutomationCapabilityLabel(capability)).toBe(
      "Campaign/API-broadcast rebuild review",
    );
    expect(description).toContain("App API key");
    expect(description).toContain("never a Track API site key");
    expect(description).toContain("immutable cio_id");
    expect(description).toContain("multiple profiles sharing an email");
    expect(description).toContain("ESP suppressions");
    expect(description).toContain(
      "global state is subscribed, the resolved email-channel state is subscribed explicitly or by configured default",
    );
    expect(description).toContain(
      "applicable topic is subscribed explicitly or by configured default",
    );
    expect(description).toContain(
      "/v1/optouts is separate from subscription-center channel preferences and never determines email eligibility",
    );
    expect(description).toContain("frozen segment");
    expect(description).toContain("sent email newsletters");
    expect(description).toContain('at least one explicit language="" default');
    expect(description).toContain("lowest stable content ID");
    expect(description).toContain("multi-default/A-B set");
    expect(description).toContain("translations are never silently selected");
    expect(description).toContain(
      "neither newsletter nor Design Studio HTML is provider-rendered output",
    );
    expect(description).toContain("rebuild-only");
    expect(description).toContain(
      "no supported incremental profile-change feed",
    );
    expect(description).toContain("all six manual evidence gates");
  });
});
