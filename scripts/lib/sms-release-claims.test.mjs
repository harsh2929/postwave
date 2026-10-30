// SPDX-License-Identifier: AGPL-3.0-only

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  SMS_MCP_SENDER_DESCRIPTION,
  SMS_RELEASE_ARTIFACT_RULES,
  SMS_RELEASE_CLAIM_RULES,
  inspectSMSReleaseClaims,
} from "./sms-release-claims.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const readRepositorySource = (path) => readFileSync(join(root, path), "utf8");

test("active SMS claim paths share the structural HOLD / NO-GO boundary", () => {
  assert.equal(
    new Set(SMS_RELEASE_CLAIM_RULES.map(({ path }) => path)).size,
    37,
  );
  assert.equal(
    new Set(SMS_RELEASE_ARTIFACT_RULES.map(({ path }) => path)).size,
    6,
  );
  assert.deepEqual(inspectSMSReleaseClaims(readRepositorySource), []);
});

test("the existing CI public-claims command invokes the SMS claim gate", () => {
  const packageManifest = JSON.parse(readRepositorySource("package.json"));
  const auditClaims = packageManifest.scripts?.["audit:claims"] ?? "";
  assert.match(auditClaims, /pnpm audit:sms-release-claims/u);
  assert.ok(
    auditClaims.indexOf("audit:sms-release-claims") <
      auditClaims.indexOf("check-public-claims.mjs"),
    "the SMS guard must execute before an unrelated public-claims failure can short-circuit CI",
  );
});

test("alternate marketing and package send claims fail the gate", () => {
  const poisoned = (path) => {
    const source = readRepositorySource(path);
    if (path.endsWith("sms/page.tsx")) {
      return `${source}\nSMS that can't send without consent`;
    }
    if (path === "packages/cli/README.md") {
      return `${source}\npostwave sms campaigns send sms_cmp_123`;
    }
    if (path === "packages/mcp-server/src/tools/sms.ts") {
      return source.replace(
        SMS_MCP_SENDER_DESCRIPTION,
        "Provider credentials stay in server-side SMS configuration",
      );
    }
    return source;
  };

  const errors = inspectSMSReleaseClaims(poisoned);
  assert.ok(errors.some((error) => error.includes("SMS that can't send")));
  assert.ok(errors.some((error) => error.includes("campaigns send")));
  assert.ok(
    errors.some((error) => error.includes("Provider credentials stay")),
  );
});

test("provider-secret templates and non-fictional phone evidence fail closed", () => {
  const poisoned = (path) => {
    const source = readRepositorySource(path);
    if (path === ".env.production.template") {
      return `${source}\nTWILIO_AUTH_TOKEN=customer-secret`;
    }
    if (path === "docs-site/pages/sms/inbox.mdx") {
      return `${source}\n+14155551212`;
    }
    return source;
  };

  const errors = inspectSMSReleaseClaims(poisoned);
  assert.ok(errors.some((error) => error.includes("provider-secret template")));
  assert.ok(errors.some((error) => error.includes("non-fictional NANP")));
});

test("the compliance guide cannot regress to an operator consent grant", () => {
  const poisoned = (path) => {
    const source = readRepositorySource(path);
    if (path !== "docs-site/pages/sms/compliance.mdx") return source;
    return `${source}\n\"subscriber_email\": \"casey@example.com\",\n\"action\": \"opt_in\",\n\"source\": \"checkout_form\"`;
  };
  const errors = inspectSMSReleaseClaims(poisoned);
  assert.ok(errors.some((error) => error.includes("subscriber_email")));
  assert.ok(
    errors.some(
      (error) => error.includes("action") && error.includes("opt_in"),
    ),
  );
  assert.ok(
    errors.some(
      (error) => error.includes("source") && error.includes("checkout_form"),
    ),
  );
});
