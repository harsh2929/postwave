// SPDX-License-Identifier: AGPL-3.0-only

export const SUPPORT_RUNTIME_HOLD_CODE = "support_integration_runtime_held";
export const SUPPORT_CALLBACK_HOLD_CODE = "support_provider_ingress_held";
export const SUPPORT_HISTORY_BANNER =
  "Release hold (2026-08-25; historical/source-only)";

export const SUPPORT_PROVIDER_HISTORY_PATHS = [
  "docs/integrations/ada.md",
  "docs/integrations/asana-support.md",
  "docs/integrations/clickup-support.md",
  "docs/integrations/crisp.md",
  "docs/integrations/drift.md",
  "docs/integrations/freshchat.md",
  "docs/integrations/freshdesk.md",
  "docs/integrations/front.md",
  "docs/integrations/gladly.md",
  "docs/integrations/gorgias.md",
  "docs/integrations/groove.md",
  "docs/integrations/help-scout.md",
  "docs/integrations/helpcrunch.md",
  "docs/integrations/hubspot-service-hub.md",
  "docs/integrations/intercom.md",
  "docs/integrations/jira-service-management.md",
  "docs/integrations/kayako.md",
  "docs/integrations/kustomer.md",
  "docs/integrations/linear.md",
  "docs/integrations/livechat.md",
  "docs/integrations/olark.md",
  "docs/integrations/reamaze.md",
  "docs/integrations/salesforce-service-cloud.md",
  "docs/integrations/tidio.md",
  "docs/integrations/zendesk.md",
  "docs/integrations/zoho-desk.md",
];

