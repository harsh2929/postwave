#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("../..", import.meta.url).pathname;
const strict = process.argv.includes("--strict");

const groups = [
  {
    id: "dodo-payments",
    label: "Dodo Payments billing and webhooks",
    required: [
      "BILLING_PROVIDER",
      "DODO_PAYMENTS_ENVIRONMENT",
      "DODO_PAYMENTS_API_KEY",
      "DODO_PAYMENTS_WEBHOOK_KEY",
      "DODO_PAYMENTS_PRODUCT_ID_LAUNCH_MONTHLY",
      "DODO_PAYMENTS_PRODUCT_ID_GROWTH_MONTHLY",
      "DODO_PAYMENTS_PRODUCT_ID_SCALE_MONTHLY",
    ],
    validateEnv: () => {
      const problems = [];
      if (envValue("BILLING_PROVIDER") !== "dodo") {
        problems.push("BILLING_PROVIDER must be dodo");
      }
      if (!["test_mode", "live_mode"].includes(envValue("DODO_PAYMENTS_ENVIRONMENT"))) {
        problems.push("DODO_PAYMENTS_ENVIRONMENT must be test_mode or live_mode");
      }
      const products = ["DODO_PAYMENTS_PRODUCT_ID_LAUNCH_MONTHLY", "DODO_PAYMENTS_PRODUCT_ID_GROWTH_MONTHLY", "DODO_PAYMENTS_PRODUCT_ID_SCALE_MONTHLY"]
        .map(envValue)
        .filter(Boolean);
      if (products.some((id) => !id.startsWith("pdt_"))) {
        problems.push("Dodo Payments product IDs must start with pdt_");
      }
      if (products.length === 3 && new Set(products).size !== products.length) {
        problems.push("DODO_PAYMENTS_PRODUCT_ID_LAUNCH_MONTHLY, DODO_PAYMENTS_PRODUCT_ID_GROWTH_MONTHLY, and DODO_PAYMENTS_PRODUCT_ID_SCALE_MONTHLY must be distinct");
      }
      return problems;
    },
  },
  {
    id: "mailchimp",
    label: "Mailchimp OAuth migration",
    required: [
      "MAILCHIMP_CLIENT_ID",
      "MAILCHIMP_CLIENT_SECRET",
      "OAUTH_REDIRECT_URI",
      "POSTWAVE_MIGRATION_SESSION_KEK",
    ],
  },
  {
    id: "convertkit",
    label: "Kit/ConvertKit OAuth migration",
    required: [
      "CONVERTKIT_CLIENT_ID",
      "CONVERTKIT_CLIENT_SECRET",
      "OAUTH_REDIRECT_URI",
      "POSTWAVE_MIGRATION_SESSION_KEK",
    ],
  },
  {
    id: "shopify",
    label: "Shopify commerce integration",
    required: [
      "SHOPIFY_CLIENT_ID",
      "SHOPIFY_CLIENT_SECRET",
      "SHOPIFY_OAUTH_REDIRECT_URL",
      "SHOPIFY_STATE_SECRET",
      "SHOPIFY_WEBHOOK_SECRET",
    ],
  },
  {
    id: "deliverability-ai",
    label: "Deliverability AI and render previews",
    required: [
      "GEMINI_API_KEY",
      "DIAGNOSTICIAN_PROMPTS_PATH",
      "DIAGNOSTICIAN_EVAL_CASES_PATH",
      "HCTI_USER_ID",
      "HCTI_API_KEY",
    ],
  },
  {
    id: "seedlist",
    label: "Seed-list inbox placement polling",
    anyOf: [["SEEDLIST_CONFIG_PATH", "POSTWAVE_SEEDLIST_IMAP_JSON"]],
    required: ["SEEDLIST_CONNECTOR"],
    docsRequired: ["SEEDLIST_VENDOR_API_URL"],
    validateEnv: () => {
      const connector = envValue("SEEDLIST_CONNECTOR");
      if (connector && connector !== "imap" && connector !== "vendor") {
        return ["SEEDLIST_CONNECTOR must be imap or vendor"];
      }
      if (connector === "vendor" && !envValue("SEEDLIST_VENDOR_API_URL")) {
        return ["SEEDLIST_VENDOR_API_URL is required when SEEDLIST_CONNECTOR=vendor"];
      }
      return [];
    },
  },
  {
    id: "dmarc",
    label: "DMARC aggregate ingest",
    anyOf: [["DMARC_IMAP_PASSWORD", "DMARC_IMAP_PASSWORD_SECRET_NAME"]],
    required: ["DMARC_IMAP_HOST", "DMARC_IMAP_USER"],
  },
  {
    id: "email-sending",
    label: "Transactional/sending provider",
    anyOf: [["POSTMARK_ACCOUNT_TOKEN", "AWS_SES_REGION"]],
    required: ["POSTWAVE_AUTH_FROM_ADDRESS", "POSTWAVE_MAILER", "DKIM_ROOT_DOMAIN"],
  },
  {
    id: "sms",
    label: "SMS pilot sending and callbacks",
    required: ["POSTWAVE_PUBLIC_BASE_URL", "SMS_DEFAULT_PROVIDER"],
    alternativeSelector: "SMS_DEFAULT_PROVIDER",
    docsRequired: [
      "SMS_DEFAULT_PROVIDER",
      "TWILIO_ACCOUNT_SID",
      "TWILIO_AUTH_TOKEN",
      "TWILIO_MESSAGING_SERVICE_SID",
      "TWILIO_FROM_NUMBER",
      "TWILIO_WEBHOOK_AUTH_TOKEN",
      "TWILIO_STATUS_CALLBACK_URL",
      "TELNYX_API_KEY",
      "TELNYX_FROM_NUMBER",
      "TELNYX_MESSAGING_PROFILE_ID",
      "TELNYX_WEBHOOK_URL",
      "TELNYX_PUBLIC_KEY",
      "BANDWIDTH_ACCOUNT_ID",
      "BANDWIDTH_API_USERNAME",
      "BANDWIDTH_API_PASSWORD",
      "BANDWIDTH_WEBHOOK_TOKEN",
      "BANDWIDTH_WEBHOOK_USERNAME",
      "BANDWIDTH_WEBHOOK_PASSWORD",
      "BANDWIDTH_APPLICATION_ID",
      "BANDWIDTH_FROM_NUMBER",
    ],
    alternatives: [
      {
        id: "twilio",
        label: "Twilio",
        required: [
          "TWILIO_ACCOUNT_SID",
          "TWILIO_AUTH_TOKEN",
          "TWILIO_WEBHOOK_AUTH_TOKEN",
          "TWILIO_STATUS_CALLBACK_URL",
        ],
        anyOf: [["TWILIO_MESSAGING_SERVICE_SID", "TWILIO_FROM_NUMBER"]],
      },
      {
        id: "telnyx",
        label: "Telnyx",
        required: ["TELNYX_API_KEY", "TELNYX_PUBLIC_KEY", "TELNYX_WEBHOOK_URL"],
        anyOf: [["TELNYX_MESSAGING_PROFILE_ID", "TELNYX_FROM_NUMBER"]],
      },
      {
        id: "bandwidth",
        label: "Bandwidth webhook token",
        required: [
          "BANDWIDTH_ACCOUNT_ID",
          "BANDWIDTH_API_USERNAME",
          "BANDWIDTH_API_PASSWORD",
          "BANDWIDTH_WEBHOOK_TOKEN",
        ],
        anyOf: [["BANDWIDTH_APPLICATION_ID", "BANDWIDTH_FROM_NUMBER"]],
      },
      {
        id: "bandwidth",
        label: "Bandwidth webhook basic auth",
        required: [
          "BANDWIDTH_ACCOUNT_ID",
          "BANDWIDTH_API_USERNAME",
          "BANDWIDTH_API_PASSWORD",
          "BANDWIDTH_WEBHOOK_USERNAME",
          "BANDWIDTH_WEBHOOK_PASSWORD",
        ],
        anyOf: [["BANDWIDTH_APPLICATION_ID", "BANDWIDTH_FROM_NUMBER"]],
      },
    ],
  },
];

