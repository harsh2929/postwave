// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENV_EXAMPLE = path.join(__dirname, "../.env.example");

const OPTIONAL_STRING = z.preprocess((value) => {
  if (value === undefined || value === null) return undefined;
  const text = String(value).trim();
  return text === "" ? undefined : text;
}, z.string().optional());

export const WEB_ENV_DEFINITIONS = Object.freeze([
  { name: "NODE_ENV", kind: "string", documented: false },
  { name: "CI", kind: "ciFlag", documented: false },
  { name: "VERCEL_ENV", kind: "string", documented: false },
  { name: "NEXT_RUNTIME", kind: "string", documented: false },
  { name: "POSTWAVE_NEXT_DIST_DIR", kind: "nextDistDir", documented: false },

  { name: "API_URL", kind: "baseUrl" },
  { name: "POSTWAVE_API_URL", kind: "baseUrl" },
  { name: "NEXT_PUBLIC_API_URL", kind: "baseUrl" },
  { name: "NEXT_PUBLIC_SITE_URL", kind: "baseUrl" },
  { name: "NEXT_PUBLIC_DOCS_URL", kind: "baseUrl" },
  { name: "NEXT_PUBLIC_APP_URL", kind: "baseUrl" },
  { name: "NEXT_PUBLIC_FORMS_ORIGIN", kind: "baseUrl" },
  { name: "NEXT_PUBLIC_POSTWAVE_ASSETS_BASE_URL", kind: "baseUrl" },
  // Exact origin that public form uploads PUT to. Production requires it so
  // CSP never needs a provider-wide wildcard.
  { name: "NEXT_PUBLIC_POSTWAVE_UPLOAD_ORIGIN", kind: "baseUrl" },
  // Build-time only. Feeds the service worker's /offline precache revision so
  // each deploy re-fetches that document instead of serving the copy the very
  // first install cached, which referenced CSS hashes that no longer exist.
  { name: "POSTWAVE_BUILD_ID", kind: "string" },

  { name: "POSTWAVE_TENANT_SLUG", kind: "string" },
  { name: "NEXT_PUBLIC_TENANT_SLUG", kind: "string" },
  { name: "NEXT_PUBLIC_POSTWAVE_TENANT_SLUG", kind: "string" },

  { name: "NEXT_PUBLIC_USE_MOCKS", kind: "flag" },
  { name: "POSTWAVE_AUTH_BYPASS", kind: "flag" },
  { name: "POSTWAVE_LOCAL_AUTH_BYPASS", kind: "flag" },
  { name: "NEXT_PUBLIC_ENABLE_COMPAT_DEMO_ACTIONS", kind: "flag" },
  { name: "NEXT_PUBLIC_SHOW_HEALTH_DEBUG", kind: "flag" },
  // Feature toggles read at runtime: gate discount mutations + public
  // self-serve checkout until their backends ship. Registered here so the
  // env-contract test (code reads must be declared) stays green.
  { name: "NEXT_PUBLIC_DISCOUNT_MUTATIONS_ENABLED", kind: "flag" },
  { name: "NEXT_PUBLIC_ENABLE_PUBLIC_CHECKOUT", kind: "flag" },
  { name: "NEXT_PUBLIC_ENABLE_CAMPAIGN_CONTENT_AST_V2", kind: "flag" },

  { name: "NEXT_PUBLIC_API_TIMEOUT_MS", kind: "positiveInt", min: 1_000 },
  { name: "POSTWAVE_API_PROXY_TIMEOUT_MS", kind: "positiveInt", min: 1_000 },
  { name: "POSTWAVE_API_STREAM_TIMEOUT_MS", kind: "positiveInt", min: 30_000 },
  { name: "POSTWAVE_API_EXPORT_TIMEOUT_MS", kind: "positiveInt", min: 60_000 },
  {
    name: "POSTWAVE_API_PROXY_MAX_BODY_BYTES",
    kind: "positiveInt",
    min: 1 * 1024 * 1024,
  },
  { name: "POSTWAVE_PUBLIC_PAGE_TIMEOUT_MS", kind: "positiveInt", min: 1_000 },
  {
    name: "NEXT_PUBLIC_PUBLIC_PAGE_TIMEOUT_MS",
    kind: "positiveInt",
    min: 1_000,
  },

  { name: "SENTRY_DSN_WEB", kind: "url" },
  { name: "NEXT_PUBLIC_SENTRY_DSN_WEB", kind: "url" },
  { name: "SENTRY_ORG", kind: "string" },
  { name: "SENTRY_PROJECT", kind: "string" },
  { name: "SENTRY_AUTH_TOKEN", kind: "secret" },
  { name: "POSTWAVE_ENV", kind: "string" },
  { name: "NEXT_PUBLIC_POSTWAVE_ENV", kind: "string" },
  { name: "POSTWAVE_RELEASE", kind: "string" },
  { name: "NEXT_PUBLIC_POSTWAVE_RELEASE", kind: "string" },
  { name: "POSTWAVE_PUBLIC_RELEASE_APPROVAL", kind: "releaseApproval" },
  { name: "POSTWAVE_LEGAL_PUBLICATION_APPROVAL", kind: "releaseApproval" },

  { name: "NEXT_PUBLIC_POSTHOG_KEY", kind: "string" },
  { name: "NEXT_PUBLIC_POSTHOG_HOST", kind: "url" },
  { name: "NEXT_PUBLIC_WEB_VITALS_ENDPOINT", kind: "endpoint" },

  { name: "NEXT_PUBLIC_ROADMAP_FORM_SLUG", kind: "string" },
  { name: "NEXT_PUBLIC_POSTWAVE_CONSENT_SITE_KEY", kind: "string" },
  { name: "NEXT_PUBLIC_POSTWAVE_API_BASE_URL", kind: "baseUrl" },
  { name: "NEXT_PUBLIC_VAPID_PUBLIC_KEY", kind: "string" },

  { name: "POSTWAVE_APPLE_TEAM_ID", kind: "string" },
  { name: "POSTWAVE_IOS_BUNDLE_ID", kind: "string" },
  { name: "POSTWAVE_ANDROID_PACKAGE_NAME", kind: "string" },
  { name: "POSTWAVE_ANDROID_SHA256_CERT_FINGERPRINTS", kind: "csv" },
]);