export const HELPDESK_RELEASE_CLAIM_RULES = [
  {
    path: "apps/web/src/lib/integrations.ts",
    require: [
      'name: "Support integration runtime held"',
      SUPPORT_RUNTIME_HOLD_CODE,
      SUPPORT_CALLBACK_HOLD_CODE,
      "No support runtime request was sent",
      'runtimeHoldCode: "support_integration_runtime_held"',
    ],
    reject: [
      "Today the live path is ingest-first",
      "Credentials and settings are accepted and validated now",
      "POST canonical ticket, conversation, and event data",
      "Canonical ingest API for tickets, conversations, and events",
    ],
  },
  {
    path: "apps/web/src/app/(marketing)/integrations/[slug]/page.tsx",
    require: [
      "integration.runtimeHoldCode",
      "Setup and provider actions are not available",
      "No runtime request was sent",
    ],
  },
  {
    path: "docs-site/pages/api-reference/native-integration-api-audit.mdx",
    require: [
      "Support-family release hold (2026-08-25)",
      SUPPORT_RUNTIME_HOLD_CODE,
      SUPPORT_CALLBACK_HOLD_CODE,
      "historical source/adaptor audit evidence only",
    ],
  },
  {
    path: "docs/native-integrations-progress.md",
    require: [
      "Current support-family correction (2026-08-25)",
      SUPPORT_RUNTIME_HOLD_CODE,
      SUPPORT_CALLBACK_HOLD_CODE,
      "historical source-progress evidence",
    ],
  },
  {
    path: "docs/klaviyo-gap-alleviation-register.json",
    require: [
      "customer_hub_runtime_unavailable",
      "delivery not applicable",
      "no unified or current mirror is claimed",
      "customer_agent_draft_write_held",
    ],
    reject: [
      "Helpdesk supports email, SMS, web chat, Instagram, WhatsApp",
      "Inbound email and SMS conversations are mirrored into a unified support spine",
    ],
  },
  {
    path: "docs/klaviyo-gap-alleviation-plan.md",
    require: [
      "Historical source milestone; current release correction (2026-08-25)",
      "complete privacy lifecycle remains held",
      "no unified/current",
    ],
  },
  {
    path: "docs/implementation-backlog-2026-06-22.md",
    require: [
      "Historical synthesis correction (2026-08-25)",
      "recorded timing only, not a governed SLA",
      SUPPORT_RUNTIME_HOLD_CODE,
      SUPPORT_CALLBACK_HOLD_CODE,
    ],
    reject: ["Inbound email+SMS mirror + spam scoring + SLA report shipped"],
  },
  {
    path: "docs/ecosystem/parity-matrix.md",
    require: [
      "Route41 Helpdesk correction (2026-08-25)",
      "complete privacy lifecycle",
    ],
  },
  ...[
    "packages/sdk-ts/README.md",
    "packages/sdk-py/README.md",
    "packages/sdk-php/README.md",
    "packages/cli/README.md",
  ].map((path) => ({
    path,
    require: [SUPPORT_RUNTIME_HOLD_CODE, "no HTTP request"],
  })),
  ...["packages/sdk-ts/README.md", "packages/sdk-py/README.md"].map(
    (path) => ({
      path,
      require: [
        "catalog/minimized-read compatibility only",
        "tenant-bound minimized historical stored",
        "A first page is not complete history",
        "Continue manually only when",
        "next_cursor",
      ],
    }),
  ),
  {
    path: "packages/mcp-server/src/tools/integrations.ts",
    require: [
      "Support is release-held with code support_integration_runtime_held",
      "minimized historical projection only",
      "opaque cursor pagination",
      "copy page.next_cursor exactly",
      'name: "native_integration_get"',
      "tenant-bound minimized historical projection",
      "lowercase canonical UUID",
    ],
  },
  {
    path: "apps/web/src/lib/mcp-tools.json",
    require: [
      "Support is release-held with code support_integration_runtime_held",
      "minimized release-held historical projection",
      "optional limit/cursor pagination with manual continuation",
      "native_integration_get",
      "tenant-bound minimized historical projection",
      "lowercase canonical UUID",
    ],
  },
  {
    path: "apps/desktop/src/components/helpdesk/HelpdeskInbox.tsx",
    require: [
      "cannot currently be edited or deleted through Helpdesk",
      "complete privacy lifecycle remains held",
      "and no customer channel is contacted",
    ],
  },
  {
    path: "apps/desktop/src/components/helpdesk/CustomerAgentPanel.tsx",
    require: [
      "customer_agent_draft_write_held",
      "No request will be sent",
      "Provider executed",
    ],
  },
  {
    path: "apps/desktop/src/components/tour/workspaceTour.ts",
    require: [
      "add private internal notes",
      "Customer reply delivery and live channel handling remain release-held",
    ],
  },
  {
    path: "apps/desktop/src/pages/integrations/NativeProviderConnectModals.tsx",
    require: [
      "Support integration runtime held",
      SUPPORT_RUNTIME_HOLD_CODE,
      SUPPORT_CALLBACK_HOLD_CODE,
      "No credential field is shown",
    ],
    reject: [
      "native managed support-ingest configuration",
      "supportIntegrationsApi.create",
      "supportIntegrationName",
    ],
  },
  {
    path: "apps/desktop/src/lib/api/support-integrations.ts",
    require: [
      "SUPPORT_INTEGRATION_RUNTIME_HOLD_CODE",
      "No support runtime request was sent",
      'retryability: "not-retryable"',
    ],
    reject: [
      "encodeURIComponent(id)",
      'method: "POST"',
      'method: "DELETE"',
    ],
  },
];

export function inspectHelpdeskReleaseClaims(readSource) {
  const errors = [];
  const rules = [
    ...HELPDESK_RELEASE_CLAIM_RULES,
    ...SUPPORT_PROVIDER_HISTORY_PATHS.map((path) => ({
      path,
      require: [
        SUPPORT_HISTORY_BANNER,
        SUPPORT_RUNTIME_HOLD_CODE,
        SUPPORT_CALLBACK_HOLD_CODE,
        "not current availability or runnable setup guidance",
      ],
      reject: ["/api/public/support-integrations"],
    })),
  ];

  for (const rule of rules) {
    let source;
    try {
      source = readSource(rule.path);
    } catch (error) {
      errors.push(`${rule.path}: unavailable (${error.message})`);
      continue;
    }
    for (const required of rule.require ?? []) {
      if (!source.includes(required)) {
        errors.push(`${rule.path}: missing ${JSON.stringify(required)}`);
      }
    }
    for (const rejected of rule.reject ?? []) {
      if (source.includes(rejected)) {
        errors.push(
          `${rule.path}: stale Helpdesk/support claim ${JSON.stringify(rejected)}`,
        );
      }
    }
  }
  return errors;
}
