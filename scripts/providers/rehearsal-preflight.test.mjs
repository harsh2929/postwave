import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

const script = new URL("./rehearsal-preflight.mjs", import.meta.url);

function completeEnv(overrides = {}) {
  return {
    PATH: process.env.PATH,
    BILLING_PROVIDER: "dodo",
    DODO_PAYMENTS_ENVIRONMENT: "test_mode",
    DODO_PAYMENTS_API_KEY: "test_api_key",
    DODO_PAYMENTS_WEBHOOK_KEY: "whsec_ZXhhbXBsZQ==",
    DODO_PAYMENTS_PRODUCT_ID_LAUNCH_MONTHLY: "pdt_launch",
    DODO_PAYMENTS_PRODUCT_ID_GROWTH_MONTHLY: "pdt_growth",
    DODO_PAYMENTS_PRODUCT_ID_SCALE_MONTHLY: "pdt_scale",
    MAILCHIMP_CLIENT_ID: "mailchimp-id",
    MAILCHIMP_CLIENT_SECRET: "mailchimp-secret",
    CONVERTKIT_CLIENT_ID: "kit-id",
    CONVERTKIT_CLIENT_SECRET: "kit-secret",
    OAUTH_REDIRECT_URI: "https://staging.example.test/oauth/callback",
    POSTWAVE_MIGRATION_SESSION_KEK: "k".repeat(32),
    SHOPIFY_CLIENT_ID: "shopify-id",
    SHOPIFY_CLIENT_SECRET: "shopify-secret",
    SHOPIFY_OAUTH_REDIRECT_URL: "https://staging.example.test/shopify/callback",
    SHOPIFY_STATE_SECRET: "s".repeat(32),
    SHOPIFY_WEBHOOK_SECRET: "shopify-webhook-secret",
    GEMINI_API_KEY: "gemini-key",
    DIAGNOSTIAN_PROMPTS_PATH: undefined,
    DIAGNOSTICIAN_PROMPTS_PATH: "/tmp/prompts.json",
    DIAGNOSTICIAN_EVAL_CASES_PATH: "/tmp/evals.json",
    HCTI_USER_ID: "hcti-user",
    HCTI_API_KEY: "hcti-key",
    SEEDLIST_CONNECTOR: "imap",
    SEEDLIST_CONFIG_PATH: "/tmp/seedlist.json",
    DMARC_IMAP_HOST: "imap.example.test",
    DMARC_IMAP_USER: "dmarc@example.test",
    DMARC_IMAP_PASSWORD: "mailbox-secret",
    POSTWAVE_AUTH_FROM_ADDRESS: "auth@example.test",
    POSTWAVE_MAILER: "postmark",
    POSTMARK_ACCOUNT_TOKEN: "postmark-token",
    DKIM_ROOT_DOMAIN: "example.test",
    POSTWAVE_PUBLIC_BASE_URL: "https://staging.example.test",
    SMS_DEFAULT_PROVIDER: "twilio",
    TWILIO_ACCOUNT_SID: "ACexample",
    TWILIO_AUTH_TOKEN: "twilio-token",
    TWILIO_WEBHOOK_AUTH_TOKEN: "twilio-webhook-token",
    TWILIO_STATUS_CALLBACK_URL: "https://staging.example.test/sms/twilio/status",
    TWILIO_FROM_NUMBER: "+15555550123",
    ...overrides,
  };
}

function run(env) {
  return spawnSync(process.execPath, [script.pathname, "--strict"], {
    cwd: new URL("../..", import.meta.url),
    env: Object.fromEntries(Object.entries(env).filter(([, value]) => value !== undefined)),
    encoding: "utf8",
  });
}

test("strict mode accepts a complete documented rehearsal environment", () => {
  const result = run(completeEnv());
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /Provider rehearsal preflight passed in strict mode/);
});

test("strict mode requires every runbook input that was previously omitted", () => {
  const result = run(
    completeEnv({
      DODO_PAYMENTS_PRODUCT_ID_SCALE_MONTHLY: undefined,
      OAUTH_REDIRECT_URI: undefined,
      POSTWAVE_MIGRATION_SESSION_KEK: undefined,
      SHOPIFY_STATE_SECRET: undefined,
      DKIM_ROOT_DOMAIN: undefined,
      TWILIO_STATUS_CALLBACK_URL: undefined,
    }),
  );
  assert.equal(result.status, 1);
  for (const key of [
    "DODO_PAYMENTS_PRODUCT_ID_SCALE_MONTHLY",
    "OAUTH_REDIRECT_URI",
    "POSTWAVE_MIGRATION_SESSION_KEK",
    "SHOPIFY_STATE_SECRET",
    "DKIM_ROOT_DOMAIN",
    "TWILIO_STATUS_CALLBACK_URL",
  ]) {
    assert.match(result.stdout, new RegExp(key));
  }
});

test("strict mode rejects duplicate Dodo Payments products", () => {
  const result = run(completeEnv({ DODO_PAYMENTS_PRODUCT_ID_SCALE_MONTHLY: "pdt_growth" }));
  assert.equal(result.status, 1);
  assert.match(result.stdout, /must be distinct/);
});

test("strict mode validates conditional seed-list and selected SMS provider inputs", () => {
  const result = run(
    completeEnv({
      SEEDLIST_CONNECTOR: "vendor",
      SEEDLIST_VENDOR_API_URL: undefined,
      SMS_DEFAULT_PROVIDER: "telnyx",
    }),
  );
  assert.equal(result.status, 1);
  assert.match(result.stdout, /SEEDLIST_VENDOR_API_URL is required/);
  assert.match(result.stdout, /selected telnyx provider option/);
  assert.match(result.stdout, /TELNYX_API_KEY/);
});
