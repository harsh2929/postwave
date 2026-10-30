// SPDX-License-Identifier: AGPL-3.0-only

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";
import ts from "typescript";

const CHECK_ENV = path.join(process.cwd(), "scripts/check-env.mjs");
const ENV_SCHEMA = path.join(process.cwd(), "scripts/env-schema.mjs");
type EnvOverrides = Record<string, string | undefined>;

function runEnvCheck(env: EnvOverrides, args: string[] = ["--current-only"]) {
  const childEnv: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    NODE_ENV: "test",
    ...env,
  };

  return spawnSync(process.execPath, [CHECK_ENV, ...args], {
    cwd: process.cwd(),
    env: childEnv,
    encoding: "utf8",
  });
}

function walkRuntimeFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const files: string[] = [];

  for (const entry of readdirSync(dir).sort()) {
    if (
      entry === "__tests__" ||
      entry === ".next" ||
      entry === "node_modules"
    ) {
      continue;
    }
    const filePath = path.join(dir, entry);
    const stat = statSync(filePath);
    if (stat.isDirectory()) {
      files.push(...walkRuntimeFiles(filePath));
    } else if (/\.(mjs|js|ts|tsx)$/.test(entry) && !entry.endsWith(".d.ts")) {
      files.push(filePath);
    }
  }

  return files;
}

function schemaKeys(): Set<string> {
  const source = readFileSync(ENV_SCHEMA, "utf8");
  return new Set(
    [...source.matchAll(/\{\s*name:\s*"([A-Z][A-Z0-9_]*)"/g)].map(
      (match) => match[1],
    ),
  );
}

function isProcessEnvExpression(node: ts.Expression): boolean {
  return (
    ts.isPropertyAccessExpression(node) &&
    node.name.text === "env" &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "process"
  );
}

function isStaticString(
  node: ts.Expression,
): node is ts.StringLiteral | ts.NoSubstitutionTemplateLiteral {
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node);
}