export const KNOWN_WEB_ENV_KEYS = Object.freeze(
  WEB_ENV_DEFINITIONS.map((definition) => definition.name),
);

export const DOCUMENTED_WEB_ENV_KEYS = Object.freeze(
  WEB_ENV_DEFINITIONS.filter(
    (definition) => definition.documented !== false,
  ).map((definition) => definition.name),
);

const DISALLOWED_PRODUCTION_FLAGS = Object.freeze([
  "NEXT_PUBLIC_USE_MOCKS",
  "POSTWAVE_AUTH_BYPASS",
  "POSTWAVE_LOCAL_AUTH_BYPASS",
  "NEXT_PUBLIC_ENABLE_COMPAT_DEMO_ACTIONS",
  "NEXT_PUBLIC_SHOW_HEALTH_DEBUG",
]);

const DISALLOWED_PRODUCTION_VALUES = Object.freeze([
  "POSTWAVE_TENANT_SLUG",
  "NEXT_PUBLIC_TENANT_SLUG",
  "NEXT_PUBLIC_POSTWAVE_TENANT_SLUG",
]);

const REQUIRED_PRODUCTION_DEPLOYMENT_VALUES = Object.freeze([
  "POSTWAVE_APPLE_TEAM_ID",
  "POSTWAVE_ANDROID_SHA256_CERT_FINGERPRINTS",
]);

function envValue(env, name) {
  return OPTIONAL_STRING.parse(env[name]);
}

function isLocalHTTPHost(hostname) {
  return (
    hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1"
  );
}

function flagSchema(name) {
  return OPTIONAL_STRING.superRefine((value, ctx) => {
    if (value !== undefined && value !== "0" && value !== "1") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${name} must be 0 or 1.`,
      });
    }
  });
}

function ciFlagSchema(name) {
  return OPTIONAL_STRING.superRefine((value, ctx) => {
    if (
      value !== undefined &&
      !["0", "1", "true", "false"].includes(value.toLowerCase())
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${name} must be true, false, 0, or 1.`,
      });
    }
  });
}

