// SPDX-License-Identifier: AGPL-3.0-only
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const script = path.resolve("scripts/check-container-build-env.mjs");
const release = "0123456789abcdef0123456789abcdef01234567";
const canonical = {
  NODE_ENV: "production",
  POSTWAVE_ENV: "production",
  NEXT_PUBLIC_POSTWAVE_ENV: "production",
  NEXT_PUBLIC_SITE_URL: "https://moosewave.com",
  NEXT_PUBLIC_APP_URL: "https://app.moosewave.com",
  NEXT_PUBLIC_DOCS_URL: "https://docs.moosewave.com",
  NEXT_PUBLIC_FORMS_ORIGIN: "https://forms.moosewave.com",
  NEXT_PUBLIC_POSTWAVE_ASSETS_BASE_URL: "https://assets.moosewave.com",
  NEXT_PUBLIC_POSTWAVE_UPLOAD_ORIGIN:
    "https://postwave-uploads-prod.s3.us-west-2.amazonaws.com",
  NEXT_PUBLIC_WEB_VITALS_ENDPOINT:
    "https://api.moosewave.com/api/internal/web-vitals",
  NEXT_PUBLIC_POSTWAVE_CONSENT_SITE_KEY:
    "pwk_0123456789abcdef0123456789abcdef0123456789abcdef",
  NEXT_PUBLIC_POSTWAVE_API_BASE_URL: "https://api.moosewave.com",
  POSTWAVE_RELEASE: release,
  NEXT_PUBLIC_POSTWAVE_RELEASE: release,
} satisfies NodeJS.ProcessEnv;

// The six browser origins the gate requires on the canonical domain.
const pinnedOrigins = [
  "NEXT_PUBLIC_SITE_URL",
  "NEXT_PUBLIC_APP_URL",
  "NEXT_PUBLIC_DOCS_URL",
  "NEXT_PUBLIC_FORMS_ORIGIN",
  "NEXT_PUBLIC_WEB_VITALS_ENDPOINT",
  "NEXT_PUBLIC_POSTWAVE_API_BASE_URL",
] as const;

// Written out rather than derived, so the staging cases check the script's
// domain substitution instead of repeating it.
const stagingOrigins = {
  ...canonical,
  NEXT_PUBLIC_SITE_URL: "https://staging.moosewave.com",
  NEXT_PUBLIC_APP_URL: "https://app.staging.moosewave.com",
  NEXT_PUBLIC_DOCS_URL: "https://docs.staging.moosewave.com",
  NEXT_PUBLIC_FORMS_ORIGIN: "https://forms.staging.moosewave.com",
  NEXT_PUBLIC_POSTWAVE_ASSETS_BASE_URL: "https://assets.staging.moosewave.com",
  NEXT_PUBLIC_POSTWAVE_UPLOAD_ORIGIN:
    "https://postwave-staging-uploads.s3.us-west-2.amazonaws.com",
  NEXT_PUBLIC_WEB_VITALS_ENDPOINT:
    "https://api.staging.moosewave.com/api/internal/web-vitals",
  NEXT_PUBLIC_POSTWAVE_API_BASE_URL: "https://api.staging.moosewave.com",
} satisfies NodeJS.ProcessEnv;
const staging = {
  ...stagingOrigins,
  POSTWAVE_WEB_CANONICAL_DOMAIN: "staging.moosewave.com",
} satisfies NodeJS.ProcessEnv;

// The full build environment for each canonical domain the gate is exercised on.
const imageEnvByDomain = {
  "moosewave.com": canonical,
  "staging.moosewave.com": staging,
} as const;

// The canonical domain plus all six pinned origins moved onto it.
function onDomain(domain: string) {
  return {
    POSTWAVE_WEB_CANONICAL_DOMAIN: domain,
    NEXT_PUBLIC_SITE_URL: `https://${domain}`,
    NEXT_PUBLIC_APP_URL: `https://app.${domain}`,
    NEXT_PUBLIC_DOCS_URL: `https://docs.${domain}`,
    NEXT_PUBLIC_FORMS_ORIGIN: `https://forms.${domain}`,
    NEXT_PUBLIC_WEB_VITALS_ENDPOINT: `https://api.${domain}/api/internal/web-vitals`,
    NEXT_PUBLIC_POSTWAVE_API_BASE_URL: `https://api.${domain}`,
  } satisfies Partial<NodeJS.ProcessEnv>;
}

// The longest name DNS allows: 63 + 1 + 63 + 1 + 63 + 1 + 61 = 253 characters,
// every label within the 63-character limit.
const longestDomain = `${["a", "b", "c"].map((letter) => letter.repeat(63)).join(".")}.${"d".repeat(61)}`;

