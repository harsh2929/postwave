#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  SMS_RELEASE_ARTIFACT_RULES,
  SMS_RELEASE_CLAIM_RULES,
  inspectSMSReleaseClaims,
} from "./lib/sms-release-claims.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const errors = inspectSMSReleaseClaims((path) =>
  readFileSync(join(root, path), "utf8"),
);

if (errors.length > 0) {
  console.error("SMS release-claim gate failed:");
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(
  `SMS release-claim gate passed: ${new Set(SMS_RELEASE_CLAIM_RULES.map(({ path }) => path)).size} alternate claim paths and ${new Set(SMS_RELEASE_ARTIFACT_RULES.map(({ path }) => path)).size} MCP source/generated artifacts checked.`,
);
