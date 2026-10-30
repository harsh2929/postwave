#!/usr/bin/env node

import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

/** @param {Record<string, string | undefined>} env @param {string} name */
function required(env, name) {
  const value = String(env[name] ?? "").trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function decodeBase64PrivateKey(value) {
  if (!/^[A-Za-z0-9+/\r\n]+=*$/.test(value)) {
    throw new Error("ASC_API_KEY_P8_BASE64 is not valid base64");
  }
  const decoded = Buffer.from(value.replace(/\s+/g, ""), "base64").toString(
    "utf8",
  );
  if (
    !decoded.includes("-----BEGIN PRIVATE KEY-----") ||
    !decoded.includes("-----END PRIVATE KEY-----")
  ) {
    throw new Error(
      "ASC_API_KEY_P8_BASE64 does not contain a PKCS#8 private key",
    );
  }
  return decoded.endsWith("\n") ? decoded : `${decoded}\n`;
}

function parseGoogleServiceAccount(value) {
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON");
  }
  if (
    parsed?.type !== "service_account" ||
    typeof parsed.client_email !== "string" ||
    !parsed.client_email.trim() ||
    typeof parsed.private_key !== "string" ||
    !parsed.private_key.includes("BEGIN PRIVATE KEY")
  ) {
    throw new Error(
      "GOOGLE_SERVICE_ACCOUNT_JSON is not a complete service-account credential",
    );
  }
  return parsed;
}

/**
 * @param {{
 *   platform: string,
 *   easPath: string,
 *   secretDir: string,
 *   env?: Record<string, string | undefined>
 * }} options
 */
export async function prepareSubmitProfile({
  platform,
  easPath,
  secretDir,
  env = process.env,
}) {
  const selected = String(platform ?? "")
    .trim()
    .toLowerCase();
  if (selected !== "ios" && selected !== "android") {
    throw new Error("platform must be ios or android");
  }
  if (!path.isAbsolute(secretDir)) {
    throw new Error(
      "POSTWAVE_EAS_SUBMIT_DIR must be an absolute runner-temporary path",
    );
  }

  const config = JSON.parse(await readFile(easPath, "utf8"));
  config.submit ??= {};
  config.submit.production ??= {};
  config.submit.production[selected] ??= {};

  await mkdir(secretDir, { recursive: true, mode: 0o700 });
  await chmod(secretDir, 0o700);

  if (selected === "ios") {
    const key = decodeBase64PrivateKey(required(env, "ASC_API_KEY_P8_BASE64"));
    const keyPath = path.join(secretDir, "app-store-connect-api-key.p8");
    await writeFile(keyPath, key, { mode: 0o600 });
    await chmod(keyPath, 0o600);
    Object.assign(config.submit.production.ios, {
      ascAppId: required(env, "ASC_APP_ID"),
      appleTeamId: required(env, "APPLE_TEAM_ID"),
      ascApiKeyPath: keyPath,
      ascApiKeyId: required(env, "ASC_API_KEY_ID"),
      ascApiKeyIssuerId: required(env, "ASC_API_KEY_ISSUER_ID"),
    });
    delete config.submit.production.ios.appleId;
  } else {
    const serviceAccount = parseGoogleServiceAccount(
      required(env, "GOOGLE_SERVICE_ACCOUNT_JSON"),
    );
    const keyPath = path.join(secretDir, "google-play-service-account.json");
    await writeFile(keyPath, `${JSON.stringify(serviceAccount)}\n`, {
      mode: 0o600,
    });
    await chmod(keyPath, 0o600);
    config.submit.production.android.serviceAccountKeyPath = keyPath;
  }

  const temporaryPath = `${easPath}.postwave-submit-${process.pid}`;
  await writeFile(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, {
    mode: 0o600,
  });
  await rename(temporaryPath, easPath);
  return { platform: selected, secretDir };
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  try {
    const platform = required(process.env, "MATRIX_PLATFORM");
    const secretDir = required(process.env, "POSTWAVE_EAS_SUBMIT_DIR");
    await prepareSubmitProfile({
      platform,
      easPath: path.resolve("eas.json"),
      secretDir,
    });
    console.log(
      `Prepared ephemeral EAS ${platform} submit profile (credentials redacted).`,
    );
  } catch (error) {
    console.error(
      `EAS submit-profile preparation failed: ${error?.message ?? error}`,
    );
    process.exitCode = 1;
  }
}
