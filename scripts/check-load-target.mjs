#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";

const reservedSuffixes = [".test", ".invalid", ".example", ".localhost"];

export function validateLoadTarget({ baseUrl, allowedHost, apiKey }) {
  const rawBase = String(baseUrl ?? "").trim();
  const rawAllowedHost = String(allowedHost ?? "").trim().toLowerCase();
  const rawAPIKey = String(apiKey ?? "").trim();

  if (!rawBase) throw new Error("POSTWAVE_LOAD_BASE_URL is required");
  if (!rawAllowedHost) throw new Error("POSTWAVE_LOAD_ALLOWED_HOST is required");
  if (!rawAPIKey) throw new Error("POSTWAVE_LOAD_API_KEY is required");
  if (/[:/@*\s]/.test(rawAllowedHost)) {
    throw new Error("POSTWAVE_LOAD_ALLOWED_HOST must be one exact DNS host without scheme, port, path, wildcard, or credentials");
  }

  let target;
  try {
    target = new URL(rawBase);
  } catch {
    throw new Error("POSTWAVE_LOAD_BASE_URL must be an absolute URL");
  }
  if (target.protocol !== "https:") throw new Error("load target must use HTTPS");
  if (target.username || target.password || target.search || target.hash) {
    throw new Error("load target cannot contain credentials, query, or fragment");
  }
  if (target.pathname !== "/" || rawBase.replace(/\/$/, "") !== target.origin) {
    throw new Error("load target must be an origin without a path");
  }
  if (target.port) throw new Error("load target must use the default HTTPS port");

  const hostname = target.hostname.toLowerCase();
  if (hostname !== rawAllowedHost) {
    throw new Error("load target host does not exactly match POSTWAVE_LOAD_ALLOWED_HOST");
  }
  if (
    reservedSuffixes.some((suffix) => hostname === suffix.slice(1) || hostname.endsWith(suffix)) ||
    hostname === "localhost" ||
    isPrivateIPv4(hostname) ||
    hostname === "::1"
  ) {
    throw new Error("load target must be a deployed, non-reserved staging DNS host");
  }
  if (rawAPIKey.length < 16) {
    throw new Error("POSTWAVE_LOAD_API_KEY is too short to be a production API credential");
  }

  return { origin: target.origin, hostname };
}

function isPrivateIPv4(hostname) {
  const parts = hostname.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) return false;
  const octets = parts.map(Number);
  if (octets.some((part) => part > 255)) return false;
  return (
    octets[0] === 10 ||
    octets[0] === 127 ||
    (octets[0] === 169 && octets[1] === 254) ||
    (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
    (octets[0] === 192 && octets[1] === 168)
  );
}

function expectFailure(name, input, match) {
  try {
    validateLoadTarget(input);
  } catch (error) {
    if (match.test(String(error?.message))) return;
    throw new Error(`${name}: unexpected failure: ${error?.message}`);
  }
  throw new Error(`${name}: invalid input unexpectedly passed`);
}

function runSelfTests() {
  const valid = {
    baseUrl: "https://staging.moosewave.com",
    allowedHost: "staging.moosewave.com",
    apiKey: "pw_staging_0123456789abcdef",
  };
  const result = validateLoadTarget(valid);
  if (result.origin !== valid.baseUrl) throw new Error("valid target normalization drifted");

  expectFailure("missing key", { ...valid, apiKey: "" }, /API_KEY is required/);
  expectFailure("reserved target", {
    ...valid,
    baseUrl: "https://staging.postwave.test",
    allowedHost: "staging.postwave.test",
  }, /non-reserved/);
  expectFailure("host mismatch", { ...valid, allowedHost: "other.moosewave.com" }, /exactly match/);
  expectFailure("insecure target", { ...valid, baseUrl: "http://staging.moosewave.com" }, /HTTPS/);
  expectFailure("URL payload", {
    ...valid,
    baseUrl: "https://staging.moosewave.com/?redirect=https://attacker.example",
  }, /query/);
  console.log("Load-target gate self-tests passed (1 pass case, 5 fail cases).");
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    if (process.argv.includes("--self-test")) {
      runSelfTests();
    } else {
      const result = validateLoadTarget({
        baseUrl: process.env.POSTWAVE_LOAD_BASE_URL,
        allowedHost: process.env.POSTWAVE_LOAD_ALLOWED_HOST,
        apiKey: process.env.POSTWAVE_LOAD_API_KEY,
      });
      console.log(`Load target accepted: ${result.origin} (authenticated; exact-host allowlist matched).`);
    }
  } catch (error) {
    console.error(`Load-target gate failed: ${error?.message ?? error}`);
    process.exitCode = 1;
  }
}