const docsText = [
  "apps/api/.env.example",
  "apps/web/.env.example",
  "services/migration/README.md",
  "docs/runbooks/provider-rehearsal.md",
]
  .map((file) => readFileSync(join(ROOT, file), "utf8"))
  .join("\n");

let failed = false;
for (const group of groups) {
  const missingDocs = missingForSpec(group, (key) => docsText.includes(key), true);
  const baseMissingEnv = missingForSpec(group, (key) => Boolean(envValue(key)), false);
  const alternativeResults = (group.alternatives ?? []).map((alternative) => ({
    id: alternative.id,
    label: alternative.label,
    missing: missingForSpec(alternative, (key) => Boolean(envValue(key)), false),
  }));
  const envProblems = group.validateEnv?.() ?? [];

  const docsOK = missingComplete(missingDocs);
  const selectedAlternative = group.alternativeSelector
    ? envValue(group.alternativeSelector).toLowerCase()
    : "";
  const supportedSelection =
    !group.alternativeSelector ||
    alternativeResults.some((result) => result.id === selectedAlternative);
  const alternativesOK =
    alternativeResults.length === 0 ||
    (group.alternativeSelector
      ? supportedSelection &&
        alternativeResults.some(
          (result) => result.id === selectedAlternative && missingComplete(result.missing),
        )
      : alternativeResults.some((result) => missingComplete(result.missing)));
  const envOK =
    missingComplete(baseMissingEnv) &&
    alternativesOK &&
    envProblems.length === 0;
  const status = !docsOK || (strict && !envOK) ? "FAIL" : envOK ? "PASS" : "WARN";

  console.log(`${status} ${group.id}: ${group.label}`);
  if (!docsOK) {
    printMissing("docs/env examples", missingDocs);
  }
  if (!envOK) {
    printMissing("env", baseMissingEnv);
    for (const problem of envProblems) console.log(`  - env invalid: ${problem}`);
    if (alternativeResults.length) {
      if (group.alternativeSelector && !supportedSelection && selectedAlternative) {
        console.log(
          `  - env invalid: ${group.alternativeSelector}=${selectedAlternative} is not a supported provider`,
        );
      }
      console.log(
        group.alternativeSelector && selectedAlternative
          ? `  - env does not satisfy the selected ${selectedAlternative} provider option:`
          : "  - env does not satisfy any supported provider option:",
      );
      for (const { label, missing } of alternativeResults) {
        if (
          group.alternativeSelector &&
          selectedAlternative &&
          !alternativeResults.find((result) => result.label === label && result.id === selectedAlternative)
        ) {
          continue;
        }
        if (missingComplete(missing)) continue;
        console.log(`    - ${label}: ${formatMissing(missing)}`);
      }
    }
  }
  if (status === "FAIL") failed = true;
}

