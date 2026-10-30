// SPDX-License-Identifier: AGPL-3.0-only

export const SMS_RELEASE_CLAIM_RULES = [
  {
    path: "apps/web/src/lib/sms-release-status.ts",
    require: [
      'SMS_RELEASE_VERDICT = "HOLD / NO-GO"',
      "sms_reply_dispatch_release_held",
      "sms_broadcast_dispatch_release_held",
      "sms_campaign_dispatch_release_held",
      "sms_campaign_schedule_release_held",
      "sms_test_dispatch_release_held",
      "sms_a2p_registration_release_held",
      "sms_auto_reply_dispatch_release_held",
      "sms_provider_callback_release_held",
      "sms_click_resolver_release_held",
      "sms_financial_ledger_release_held",
      "sms_mms_readiness_release_held",
      "sms_evidence_read_release_held",
    ],
  },
  {
    path: "apps/web/src/app/(marketing)/sms/page.tsx",
    require: [
      'from "@/lib/sms-release-status"',
      "SMS source surfaces. Hosted sending is held.",
      "Do not activate customer SMS traffic.",
    ],
    reject: [
      "SMS that can't send without consent",
      "SMS that can&apos;t send without consent",
      "all on by default",
      "send a real test",
      "Moosewave drives the registration flow",
    ],
  },
  {
    path: "apps/web/src/app/(marketing)/sms/opengraph-image.tsx",
    require: [
      'from "@/lib/sms-release-status"',
      "SMS source surfaces. Hosted sending is held.",
      "Dispatch held",
    ],
    reject: ["SMS that can&apos;t send without consent", "Consent-gated"],
  },
  ...[
    "apps/web/src/app/(marketing)/page.tsx",
    "apps/web/src/app/(marketing)/features/page.tsx",
    "apps/web/src/app/(marketing)/vs/page.tsx",
    "apps/web/src/app/(marketing)/changelog/page.tsx",
  ].map((path) => ({
    path,
    require: ['from "@/lib/sms-release-status"', "SMS_RELEASE_VERDICT"],
  })),
  {
    path: "apps/web/src/app/(marketing)/deliverability/page.tsx",
    require: [
      "SMS policy row does not override the current hosted SMS dispatch holds",
    ],
    reject: ["per channel (email, SMS, push, webhook)"],
  },
  {
    path: "apps/web/src/app/(marketing)/audiences/page.tsx",
    require: ["device handoff is not Moosewave hosted SMS dispatch"],
  },
  {
    path: "apps/web/src/app/(marketing)/migrate-anywhere/page.tsx",
    require: ["SMS evidence remains non-sendable archive material"],
  },
  {
    path: "apps/web/src/app/(marketing)/migrations/[from]/page.tsx",
    require: [
      "SMS broadcasts remain non-executable archive evidence under HOLD / NO-GO",
    ],
    reject: ["email/SMS targeting"],
  },
  {
    path: "apps/web/src/app/(marketing)/vs/page.tsx",
    require: ['dimension: "SMS"', 'moosewave: "Partial"'],
    reject: ['note: "Send SMS broadcasts and automations'],
  },
  {
    path: "apps/web/src/app/(marketing)/changelog/page.tsx",
    require: ["Historical source milestone", "SMS_RELEASE_HOLD_CODES.campaign"],
    reject: ["a full SMS / mobile-push channel"],
  },
  {
    path: "docs-site/pages/sms/index.mdx",
    require: [
      "**HOLD / NO-GO.**",
      "sms_reply_dispatch_release_held",
      "sms_broadcast_dispatch_release_held",
      "sms_a2p_registration_release_held",
      "sms_registration_evidence_authority_required",
      "sms_provider_callback_release_held",
      "sms_financial_ledger_release_held",
      "sms_mms_readiness_release_held",
      "sms_evidence_read_release_held",
    ],
    reject: ["Moosewave sends SMS and MMS alongside email"],
  },
  {
    path: "docs-site/pages/sms/inbox.mdx",
    require: [
      "**HOLD / NO-GO:**",
      "sms_reply_dispatch_release_held",
      "a repeatable MVCC snapshot",
    ],
    reject: ["Replies route through the same outbound provider"],
  },
  {
    path: "docs-site/pages/sms/broadcasts.mdx",
    require: [
      "**HOLD / NO-GO.**",
      "sms_campaign_dispatch_release_held",
      "sms_broadcast_dispatch_release_held",
      "sms_evidence_read_release_held",
    ],
    reject: ["Returns `202 Accepted`", "Live send progress"],
  },
  {
    path: "docs-site/pages/sms/a2p-10dlc.mdx",
    require: [
      "**HOLD / NO-GO.**",
      "sms_a2p_registration_release_held",
      "sms_registration_evidence_authority_required",
      "not dispatch or",
    ],
    reject: ["Moosewave drives the registration through your provider"],
  },
  {
    path: "docs-site/pages/sms/compliance.mdx",
    require: [
      "**HOLD / NO-GO.**",
      "sms_provider_callback_release_held",
      "submit and poll remain `sms_a2p_registration_release_held`",
      "recipient-local quiet hours",
      '"action": "revoked"',
      '"source": "manual"',
      "/api/v1/sms/suppressions/query",
      "never place the phone or cursor",
      "Neither action grants or restores consent",
    ],
    reject: [
      "handles the mandatory STOP/HELP keywords",
      '"action": "opt_in"',
      '"source": "checkout_form"',
      '"subscriber_email"',
    ],
  },
  {
    path: "docs-site/pages/sms/credits.mdx",
    require: [
      "**HOLD / NO-GO:**",
      "sms_financial_ledger_release_held",
      "sms_mms_readiness_release_held",
    ],
    reject: ["Preview the cost before you send", "start a checkout"],
  },
  {
    path: "docs-site/pages/analytics/index.mdx",
    require: ["sms_evidence_read_release_held"],
    reject: ["SMS campaigns have their own report shape"],
  },
  {
    path: "docs-site/pages/api-reference/reports.mdx",
    require: ["sms_evidence_read_release_held"],
    reject: [
      "SMS campaigns have their own `/api/v1/sms/campaigns/{id}/report`",
    ],
  },
  {
    path: "docs-site/pages/team/roles.mdx",
    require: [
      "SMS dispatch remains structurally release-held",
      "sms_campaign_dispatch_release_held",
    ],
    reject: ["Actually dispatch mail/SMS"],
  },
  {
    path: "docs-site/pages/migration/activecampaign.mdx",
    require: ["HOLD / NO-GO", "sms_provider_callback_release_held"],
    reject: [
      "passing Moosewave SMS readiness check",
      "pass the live Moosewave SMS pilot-readiness checks",
    ],
  },
  {
    path: "docs-site/pages/api-reference/native-integration-api-audit.mdx",
    require: [
      "HOLD / NO-GO, not a live native integration",
      "canonical AWS intentionally supplies no process-global provider credentials",
    ],
    reject: ["Partial first-party SMS foundation, not full verified native"],
  },
  {
    path: "docs-site/pages/migration/hubspot.mdx",
    require: ["non-sendable review evidence", "HOLD / NO-GO"],
    reject: ["controlled email/SMS cutovers"],
  },
  {
    path: "docs-site/pages/api-reference/integrations.mdx",
    require: ["structural dispatch/provider holds", "HOLD / NO-GO"],
    reject: ["Ads audience sync, SMS, subscription changes"],
  },
  {
    path: "docs/first-customer-pilot-runbook.md",
    require: [
      "**HOLD / NO-GO**",
      "No Customer Action",
      "sms_a2p_registration_release_held",
      "sms_provider_callback_release_held",
      "No customer SMS credential",
    ],
    reject: [
      "proving one live SMS path",
      "postwave sms campaigns send",
      "Send a test SMS to an internal recipient",
    ],
  },
  {
    path: "docs/tech-stack-inventory.md",
    require: [
      "**No — SMS HOLD / NO-GO**",
      "tenant-owned vault/account resolution",
    ],
    reject: ["Yes for live SMS"],
  },
  ...[
    "packages/cli/README.md",
    "packages/sdk-ts/README.md",
    "packages/sdk-php/README.md",
    "packages/sdk-py/README.md",
  ].map((path) => ({
    path,
    require: ["HOLD / NO-GO", "immutable"],
  })),
  {
    path: "packages/cli/README.md",
    require: ["sms_campaign_dispatch_release_held"],
    reject: ["postwave sms campaigns send"],
  },
  {
    path: "packages/sdk-php/README.md",
    require: ["sms_campaign_dispatch_release_held"],
    reject: ["$pw->sms->sendCampaign("],
  },
  {
    path: ".env.production.template",
    require: [
      "SMS (release-held; do not configure provider credentials)",
      "tenant-bound encrypted credential/account resolver",
      "supplies no Twilio/Telnyx/Bandwidth secrets",
    ],
    rejectPatterns: [
      /^#?\s*TWILIO_ACCOUNT_SID=/mu,
      /^#?\s*TWILIO_AUTH_TOKEN=/mu,
      /^#?\s*TELNYX_API_KEY=/mu,
      /^#?\s*BANDWIDTH_API_PASSWORD=/mu,
    ],
  },
  {
    path: "docs/audits/2026-08-23-sms-inbox-99p9-audit.md",
    require: [
      "Route 40",
      "**HOLD / NO-GO**",
      "sms_reply_dispatch_release_held",
      "tenant-owned provider credential/account topology",
      "no POST, replay, discard or new-key action",
    ],
    reject: ["reuses the same key only for explicit exact-intent review"],
  },
  {
    path: "docs/audits/2026-08-28-sms-suppressions-99p9-audit.md",
    require: [
      "Route 42",
      "**HOLD / NO-GO**",
      "Hosted provider callbacks, scheduling, dispatch and automatic confirmations",
      "Production stays **HOLD / NO-GO**.",
    ],
  },
  ...[
    "docs/audits/2026-07-16-desktop-ui-ux-five-year-implementation-ledger.md",
    "docs/audits/2026-07-18-desktop-99p9-design-program-ledger.md",
    "docs/audits/README.md",
  ].map((path) => ({
    path,
    require: ["2026-08-23-sms-inbox-99p9-audit.md", "HOLD / NO-GO"],
  })),
  {
    path: "config/document-governance.json",
    require: [
      '"path": "docs/audits/2026-08-23-sms-inbox-99p9-audit.md"',
      '"lastReviewed": "2026-08-23"',
    ],
  },
];

