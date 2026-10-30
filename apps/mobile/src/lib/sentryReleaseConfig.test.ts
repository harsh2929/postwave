import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const mobileRoot = process.cwd();
const repoRoot = join(mobileRoot, "..", "..");

function readMobile(path: string): string {
  return readFileSync(join(mobileRoot, path), "utf8");
}

function readRepo(path: string): string {
  return readFileSync(join(repoRoot, path), "utf8");
}

function stepBlock(workflow: string, name: string): string {
  const start = workflow.indexOf(`- name: ${name}`);
  expect(start).toBeGreaterThanOrEqual(0);
  const rest = workflow.slice(start);
  const next = rest.indexOf("\n      - name: ", 1);
  return next === -1 ? rest : rest.slice(0, next);
}

function envKeyCount(block: string, key: string): number {
  return block.match(new RegExp(`^\\s+${key}:`, "gm"))?.length ?? 0;
}

describe("mobile Sentry release configuration", () => {
  it("keeps Metro wrapped with Sentry debug-id serialization", () => {
    const metroConfig = readMobile("metro.config.js");

    expect(metroConfig).toContain("@sentry/react-native/metro");
    expect(metroConfig).toContain("getSentryExpoConfig");
    expect(metroConfig).toContain("withNativeWind");
  });

  it("wraps the root React tree and explicitly captures route-boundary errors", () => {
    const layout = readMobile("app/_layout.tsx");
    const boundary = readMobile("src/components/AppErrorBoundary.tsx");

    expect(layout).toContain("wrapWithSentry(RootLayout)");
    expect(boundary).toContain("captureRootError(error)");
  });

  it("keeps the Expo Sentry plugin enabled for native/EAS upload hooks", () => {
    const appJson = JSON.parse(readMobile("app.json")) as {
      expo?: { plugins?: unknown[] };
    };
    const plugins = appJson.expo?.plugins ?? [];
    const sentryPlugin = plugins.find((plugin) => {
      if (plugin === "@sentry/react-native") return true;
      return Array.isArray(plugin) && plugin[0] === "@sentry/react-native";
    });

    expect(sentryPlugin).toBeTruthy();
    expect(Array.isArray(sentryPlugin) ? sentryPlugin[1] : undefined).toEqual(
      expect.objectContaining({ project: "postwave-mobile" }),
    );
  });

  it("fails production preflight when Sentry upload credentials are missing", () => {
    const preflight = readMobile("scripts/validate-production-env.mjs");

    expect(preflight).toContain('"SENTRY_AUTH_TOKEN"');
    expect(preflight).toContain('"SENTRY_ORG"');
    expect(preflight).toContain('"SENTRY_PROJECT"');
  });

  it("passes Sentry upload credentials through the mobile release workflow", () => {
    const workflow = readRepo(".github/workflows/mobile-release.yml");

    expect(workflow).toContain("HAS_SENTRY_AUTH_TOKEN:");
    expect(workflow).toContain("env.HAS_SENTRY_AUTH_TOKEN == 'true'");
    expect(workflow).not.toContain("env.SENTRY_AUTH_TOKEN != ''");

    const easBuild = stepBlock(workflow, "EAS Build (production)");
    expect(envKeyCount(easBuild, "SENTRY_AUTH_TOKEN")).toBe(1);
    expect(envKeyCount(easBuild, "SENTRY_ORG")).toBe(1);
    expect(envKeyCount(easBuild, "SENTRY_PROJECT")).toBe(1);

    const upload = stepBlock(workflow, "Upload source maps to Sentry");
    expect(envKeyCount(upload, "SENTRY_AUTH_TOKEN")).toBe(1);
    expect(envKeyCount(upload, "SENTRY_ORG")).toBe(1);
    expect(envKeyCount(upload, "SENTRY_PROJECT")).toBe(1);
  });

  it("keeps the source-map upload runbook aligned with the workflow gate", () => {
    const scriptsReadme = readMobile("scripts/README.md");
    const uploader = readMobile("scripts/upload-sourcemaps.sh");
    const workflow = readRepo(".github/workflows/mobile-release.yml");

    expect(scriptsReadme).toContain("env.HAS_SENTRY_AUTH_TOKEN == 'true'");
    expect(scriptsReadme).toContain("--source-maps external");
    expect(scriptsReadme).not.toContain("env.SENTRY_AUTH_TOKEN != ''");
    expect(scriptsReadme).not.toContain("postPublish");
    expect(uploader).not.toContain("postPublish");
    expect(uploader).not.toContain("EAS_BUILD=1");
    expect(workflow).not.toContain("postPublish");
    expect(workflow).not.toContain("EAS_BUILD=1");
  });
});
