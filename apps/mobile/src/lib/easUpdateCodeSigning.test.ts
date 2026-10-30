/**
 * OTA updates without code signing are a token away from arbitrary code
 * execution on every install.
 *
 * `updates.url` tells the installed binary to fetch and RUN whatever JS the
 * update server hands it. The server's only gate is an EXPO_TOKEN. So the blast
 * radius of that token leaking is not "someone can publish to our project" — it
 * is running attacker code inside the app, with the session cookie, the
 * keychain and the shared App Group in reach, on every device, with no store
 * review anywhere in the path and nothing to revoke but the token itself.
 *
 * expo-updates closes this by moving the trust anchor into the binary: the app
 * ships a public certificate and rejects any manifest not signed by the
 * matching private key, which lives only in the release pipeline's secret
 * store. The certificate can be committed; the key cannot exist in this repo,
 * and this file is the "loud" half of that — the requirement is asserted rather
 * than left as a comment nobody reads.
 *
 * Two things are pinned here:
 *
 *  1. THE GAP IS ENFORCED. Resolving an update channel for anything that will
 *     be installed on a device fails, with an actionable message, unless a
 *     certificate is supplied. Falling back to unsigned is the one outcome
 *     that must be impossible, because an unsigned channel behaves exactly
 *     like a signed one right up until it is abused.
 *  2. THE SHAPE IS RIGHT. The config keys are read off the installed
 *     expo-updates rather than from memory, so an SDK upgrade that renames or
 *     re-nests them fails here instead of shipping a binary that silently
 *     ignores the certificate.
 */
import { createRequire } from "node:module";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const appRoot = process.cwd();
const configureApp = require(resolve(appRoot, "app.config.js")) as (input: {
  config: Record<string, unknown>;
}) => {
  updates?: {
    url?: string;
    codeSigningCertificate?: string;
    codeSigningMetadata?: { keyid?: string; alg?: string };
  };
};

const PROJECT_ID = "123e4567-e89b-12d3-a456-426614174000";

// `.expo/` is gitignored, so a throwaway certificate here cannot be mistaken
// for a real one or committed by accident. Its CONTENTS are never parsed —
// app.config.js only records the path, and the PEM is read by
// @expo/config-plugins at prebuild — so a placeholder is honest here rather
// than a fabricated credential.
const certDir = join(appRoot, ".expo", "code-signing-test");
const certRelativePath = "./.expo/code-signing-test/certificate.pem";

const TOUCHED = [
  "EXPO_PUBLIC_EAS_PROJECT_ID",
  "EXPO_OWNER",
  "EAS_BUILD_PROFILE",
  "EXPO_PUBLIC_BUILD_PROFILE",
  "POSTWAVE_MOBILE_BUILD_PROFILE",
  "EXPO_UPDATES_CODE_SIGNING_CERTIFICATE",
  "EXPO_UPDATES_CODE_SIGNING_KEY_ID",
] as const;
const original = new Map(TOUCHED.map((k) => [k, process.env[k]]));

function setEnv(values: Partial<Record<(typeof TOUCHED)[number], string>>) {
  for (const key of TOUCHED) delete process.env[key];
  for (const [key, value] of Object.entries(values)) process.env[key] = value;
}

beforeAll(() => {
  mkdirSync(certDir, { recursive: true });
  writeFileSync(
    join(certDir, "certificate.pem"),
    "-----BEGIN CERTIFICATE-----\nplaceholder\n-----END CERTIFICATE-----\n",
  );
});

afterAll(() => {
  rmSync(certDir, { force: true, recursive: true });
});