export const SMS_MCP_SENDER_DESCRIPTION =
  "Create or update a first-party SMS sender profile. Hosted mode has no configured or accepted process-global provider credentials. Provider effects and callbacks remain release-held until a tenant-bound encrypted credential vault and provider-account ownership resolver exists; this does not create provider messaging services, profiles, applications, or phone-number campaign assignments.";

export const SMS_RELEASE_ARTIFACT_RULES = [
  "packages/mcp-server/src/tools/sms.ts",
  "packages/mcp-server/dist/index.js",
  "packages/mcp-server/dist/index.js.map",
  "apps/web/src/lib/mcp-tools.json",
  "apps/api/internal/apikeycalls/tool-catalog.json",
  "apps/web/src/lib/mcp-tool-details.generated.json",
].map((path) => ({
  path,
  require: [SMS_MCP_SENDER_DESCRIPTION],
  reject: ["Provider credentials stay in server-side SMS configuration"],
}));

export function inspectSMSReleaseClaims(readSource) {
  const errors = [];

  for (const rule of [
    ...SMS_RELEASE_CLAIM_RULES,
    ...SMS_RELEASE_ARTIFACT_RULES,
  ]) {
    let source;
    try {
      source = readSource(rule.path);
    } catch (error) {
      errors.push(`${rule.path}: unavailable (${error.message})`);
      continue;
    }

    for (const snippet of rule.require ?? []) {
      if (!source.includes(snippet)) {
        errors.push(`${rule.path}: missing ${JSON.stringify(snippet)}`);
      }
    }
    for (const snippet of rule.reject ?? []) {
      if (source.includes(snippet)) {
        errors.push(
          `${rule.path}: stale live-SMS/MCP claim ${JSON.stringify(snippet)}`,
        );
      }
    }
    for (const pattern of rule.rejectPatterns ?? []) {
      if (pattern.test(source)) {
        errors.push(
          `${rule.path}: forbidden provider-secret template ${pattern}`,
        );
      }
    }
  }

  const privacyFiles = [
    ...new Set(SMS_RELEASE_CLAIM_RULES.map(({ path }) => path)),
  ];
  for (const path of privacyFiles) {
    let source;
    try {
      source = readSource(path);
    } catch {
      continue;
    }
    for (const match of source.matchAll(/\+1\d{10}/gu)) {
      if (!/^\+120255501\d{2}$/u.test(match[0])) {
        errors.push(`${path}: non-fictional NANP evidence ${match[0]}`);
      }
    }
    if (/\b(?:AC|SM|MM)[0-9a-f]{32}\b/iu.test(source)) {
      errors.push(`${path}: provider identifier-shaped evidence is forbidden`);
    }
  }

  return errors;
}