function nextDistDirSchema(name) {
  return OPTIONAL_STRING.superRefine((value, ctx) => {
    if (value === undefined) return;
    if (
      value !== ".next" &&
      !/^\.next-[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${name} must be .next or a simple app-local .next-* directory name.`,
      });
    }
  });
}

function positiveIntSchema(name, min) {
  return OPTIONAL_STRING.superRefine((value, ctx) => {
    if (value === undefined) return;
    if (!/^\d+$/.test(value)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${name} must be a whole number.`,
      });
      return;
    }
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < min) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${name} must be at least ${min}.`,
      });
    }
  });
}

function urlSchema(
  name,
  { base = false, noCredentials = false, noHash = false } = {},
) {
  return OPTIONAL_STRING.superRefine((value, ctx) => {
    if (value === undefined) return;
    if (/[\u0000-\u001f\u007f]/.test(value)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${name} must not contain control characters.`,
      });
      return;
    }
    let parsed;
    try {
      parsed = new URL(value);
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${name} must be a valid URL.`,
      });
      return;
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${name} must use http(s).`,
      });
    }
    if (parsed.protocol === "http:" && !isLocalHTTPHost(parsed.hostname)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${name} must use https outside local development.`,
      });
    }
    if ((base || noCredentials) && (parsed.username || parsed.password)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${name} must not include credentials.`,
      });
    }
    if (base && (parsed.search || parsed.hash)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${name} must not include a query string or fragment.`,
      });
    }
    if (noHash && parsed.hash) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${name} must not include a fragment.`,
      });
    }
  });
}

function endpointSchema(name) {
  return OPTIONAL_STRING.superRefine((value, ctx) => {
    if (value === undefined) return;
    if (/[\u0000-\u001f\u007f]/.test(value)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${name} must not contain control characters.`,
      });
      return;
    }
    if (value.startsWith("/")) {
      if (value.startsWith("//")) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${name} must be a path or an http(s) URL.`,
        });
      }
      return;
    }
    const absolute = urlSchema(name, {
      noCredentials: true,
      noHash: true,
    }).safeParse(value);
    if (!absolute.success) {
      for (const issue of absolute.error.issues) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: issue.message,
        });
      }
    }
  });
}

function csvSchema(name) {
  return OPTIONAL_STRING.superRefine((value, ctx) => {
    if (value === undefined) return;
    const values = value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
    if (values.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${name} must include at least one comma-separated value.`,
      });
    }
  });
}

function releaseApprovalSchema(name) {
  return OPTIONAL_STRING.superRefine((value, ctx) => {
    if (value === undefined) return;
    if (!/^approved:[A-Za-z0-9][A-Za-z0-9._/-]{5,127}$/.test(value)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${name} must be empty or approved:<release-record-reference> using 6-128 safe characters.`,
      });
    }
  });
}

function schemaFor(definition) {
  switch (definition.kind) {
    case "flag":
      return flagSchema(definition.name);
    case "ciFlag":
      return ciFlagSchema(definition.name);
    case "nextDistDir":
      return nextDistDirSchema(definition.name);
    case "positiveInt":
      return positiveIntSchema(definition.name, definition.min);
    case "baseUrl":
      return urlSchema(definition.name, { base: true });
    case "url":
      return urlSchema(definition.name);
    case "endpoint":
      return endpointSchema(definition.name);
    case "csv":
      return csvSchema(definition.name);
    case "releaseApproval":
      return releaseApprovalSchema(definition.name);
    default:
      return OPTIONAL_STRING;
  }
}

export const WEB_ENV_SCHEMA = z
  .object(
    Object.fromEntries(
      WEB_ENV_DEFINITIONS.map((definition) => [
        definition.name,
        schemaFor(definition),
      ]),
    ),
  )
  .passthrough();

export function isProductionLike(env) {
  return (
    envValue(env, "NODE_ENV") === "production" ||
    envValue(env, "CI") === "true" ||
    envValue(env, "CI") === "1" ||
    envValue(env, "VERCEL_ENV") === "production" ||
    envValue(env, "POSTWAVE_ENV") === "production" ||
    envValue(env, "NEXT_PUBLIC_POSTWAVE_ENV") === "production"
  );
}

export function isProductionDeployment(env) {
  return (
    envValue(env, "NODE_ENV") === "production" ||
    envValue(env, "VERCEL_ENV") === "production" ||
    envValue(env, "POSTWAVE_ENV") === "production" ||
    envValue(env, "NEXT_PUBLIC_POSTWAVE_ENV") === "production"
  );
}