afterEach(() => {
  for (const key of TOUCHED) {
    const value = original.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("an update channel is never configured unsigned", () => {
  for (const profile of ["production", "preview"]) {
    it(`refuses to resolve a ${profile} config without a certificate`, () => {
      setEnv({
        EXPO_PUBLIC_EAS_PROJECT_ID: PROJECT_ID,
        EXPO_PUBLIC_BUILD_PROFILE: profile,
      });
      expect(() => configureApp({ config: {} })).toThrow(
        /EXPO_UPDATES_CODE_SIGNING_CERTIFICATE/u,
      );
    });
  }

  it("refuses for an unrecognised profile too, rather than assuming it is safe", () => {
    // Fail-closed. The realistic way this regresses is a pipeline that stops
    // exporting a profile variable at all; defaulting the unknown case to
    // "signing not required" would turn that into a silently unsigned release.
    setEnv({ EXPO_PUBLIC_EAS_PROJECT_ID: PROJECT_ID });
    expect(() => configureApp({ config: {} })).toThrow(/UNSIGNED/u);

    setEnv({
      EXPO_PUBLIC_EAS_PROJECT_ID: PROJECT_ID,
      EXPO_PUBLIC_BUILD_PROFILE: "staging",
    });
    expect(() => configureApp({ config: {} })).toThrow(/UNSIGNED/u);
  });

  it("prefers EAS_BUILD_PROFILE, which the builder sets and eas.json cannot", () => {
    // EAS exports EAS_BUILD_PROFILE itself; a stale EXPO_PUBLIC_BUILD_PROFILE
    // left at "development" in an env file must not be able to downgrade a
    // real production build to unsigned.
    setEnv({
      EXPO_PUBLIC_EAS_PROJECT_ID: PROJECT_ID,
      EAS_BUILD_PROFILE: "production",
      EXPO_PUBLIC_BUILD_PROFILE: "development",
    });
    expect(() => configureApp({ config: {} })).toThrow(/UNSIGNED/u);
  });

  it("tells the operator what to do, not just that it failed", () => {
    setEnv({
      EXPO_PUBLIC_EAS_PROJECT_ID: PROJECT_ID,
      EXPO_PUBLIC_BUILD_PROFILE: "production",
    });
    let message = "";
    try {
      configureApp({ config: {} });
    } catch (error) {
      message = (error as Error).message;
    }
    // The command below is the one the installed expo-updates actually
    // exposes; `cli/build/cli.js` registers `codesigning:generate`.
    expect(message).toContain("codesigning:generate");
    expect(message).toContain("EXPO_UPDATES_CODE_SIGNING_CERTIFICATE");
    expect(message).toContain("private-key-path");
    // The reason, not only the remedy — otherwise the next person under
    // release pressure looks for the flag that turns it off.
    expect(message).toContain("EXPO_TOKEN");
  });

  it("still configures nothing at all when there is no project id", () => {
    // Preserved from before: a local checkout and the verification export both
    // run with an empty project id, and they must not need a release secret.
    setEnv({ EXPO_PUBLIC_BUILD_PROFILE: "production" });
    expect(configureApp({ config: {} }).updates).toBeUndefined();
  });

  it("lets development poll unsigned, because its JS comes from Metro", () => {
    setEnv({
      EXPO_PUBLIC_EAS_PROJECT_ID: PROJECT_ID,
      EXPO_PUBLIC_BUILD_PROFILE: "development",
    });
    const updates = configureApp({ config: {} }).updates;
    expect(updates?.url).toBe(`https://u.expo.dev/${PROJECT_ID}`);
    expect(updates?.codeSigningCertificate).toBeUndefined();
    expect(updates?.codeSigningMetadata).toBeUndefined();
  });
});

describe("the signed configuration expo-updates 55 expects", () => {
  it("emits the certificate path and metadata a production build needs", () => {
    setEnv({
      EXPO_PUBLIC_EAS_PROJECT_ID: PROJECT_ID,
      EXPO_PUBLIC_BUILD_PROFILE: "production",
      EXPO_UPDATES_CODE_SIGNING_CERTIFICATE: certRelativePath,
    });
    const updates = configureApp({ config: {} }).updates;
    expect(updates?.url).toBe(`https://u.expo.dev/${PROJECT_ID}`);
    expect(updates?.codeSigningCertificate).toBe(certRelativePath);
    expect(updates?.codeSigningMetadata).toEqual({
      keyid: "main",
      alg: "rsa-v1_5-sha256",
    });
  });

  it("carries the key id through, so a key can be rotated", () => {
    // Binaries already in the field verify against the certificate they
    // shipped with; the keyid is how a manifest says which key in the chain
    // signed it. Hardcoding "main" would make rotation a store release.
    setEnv({
      EXPO_PUBLIC_EAS_PROJECT_ID: PROJECT_ID,
      EXPO_PUBLIC_BUILD_PROFILE: "production",
      EXPO_UPDATES_CODE_SIGNING_CERTIFICATE: certRelativePath,
      EXPO_UPDATES_CODE_SIGNING_KEY_ID: "postwave-2026",
    });
    expect(configureApp({ config: {} }).updates?.codeSigningMetadata).toEqual({
      keyid: "postwave-2026",
      alg: "rsa-v1_5-sha256",
    });
  });

  it("rejects an absolute certificate path instead of producing a dead one", () => {
    // @expo/config-plugins does `path.join(projectRoot, certificatePath)`, and
    // path.join does not discard a leading "/" — an absolute path becomes
    // <projectRoot>/<abs> and surfaces as "File not found" at prebuild, a long
    // way from the variable that caused it.
    setEnv({
      EXPO_PUBLIC_EAS_PROJECT_ID: PROJECT_ID,
      EXPO_PUBLIC_BUILD_PROFILE: "production",
      EXPO_UPDATES_CODE_SIGNING_CERTIFICATE: join(certDir, "certificate.pem"),
    });
    expect(() => configureApp({ config: {} })).toThrow(/must be relative/u);
  });

  it("rejects a certificate path that is not there yet", () => {
    setEnv({
      EXPO_PUBLIC_EAS_PROJECT_ID: PROJECT_ID,
      EXPO_PUBLIC_BUILD_PROFILE: "production",
      EXPO_UPDATES_CODE_SIGNING_CERTIFICATE: "./certs/certificate.pem",
    });
    expect(() => configureApp({ config: {} })).toThrow(/does not exist/u);
  });
});

/**
 * The keys are copied from the installed package, so they must be checked
 * against the installed package. Guessing them from memory produces a config
 * Expo silently ignores — the binary polls, fetches, and runs unsigned JS
 * while the repo looks configured.
 */
describe("the config keys match the installed expo-updates", () => {
  const updatesRoot = resolve(appRoot, "node_modules/expo-updates");
  const configureSource = readFileSync(
    join(updatesRoot, "cli/src/configureCodeSigningAsync.ts"),
    "utf8",
  );
  const appConfigSource = readFileSync(join(appRoot, "app.config.js"), "utf8");

  it("uses the field names expo-updates' own configure command writes", () => {
    for (const key of ["codeSigningCertificate", "codeSigningMetadata"]) {
      expect(configureSource).toContain(`${key}:`);
      expect(appConfigSource).toContain(`${key}:`);
    }
    expect(configureSource).toContain("keyid:");
    expect(configureSource).toContain("alg: 'rsa-v1_5-sha256'");
  });

  it("uses the only algorithm the native verifier accepts", () => {
    // A value the reader does not recognise is not a fallback — it is an
    // invalid code-signing configuration at launch.
    const algorithms = readFileSync(
      join(updatesRoot, "ios/EXUpdates/CodeSigning/CodeSigningAlgorithm.swift"),
      "utf8",
    );
    const cases = algorithms.match(/case\s+\w+\s*=\s*"([^"]+)"/gu) ?? [];
    expect(cases).toHaveLength(1);
    expect(cases[0]).toContain("rsa-v1_5-sha256");
    expect(appConfigSource).toContain('"rsa-v1_5-sha256"');
  });

  it("nests them where the config plugin reads them from", () => {
    // Both fields are read off `config.updates`, not the top level.
    const plugin = readFileSync(
      join(
        require.resolve("@expo/config-plugins/package.json"),
        "..",
        "build/utils/Updates.js",
      ),
      "utf8",
    );
    expect(plugin).toContain("config.updates?.codeSigningCertificate");
    expect(plugin).toContain("config.updates?.codeSigningMetadata");
  });
});
