// SPDX-License-Identifier: AGPL-3.0-only

import { validateWebEnv } from "./env-schema.mjs";

const REQUIRED_BUILD_VALUES = Object.freeze({
  NODE_ENV: "production",
  POSTWAVE_ENV: "production",
  NEXT_PUBLIC_POSTWAVE_ENV: "production",
});

// The reviewed production origins. They stay written out here because
// scripts/release/verify-aws-deployment-contracts.mjs reads them from this file.
const PRODUCTION_ORIGINS = Object.freeze({
  NEXT_PUBLIC_SITE_URL: "https://moosewave.com",
  NEXT_PUBLIC_APP_URL: "https://app.moosewave.com",
  NEXT_PUBLIC_DOCS_URL: "https://docs.moosewave.com",
  NEXT_PUBLIC_FORMS_ORIGIN: "https://forms.moosewave.com",
  NEXT_PUBLIC_WEB_VITALS_ENDPOINT:
    "https://api.moosewave.com/api/internal/web-vitals",
  NEXT_PUBLIC_POSTWAVE_API_BASE_URL: "https://api.moosewave.com",
});

// A non-production image (staging) sets POSTWAVE_WEB_CANONICAL_DOMAIN, and each
// origin is then required on that domain instead: https://app.moosewave.com
// becomes https://app.<domain>. Unset means moosewave.com, which reproduces the
// literals above exactly.
const CANONICAL_DOMAIN_VARIABLE = "POSTWAVE_WEB_CANONICAL_DOMAIN";
const PRODUCTION_DOMAIN = "moosewave.com";
// Two or more lowercase letter-digit-hyphen labels of 1-63 characters, ending in
// a label that starts with a letter (which also rules out IPv4 addresses).
// A scheme, port, path, userinfo, wildcard, or trailing dot cannot match.
const HOSTNAME_PATTERN =
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const MAX_HOSTNAME_LENGTH = 253;

// Moves the host of a production origin from moosewave.com (or a subdomain of
// it) onto `domain`, keeping any subdomain label and path.
function onCanonicalDomain(origin, domain) {
  const [, host, rest] = /^https:\/\/([^/]+)(.*)$/u.exec(origin) ?? [];
  if (host === PRODUCTION_DOMAIN) return `https://${domain}${rest}`;
  if (host?.endsWith(`.${PRODUCTION_DOMAIN}`)) {
    return `https://${host.slice(0, -PRODUCTION_DOMAIN.length)}${domain}${rest}`;
  }
  return origin;
}

const failures = [
  ...validateWebEnv(process.env, {
    productionLike: true,
    // Mobile association metadata is injected at container runtime. It is not
    // a browser-bundle build argument and must not be baked into image layers.
    productionDeployment: false,
  }).failures,
];

for (const [name, expected] of Object.entries(REQUIRED_BUILD_VALUES)) {
  if (process.env[name] !== expected) {
    failures.push(
      `${name} must be exactly ${expected} for the canonical image.`,
    );
  }
}

const canonicalDomain =
  process.env[CANONICAL_DOMAIN_VARIABLE] ?? PRODUCTION_DOMAIN;
if (
  canonicalDomain.length <= MAX_HOSTNAME_LENGTH &&
  HOSTNAME_PATTERN.test(canonicalDomain)
) {
  for (const [name, origin] of Object.entries(PRODUCTION_ORIGINS)) {
    const expected = onCanonicalDomain(origin, canonicalDomain);
    if (process.env[name] !== expected) {
      failures.push(
        `${name} must be exactly ${expected} for the canonical image.`,
      );
    }
  }
} else {
  // An unusable domain gives no origins to compare against; this failure is
  // the one to fix.
  failures.push(
    `${CANONICAL_DOMAIN_VARIABLE} must be a lowercase hostname such as staging.example.com, with no scheme, port, path, or trailing dot (got ${JSON.stringify(canonicalDomain)}).`,
  );
}

const release = process.env.POSTWAVE_RELEASE ?? "";
if (!/^[0-9a-f]{40}$/.test(release)) {
  failures.push(
    "POSTWAVE_RELEASE must be a full lowercase 40-character Git SHA.",
  );
}
if (process.env.NEXT_PUBLIC_POSTWAVE_RELEASE !== release) {
  failures.push(
    "NEXT_PUBLIC_POSTWAVE_RELEASE must equal POSTWAVE_RELEASE so client and server telemetry identify the same artifact.",
  );
}

if (
  process.env.NEXT_PUBLIC_POSTHOG_KEY &&
  !process.env.NEXT_PUBLIC_POSTHOG_HOST
) {
  failures.push(
    "NEXT_PUBLIC_POSTHOG_HOST is required when NEXT_PUBLIC_POSTHOG_KEY is set.",
  );
}

if (!process.env.NEXT_PUBLIC_POSTWAVE_ASSETS_BASE_URL) {
  failures.push(
    "NEXT_PUBLIC_POSTWAVE_ASSETS_BASE_URL is required and must match the API asset CDN base.",
  );
}

if (!process.env.NEXT_PUBLIC_POSTWAVE_UPLOAD_ORIGIN) {
  failures.push(
    "NEXT_PUBLIC_POSTWAVE_UPLOAD_ORIGIN is required and must match the production presigned-upload bucket origin.",
  );
}

if (
  !/^pwk_[0-9a-f]{48}$/.test(
    process.env.NEXT_PUBLIC_POSTWAVE_CONSENT_SITE_KEY ?? "",
  )
) {
  failures.push(
    "NEXT_PUBLIC_POSTWAVE_CONSENT_SITE_KEY must be a live lowercase pwk_ key with 48 hexadecimal characters, bound to the reviewed production tenant.",
  );
}

if (failures.length > 0) {
  process.stderr.write(
    `[postwave/web container build] invalid production inputs:\n- ${failures.join("\n- ")}\n`,
  );
  process.exit(1);
}

process.stdout.write(
  `[postwave/web container build] canonical inputs verified for ${release} on ${canonicalDomain}\n`,
);