if (failed) process.exit(1);

console.log(
  strict
    ? "\nProvider rehearsal preflight passed in strict mode."
    : "\nProvider rehearsal preflight completed. Warnings are expected without real provider credentials.",
);

function missingForSpec(spec, hasKey, includeDocsOnly) {
  const required = [
    ...(spec.required ?? []),
    ...(includeDocsOnly ? spec.docsRequired ?? [] : []),
  ];
  return {
    required: required.filter((key) => !hasKey(key)),
    anyOf: (spec.anyOf ?? []).filter((choices) => choices.every((key) => !hasKey(key))),
  };
}

function missingComplete(missing) {
  return missing.required.length === 0 && missing.anyOf.length === 0;
}

function printMissing(label, missing) {
  if (missing.required.length) console.log(`  - ${label} missing: ${missing.required.join(", ")}`);
  for (const choices of missing.anyOf) console.log(`  - ${label} missing one of: ${choices.join(" | ")}`);
}

function formatMissing(missing) {
  const parts = [];
  if (missing.required.length) parts.push(`missing ${missing.required.join(", ")}`);
  for (const choices of missing.anyOf) parts.push(`need one of ${choices.join(" | ")}`);
  return parts.join("; ");
}

function envValue(key) {
  return String(process.env[key] ?? "").trim();
}
