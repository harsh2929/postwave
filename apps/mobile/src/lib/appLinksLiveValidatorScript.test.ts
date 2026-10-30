import { spawnSync } from "node:child_process";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const mobileRoot = process.cwd();
const scriptPath = join(mobileRoot, "scripts", "validate-app-links-live.mjs");

function runValidator(env: Record<string, string | undefined>) {
  return spawnSync(process.execPath, [scriptPath], {
    cwd: mobileRoot,
    env: {
      ...process.env,
      ...env,
    },
    encoding: "utf8",
  });
}

describe("validate-app-links-live.mjs", () => {
  it("rejects non-HTTPS origins before fetching live association files", () => {
    const result = runValidator({
      POSTWAVE_APP_LINK_ORIGIN: "http://app.moosewave.com",
      POSTWAVE_APP_LINK_CHECK_PLATFORM: "ios",
      POSTWAVE_APPLE_TEAM_ID: "ABCDE12345",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("origin must use https");
    expect(result.stderr).not.toContain(".well-known/apple-app-site-association");
    expect(result.stderr).not.toContain("returned HTTP");
  });

  it("rejects missing Android fingerprints before fetching assetlinks", () => {
    const result = runValidator({
      POSTWAVE_APP_LINK_ORIGIN: "https://app.moosewave.com",
      POSTWAVE_APP_LINK_CHECK_PLATFORM: "android",
      POSTWAVE_ANDROID_SHA256_CERT_FINGERPRINTS: "",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "POSTWAVE_ANDROID_SHA256_CERT_FINGERPRINTS is required",
    );
    expect(result.stderr).not.toContain(".well-known/assetlinks.json");
    expect(result.stderr).not.toContain("returned HTTP");
  });
});
