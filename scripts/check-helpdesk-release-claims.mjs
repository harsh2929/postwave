#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  HELPDESK_RELEASE_CLAIM_RULES,
  SUPPORT_PROVIDER_HISTORY_PATHS,
  inspectHelpdeskReleaseClaims,
} from "./lib/helpdesk-release-claims.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const errors = inspectHelpdeskReleaseClaims((path) =>
  readFileSync(join(root, path), "utf8"),
);

if (errors.length > 0) {
  console.error("Helpdesk/support release-claim gate failed:");
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(
  `Helpdesk/support release-claim gate passed: ${HELPDESK_RELEASE_CLAIM_RULES.length} active surfaces and ${SUPPORT_PROVIDER_HISTORY_PATHS.length} historical provider guides checked.`,
);