// Logical Dockerfile instructions: comment lines are dropped, so prose cannot
// satisfy an assertion, and backslash continuations are joined.
function dockerInstructions(source: string): string[] {
  const instructions: string[] = [];
  let pending = "";
  for (const line of source.split(/\r?\n/u)) {
    if (/^\s*#/u.test(line)) continue;
    const continued = line.endsWith("\\");
    pending += `${continued ? line.slice(0, -1) : line} `;
    if (continued) continue;
    const instruction = pending.trim().replace(/\s+/gu, " ");
    if (instruction) instructions.push(instruction);
    pending = "";
  }
  return instructions;
}

function check(overrides: Partial<NodeJS.ProcessEnv> = {}) {
  return spawnSync(process.execPath, [script], {
    cwd: path.resolve("."),
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      ...canonical,
      ...overrides,
    },
  });
}

describe("canonical web container build inputs", () => {
  it("accepts the reviewed production origins and immutable release id", () => {
    const result = check();

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`canonical inputs verified for ${release}`);
  });

  it("keeps the external web-vitals endpoint paired with exact API CORS origins", () => {
    const task = JSON.parse(
      readFileSync(
        path.resolve("../..", "infra/aws/ecs-task-definition.json"),
        "utf8",
      ),
    ) as {
      containerDefinitions: Array<{
        environment: Array<{ name: string; value: string }>;
      }>;
    };
    const apiEnv = new Map(
      task.containerDefinitions[0].environment.map(({ name, value }) => [
        name,
        value,
      ]),
    );
    const allowedOrigins = (
      apiEnv.get("POSTWAVE_WEB_VITALS_ALLOWED_ORIGINS") ?? ""
    ).split(",");

    expect(new URL(canonical.NEXT_PUBLIC_WEB_VITALS_ENDPOINT).origin).toBe(
      "https://api.moosewave.com",
    );
    expect(new Set(allowedOrigins)).toEqual(
      new Set([
        new URL(canonical.NEXT_PUBLIC_SITE_URL).origin,
        new URL(canonical.NEXT_PUBLIC_APP_URL).origin,
      ]),
    );
    expect(apiEnv.get("POSTWAVE_WEB_VITALS_ALLOWED_ORIGINS")).toBe(
      apiEnv.get("CORS_ALLOWED_ORIGINS"),
    );
    expect(allowedOrigins).not.toContain("*");
  });

  it("keeps local telemetry on the mounted same-origin proxy path", () => {
    const localExample = readFileSync(
      path.resolve("../..", ".env.local.example"),
      "utf8",
    );
    expect(localExample).toMatch(
      /^NEXT_PUBLIC_WEB_VITALS_ENDPOINT=\/api\/internal\/web-vitals$/mu,
    );
    expect(localExample).not.toMatch(
      /^NEXT_PUBLIC_WEB_VITALS_ENDPOINT=\/api\/web-vitals$/mu,
    );
  });

  it("rejects missing release identity and deployment-origin drift", () => {
    const result = check({
      POSTWAVE_RELEASE: "",
      NEXT_PUBLIC_POSTWAVE_RELEASE: "",
      NEXT_PUBLIC_APP_URL: "https://postwave.example",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "POSTWAVE_RELEASE must be a full lowercase",
    );
    expect(result.stderr).toContain(
      "NEXT_PUBLIC_APP_URL must be exactly https://app.moosewave.com",
    );
  });

  it("rejects browser API bypasses and production mock flags", () => {
    const result = check({
      NEXT_PUBLIC_API_URL: "https://api.moosewave.com",
      NEXT_PUBLIC_USE_MOCKS: "1",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("NEXT_PUBLIC_API_URL must stay unset");
    expect(result.stderr).toContain("NEXT_PUBLIC_USE_MOCKS=1 is dev-only");
  });

  it("requires the hosted preview CDN base at build time", () => {
    const result = check({
      NEXT_PUBLIC_POSTWAVE_ASSETS_BASE_URL: "",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "NEXT_PUBLIC_POSTWAVE_ASSETS_BASE_URL is required",
    );
  });

  it("requires the exact direct-upload CSP origin at build time", () => {
    const result = check({ NEXT_PUBLIC_POSTWAVE_UPLOAD_ORIGIN: "" });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "NEXT_PUBLIC_POSTWAVE_UPLOAD_ORIGIN is required",
    );
  });

  it("requires the tenant-bound consent evidence destination", () => {
    const missing = check({
      NEXT_PUBLIC_POSTWAVE_CONSENT_SITE_KEY: "",
      NEXT_PUBLIC_POSTWAVE_API_BASE_URL: "",
    });

    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain(
      "NEXT_PUBLIC_POSTWAVE_CONSENT_SITE_KEY must be a live lowercase pwk_ key",
    );
    expect(missing.stderr).toContain(
      "NEXT_PUBLIC_POSTWAVE_API_BASE_URL must be exactly https://api.moosewave.com",
    );

    const malformed = check({
      NEXT_PUBLIC_POSTWAVE_CONSENT_SITE_KEY: "pwk_not-a-live-key",
    });
    expect(malformed.status).toBe(1);
    expect(malformed.stderr).toContain(
      "NEXT_PUBLIC_POSTWAVE_CONSENT_SITE_KEY must be a live lowercase pwk_ key",
    );
  });

  it("uses render-safe system fonts without a build-time font request", () => {
    const layout = readFileSync(path.resolve("src/app/layout.tsx"), "utf8");
    const globalStyles = readFileSync(
      path.resolve("src/app/globals.css"),
      "utf8",
    );
    expect(layout).not.toContain("next/font/google");
    expect(layout).not.toContain("@fontsource-variable");
    expect(globalStyles).toContain("--font-inter: ui-sans-serif");
    expect(globalStyles).toContain("--font-display: Georgia");
  });
});

describe("canonical domain for non-production images", () => {
  it("defaults to moosewave.com, so staging origins alone are still rejected", () => {
    const result = check(stagingOrigins);

    expect(result.status).toBe(1);
    for (const name of pinnedOrigins) {
      expect(result.stderr).toContain(
        `${name} must be exactly ${canonical[name]} for the canonical image.`,
      );
    }
  });

  it("accepts moosewave.com passed explicitly, as the Dockerfile default does", () => {
    const result = check({ POSTWAVE_WEB_CANONICAL_DOMAIN: "moosewave.com" });

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      `canonical inputs verified for ${release} on moosewave.com`,
    );
  });

  it("accepts every origin moved onto the configured domain", () => {
    const result = check(staging);

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      `canonical inputs verified for ${release} on staging.moosewave.com`,
    );
  });

  it.each(pinnedOrigins)(
    "rejects a staging image whose %s still names moosewave.com",
    (name) => {
      const result = check({ ...staging, [name]: canonical[name] });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        `${name} must be exactly ${staging[name]} for the canonical image.`,
      );
      for (const other of pinnedOrigins.filter((pinned) => pinned !== name)) {
        expect(result.stderr).not.toContain(`${other} must be exactly`);
      }
    },
  );

  // Each origin must equal its expected value as a whole string. A value that
  // only starts or ends with it names another host, port, path, or query, so a
  // prefix, suffix, substring, or case-insensitive comparison would admit it.
  it.each([
    {
      domain: "moosewave.com",
      name: "NEXT_PUBLIC_APP_URL",
      value: "https://app.moosewave.com.attacker.example",
    },
    {
      domain: "moosewave.com",
      name: "NEXT_PUBLIC_POSTWAVE_API_BASE_URL",
      value: "https://api.moosewave.com/",
    },
    {
      domain: "staging.moosewave.com",
      name: "NEXT_PUBLIC_APP_URL",
      value: "https://app.staging.moosewave.com.attacker.example",
    },
    {
      domain: "staging.moosewave.com",
      name: "NEXT_PUBLIC_POSTWAVE_API_BASE_URL",
      value: "https://api.staging.moosewave.com/",
    },
    {
      domain: "staging.moosewave.com",
      name: "NEXT_PUBLIC_POSTWAVE_API_BASE_URL",
      value: "https://api.staging.moosewave.com/anything",
    },
    {
      domain: "staging.moosewave.com",
      name: "NEXT_PUBLIC_SITE_URL",
      value: "https://staging.moosewave.com:8443",
    },
    {
      domain: "staging.moosewave.com",
      name: "NEXT_PUBLIC_WEB_VITALS_ENDPOINT",
      value: "https://api.staging.moosewave.com/api/internal/web-vitals?next=1",
    },
    {
      domain: "staging.moosewave.com",
      name: "NEXT_PUBLIC_FORMS_ORIGIN",
      value: "https://attacker.example/https://forms.staging.moosewave.com",
    },
    {
      domain: "staging.moosewave.com",
      name: "NEXT_PUBLIC_DOCS_URL",
      value: " https://docs.staging.moosewave.com",
    },
    {
      domain: "staging.moosewave.com",
      name: "NEXT_PUBLIC_APP_URL",
      value: "https://APP.staging.moosewave.com",
    },
  ] as const)("rejects $name=$value on $domain", ({ domain, name, value }) => {
    const env = imageEnvByDomain[domain];
    const result = check({ ...env, [name]: value });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      `${name} must be exactly ${env[name]} for the canonical image.`,
    );
    for (const other of pinnedOrigins.filter((pinned) => pinned !== name)) {
      expect(result.stderr).not.toContain(`${other} must be exactly`);
    }
  });

  it.each(["eu-2.staging.example.org", "xn--bcher-kva.example"])(
    "accepts %s as a canonical domain",
    (domain) => {
      const result = check(onDomain(domain));

      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
    },
  );

  it("accepts a canonical domain of exactly 253 characters", () => {
    expect(longestDomain).toHaveLength(253);
    const result = check(onDomain(longestDomain));

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });

  it("rejects a canonical domain of 254 characters even with every origin on it", () => {
    // One more letter in the last label: still within 63, so only the overall
    // length can reject it.
    const tooLong = `${longestDomain}d`;
    expect(tooLong).toHaveLength(254);
    const result = check(onDomain(tooLong));

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "POSTWAVE_WEB_CANONICAL_DOMAIN must be a lowercase hostname",
    );
    expect(result.stderr).not.toContain("must be exactly");
  });

  it.each([
    ["an empty value", ""],
    ["a scheme", "https://staging.moosewave.com"],
    ["a path", "staging.moosewave.com/app"],
    ["a port", "staging.moosewave.com:443"],
    ["userinfo", "ops@staging.moosewave.com"],
    ["uppercase letters", "Staging.Moosewave.com"],
    ["surrounding whitespace", " staging.moosewave.com"],
    ["a trailing newline", "staging.moosewave.com\n"],
    ["a trailing dot", "staging.moosewave.com."],
    ["a single label", "localhost"],
    ["an empty label", "staging..moosewave.com"],
    ["a label starting with a hyphen", "-staging.moosewave.com"],
    ["a label ending with a hyphen", "staging-.moosewave.com"],
    ["an underscore", "staging_web.moosewave.com"],
    ["a wildcard", "*.moosewave.com"],
    ["an IPv4 address", "192.0.2.10"],
    ["a label over 63 characters", `${"a".repeat(64)}.moosewave.com`],
    ["a name over 253 characters", `${"a".repeat(60)}.`.repeat(5) + "com"],
  ])("rejects a canonical domain with %s", (_case, domain) => {
    const result = check({
      ...stagingOrigins,
      POSTWAVE_WEB_CANONICAL_DOMAIN: domain,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "POSTWAVE_WEB_CANONICAL_DOMAIN must be a lowercase hostname",
    );
    // An unusable domain yields no expected origins, so none are reported.
    expect(result.stderr).not.toContain("must be exactly");
  });

  it("keeps moosewave.com as the image default and exports it to the build gate", () => {
    const instructions = dockerInstructions(
      readFileSync(path.resolve("Dockerfile"), "utf8"),
    );
    const stageStarts = instructions.flatMap((instruction, index) =>
      instruction.startsWith("FROM ") ? [index] : [],
    );
    expect(stageStarts).toHaveLength(2);
    const buildStage = instructions.slice(stageStarts[0], stageStarts[1]);

    const declarations = buildStage.filter((instruction) =>
      /^ARG POSTWAVE_WEB_CANONICAL_DOMAIN\b/u.test(instruction),
    );
    expect(declarations).toEqual([
      "ARG POSTWAVE_WEB_CANONICAL_DOMAIN=moosewave.com",
    ]);
    const declared = buildStage.indexOf(declarations[0]);
    const exported = buildStage.findIndex(
      (instruction) =>
        instruction.startsWith("ENV ") &&
        instruction
          .split(" ")
          .includes(
            "POSTWAVE_WEB_CANONICAL_DOMAIN=${POSTWAVE_WEB_CANONICAL_DOMAIN}",
          ),
    );
    const gate = buildStage.findIndex((instruction) =>
      instruction.startsWith(
        "RUN node apps/web/scripts/check-container-build-env.mjs ",
      ),
    );

    expect(exported).toBeGreaterThan(declared);
    expect(gate).toBeGreaterThan(exported);
  });

  it("leaves the production image workflow on the moosewave.com default", () => {
    // A build argument, even one with no value (which Docker fills from the
    // builder's environment), would move the production gate off the reviewed
    // origins. Only the staging build scripts may pass it.
    const workflow = readFileSync(
      path.resolve("../..", ".github/workflows/docker-push.yml"),
      "utf8",
    );

    expect(workflow).toContain("dockerfile: apps/web/Dockerfile");
    expect(workflow).not.toContain("POSTWAVE_WEB_CANONICAL_DOMAIN");
  });
});