export function validateWebEnv(
  env,
  {
    productionLike = isProductionLike(env),
    productionDeployment = isProductionDeployment(env),
  } = {},
) {
  const failures = [];
  const parsed = WEB_ENV_SCHEMA.safeParse(env);

  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const name = issue.path[0] || "environment";
      failures.push(`${name}: ${issue.message}`);
    }
  }

  if (envValue(env, "NEXT_PUBLIC_POSTWAVE_CONSENT_SITE_KEY")) {
    if (!envValue(env, "NEXT_PUBLIC_POSTWAVE_API_BASE_URL")) {
      failures.push(
        "NEXT_PUBLIC_POSTWAVE_API_BASE_URL is required when NEXT_PUBLIC_POSTWAVE_CONSENT_SITE_KEY is set.",
      );
    }
  }

  if (productionLike) {
    for (const name of DISALLOWED_PRODUCTION_FLAGS) {
      if (envValue(env, name) === "1") {
        failures.push(
          `${name}=1 is dev-only and must not be set in production/CI.`,
        );
      }
    }

    for (const name of DISALLOWED_PRODUCTION_VALUES) {
      if (envValue(env, name)) {
        failures.push(
          `${name} is dev-only and must not be set in production/CI.`,
        );
      }
    }

    if (envValue(env, "NEXT_PUBLIC_API_URL")) {
      failures.push(
        "NEXT_PUBLIC_API_URL must stay unset for browser builds; app API calls must use the same-origin /api proxy.",
      );
    }
  }

  if (productionDeployment) {
    for (const name of REQUIRED_PRODUCTION_DEPLOYMENT_VALUES) {
      if (!envValue(env, name)) {
        failures.push(
          `${name} is required for production mobile app-link routes.`,
        );
      }
    }

    const consentSiteKey = envValue(
      env,
      "NEXT_PUBLIC_POSTWAVE_CONSENT_SITE_KEY",
    );
    if (!consentSiteKey) {
      failures.push(
        "NEXT_PUBLIC_POSTWAVE_CONSENT_SITE_KEY is required for production cookie-consent evidence delivery.",
      );
    } else if (!/^pwk_[0-9a-f]{48}$/.test(consentSiteKey)) {
      failures.push(
        "NEXT_PUBLIC_POSTWAVE_CONSENT_SITE_KEY must be a live lowercase pwk_ key with 48 hexadecimal characters in production.",
      );
    }

    if (!envValue(env, "NEXT_PUBLIC_POSTWAVE_API_BASE_URL")) {
      failures.push(
        "NEXT_PUBLIC_POSTWAVE_API_BASE_URL is required for production cookie-consent evidence delivery.",
      );
    }

    if (!envValue(env, "NEXT_PUBLIC_POSTWAVE_UPLOAD_ORIGIN")) {
      failures.push(
        "NEXT_PUBLIC_POSTWAVE_UPLOAD_ORIGIN is required for production direct-upload CSP allow-listing.",
      );
    }
  }

  return {
    ok: failures.length === 0,
    failures,
    productionLike,
  };
}

export function parseEnvExample(filePath = ENV_EXAMPLE) {
  const text = readFileSync(filePath, "utf8");
  const env = {};
  const keys = new Set();

  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*#?\s*([A-Z][A-Z0-9_]*)=(.*)$/);
    if (!match) continue;
    const key = match[1];
    keys.add(key);
    env[key] = match[2].trim();
  }

  return { env, keys };
}

export function validateEnvExample(filePath = ENV_EXAMPLE) {
  const { env, keys } = parseEnvExample(filePath);
  const failures = [...validateWebEnv(env, { productionLike: false }).failures];
  const known = new Set(KNOWN_WEB_ENV_KEYS);

  const missing = DOCUMENTED_WEB_ENV_KEYS.filter((key) => !keys.has(key));
  if (missing.length > 0) {
    failures.push(
      `.env.example is missing documented keys: ${missing.join(", ")}.`,
    );
  }

  const unknown = [...keys].filter((key) => !known.has(key));
  if (unknown.length > 0) {
    failures.push(
      `.env.example contains keys outside the env schema: ${unknown.join(", ")}.`,
    );
  }

  return {
    ok: failures.length === 0,
    failures,
  };
}