function collectDirectEnvReads(filePath: string): string[] {
  const source = readFileSync(filePath, "utf8");
  const kind = filePath.endsWith(".tsx")
    ? ts.ScriptKind.TSX
    : filePath.endsWith(".mjs") || filePath.endsWith(".js")
      ? ts.ScriptKind.JS
      : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(
    filePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    kind,
  );
  const keys = new Set<string>();

  function visit(node: ts.Node): void {
    if (
      ts.isPropertyAccessExpression(node) &&
      isProcessEnvExpression(node.expression)
    ) {
      keys.add(node.name.text);
    }
    if (
      ts.isElementAccessExpression(node) &&
      isProcessEnvExpression(node.expression) &&
      isStaticString(node.argumentExpression)
    ) {
      keys.add(node.argumentExpression.text);
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return [...keys].sort();
}

function runtimeEnvFiles(): string[] {
  return [
    ...walkRuntimeFiles(path.join(process.cwd(), "src")),
    ...[
      "next.config.mjs",
      "sentry.server.config.ts",
      "sentry.edge.config.ts",
      "scripts/check-env.mjs",
    ]
      .map((file) => path.join(process.cwd(), file))
      .filter(existsSync),
  ];
}

describe("web env contract", () => {
  it("keeps .env.example aligned with the schema", () => {
    const result = runEnvCheck({}, ["--example-only"]);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("[postwave/web env] ok");
  });

  it("allows GitHub's CI=true value while still applying CI bans", () => {
    const ok = runEnvCheck({ CI: "true" });

    expect(ok.status, ok.stderr).toBe(0);

    const blocked = runEnvCheck({
      CI: "true",
      NEXT_PUBLIC_USE_MOCKS: "1",
    });

    expect(blocked.status).toBe(1);
    expect(blocked.stderr).toContain("NEXT_PUBLIC_USE_MOCKS=1");
  });

  it("rejects production auth bypass and public API proxy bypass flags", () => {
    const result = runEnvCheck({
      NODE_ENV: "production",
      POSTWAVE_AUTH_BYPASS: "1",
      NEXT_PUBLIC_API_URL: "https://api.postwave.test",
      POSTWAVE_APPLE_TEAM_ID: "ABCDE12345",
      POSTWAVE_ANDROID_SHA256_CERT_FINGERPRINTS: "AA:BB:CC",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("POSTWAVE_AUTH_BYPASS=1");
    expect(result.stderr).toContain("NEXT_PUBLIC_API_URL must stay unset");
  });

  it("rejects production-only debug, demo, mock, and tenant escape hatches", () => {
    const result = runEnvCheck({
      NODE_ENV: "production",
      NEXT_PUBLIC_ENABLE_COMPAT_DEMO_ACTIONS: "1",
      NEXT_PUBLIC_SHOW_HEALTH_DEBUG: "1",
      NEXT_PUBLIC_USE_MOCKS: "1",
      NEXT_PUBLIC_TENANT_SLUG: "demo",
      POSTWAVE_APPLE_TEAM_ID: "ABCDE12345",
      POSTWAVE_ANDROID_SHA256_CERT_FINGERPRINTS: "AA:BB:CC",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("NEXT_PUBLIC_ENABLE_COMPAT_DEMO_ACTIONS=1");
    expect(result.stderr).toContain("NEXT_PUBLIC_SHOW_HEALTH_DEBUG=1");
    expect(result.stderr).toContain("NEXT_PUBLIC_USE_MOCKS=1");
    expect(result.stderr).toContain("NEXT_PUBLIC_TENANT_SLUG is dev-only");
  });

  it("requires mobile app-link metadata for production deployments", () => {
    const result = runEnvCheck({ NODE_ENV: "production" });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("POSTWAVE_APPLE_TEAM_ID is required");
    expect(result.stderr).toContain(
      "POSTWAVE_ANDROID_SHA256_CERT_FINGERPRINTS is required",
    );
  });

  it("requires a valid consent evidence destination for production deployments", () => {
    const missing = runEnvCheck({ NODE_ENV: "production" });

    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain(
      "NEXT_PUBLIC_POSTWAVE_CONSENT_SITE_KEY is required for production cookie-consent evidence delivery",
    );
    expect(missing.stderr).toContain(
      "NEXT_PUBLIC_POSTWAVE_API_BASE_URL is required for production cookie-consent evidence delivery",
    );
    expect(missing.stderr).toContain(
      "NEXT_PUBLIC_POSTWAVE_UPLOAD_ORIGIN is required for production direct-upload CSP allow-listing",
    );

    const malformed = runEnvCheck({
      NODE_ENV: "production",
      NEXT_PUBLIC_POSTWAVE_CONSENT_SITE_KEY: "pwk_not-a-live-key",
      NEXT_PUBLIC_POSTWAVE_API_BASE_URL: "https://api.moosewave.com",
    });
    expect(malformed.status).toBe(1);
    expect(malformed.stderr).toContain(
      "NEXT_PUBLIC_POSTWAVE_CONSENT_SITE_KEY must be a live lowercase pwk_ key with 48 hexadecimal characters in production",
    );
  });

  it("rejects malformed typed values", () => {
    const result = runEnvCheck({
      NEXT_PUBLIC_USE_MOCKS: "yes",
      POSTWAVE_API_PROXY_MAX_BODY_BYTES: "1024",
      NEXT_PUBLIC_WEB_VITALS_ENDPOINT: "javascript:alert(1)",
      POSTWAVE_PUBLIC_RELEASE_APPROVAL: "yes",
      POSTWAVE_NEXT_DIST_DIR: "/tmp/postwave-web-build",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("NEXT_PUBLIC_USE_MOCKS must be 0 or 1");
    expect(result.stderr).toContain(
      "POSTWAVE_API_PROXY_MAX_BODY_BYTES must be at least",
    );
    expect(result.stderr).toContain(
      "NEXT_PUBLIC_WEB_VITALS_ENDPOINT must use http(s)",
    );
    expect(result.stderr).toContain(
      "POSTWAVE_PUBLIC_RELEASE_APPROVAL must be empty or approved:",
    );
    expect(result.stderr).toContain(
      "POSTWAVE_NEXT_DIST_DIR must be .next or a simple app-local .next-* directory name",
    );
  });

  it("rejects public origins and endpoints that runtime helpers would discard", () => {
    const result = runEnvCheck({
      NEXT_PUBLIC_SITE_URL: "https://user:pass@moosewave.com",
      NEXT_PUBLIC_DOCS_URL: "https://docs.moosewave.com?x=1",
      NEXT_PUBLIC_WEB_VITALS_ENDPOINT:
        "https://user:pass@postwave.test/api/internal/web-vitals",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "NEXT_PUBLIC_SITE_URL must not include credentials",
    );
    expect(result.stderr).toContain(
      "NEXT_PUBLIC_DOCS_URL must not include a query string or fragment",
    );
    expect(result.stderr).toContain(
      "NEXT_PUBLIC_WEB_VITALS_ENDPOINT must not include credentials",
    );
  });

  it("requires a consent API base URL when consent site-key writes are enabled", () => {
    const result = runEnvCheck({
      NEXT_PUBLIC_POSTWAVE_CONSENT_SITE_KEY: "pwk_public_test_key",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "NEXT_PUBLIC_POSTWAVE_API_BASE_URL is required",
    );
  });

  // 30s, not the 5s default: this walks every runtime source file, and the
  // corpus grew by ~30 files during the desktop-parity sweep on 2026-08-22
  // until the scan crossed the default timeout. The assertions still pass —
  // verified by running with --testTimeout=60000 — so the limit was measuring
  // repository size rather than correctness.
  it("keeps direct runtime process.env reads registered in the schema", { timeout: 30_000 }, () => {
    const known = schemaKeys();
    const missing = runtimeEnvFiles()
      .flatMap((filePath) =>
        collectDirectEnvReads(filePath).map((key) => ({
          key,
          filePath,
        })),
      )
      .filter(({ key }) => !known.has(key))
      .map(
        ({ key, filePath }) =>
          `${key} in ${path.relative(process.cwd(), filePath)}`,
      )
      .sort();

    expect(missing).toEqual([]);
  });
});
