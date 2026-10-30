import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { prepareSubmitProfile } from "../../scripts/prepare-eas-submit-profile.mjs";

const temporaryRoots: string[] = [];

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "postwave-eas-submit-"));
  temporaryRoots.push(root);
  const easPath = path.join(root, "eas.json");
  await writeFile(
    easPath,
    JSON.stringify({ submit: { production: { ios: {}, android: { track: "internal" } } } }),
  );
  return { root, easPath, secretDir: path.join(root, "secrets") };
}

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true })));
});

describe("prepare-eas-submit-profile.mjs", () => {
  it("writes an iOS ASC key to a 0600 temporary file and configures exact IDs", async () => {
    const paths = await fixture();
    const privateKey = "-----BEGIN PRIVATE KEY-----\nfixture\n-----END PRIVATE KEY-----\n";
    await prepareSubmitProfile({
      platform: "ios",
      ...paths,
      env: {
        ASC_API_KEY_P8_BASE64: Buffer.from(privateKey).toString("base64"),
        ASC_API_KEY_ID: "KEY123",
        ASC_API_KEY_ISSUER_ID: "issuer-123",
        ASC_APP_ID: "1234567890",
        APPLE_TEAM_ID: "ABCDE12345",
      },
    });

    const config = JSON.parse(await readFile(paths.easPath, "utf8"));
    const profile = config.submit.production.ios;
    expect(profile).toMatchObject({
      ascApiKeyId: "KEY123",
      ascApiKeyIssuerId: "issuer-123",
      ascAppId: "1234567890",
      appleTeamId: "ABCDE12345",
    });
    expect(await readFile(profile.ascApiKeyPath, "utf8")).toBe(privateKey);
    expect((await stat(profile.ascApiKeyPath)).mode & 0o777).toBe(0o600);
  });

  it("writes a validated Android service account and preserves release track", async () => {
    const paths = await fixture();
    const credential = {
      type: "service_account",
      client_email: "release@example.iam.gserviceaccount.com",
      private_key: "-----BEGIN PRIVATE KEY-----\nfixture\n-----END PRIVATE KEY-----\n",
    };
    await prepareSubmitProfile({
      platform: "android",
      ...paths,
      env: { GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify(credential) },
    });

    const config = JSON.parse(await readFile(paths.easPath, "utf8"));
    const profile = config.submit.production.android;
    expect(profile.track).toBe("internal");
    expect(JSON.parse(await readFile(profile.serviceAccountKeyPath, "utf8"))).toEqual(
      credential,
    );
    expect((await stat(profile.serviceAccountKeyPath)).mode & 0o777).toBe(0o600);
  });

  it("rejects malformed credentials without embedding them in eas.json", async () => {
    const paths = await fixture();
    await expect(
      prepareSubmitProfile({
        platform: "android",
        ...paths,
        env: { GOOGLE_SERVICE_ACCOUNT_JSON: '{"private_key":"secret"}' },
      }),
    ).rejects.toThrow("complete service-account credential");
    expect(await readFile(paths.easPath, "utf8")).not.toContain("secret");
  });
});
