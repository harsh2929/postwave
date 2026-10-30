// SPDX-License-Identifier: AGPL-3.0-only

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  SUPPORT_CALLBACK_HOLD_CODE,
  SUPPORT_HISTORY_BANNER,
  SUPPORT_PROVIDER_HISTORY_PATHS,
  inspectHelpdeskReleaseClaims,
} from "./helpdesk-release-claims.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const readRepositorySource = (path) => readFileSync(join(root, path), "utf8");

test("active Helpdesk/support claims share the source-held boundary", () => {
  assert.equal(SUPPORT_PROVIDER_HISTORY_PATHS.length, 26);
  assert.deepEqual(inspectHelpdeskReleaseClaims(readRepositorySource), []);
});

test("the claims boundary distinguishes admin runtime from public callback ingress", () => {
  const sources = [
    readRepositorySource("apps/web/src/lib/integrations.ts"),
    readRepositorySource("docs/integrations/zendesk.md"),
    readRepositorySource(
      "docs-site/pages/api-reference/native-integration-api-audit.mdx",
    ),
  ];
  for (const source of sources) {
    assert.match(source, /support_integration_runtime_held/u);
    assert.match(source, new RegExp(SUPPORT_CALLBACK_HOLD_CODE, "u"));
  }
});

test("the public claims command invokes the Helpdesk/support gate", () => {
  const manifest = JSON.parse(readRepositorySource("package.json"));
  assert.match(
    manifest.scripts?.["audit:claims"] ?? "",
    /audit:helpdesk-release-claims/u,
  );
});

test("live ingest copy, missing history qualification, and public callback paths fail", () => {
  const poisoned = (path) => {
    const source = readRepositorySource(path);
    if (path === "apps/web/src/lib/integrations.ts") {
      return `${source}\nToday the live path is ingest-first`;
    }
    if (path === "docs/integrations/zendesk.md") {
      return source
        .replace(SUPPORT_HISTORY_BANNER, "Current setup")
        .concat("\nPOST /api/public/support-integrations/zendesk/acme/webhooks\n");
    }
    return source;
  };
  const errors = inspectHelpdeskReleaseClaims(poisoned);
  assert.ok(errors.some((error) => error.includes("live path is ingest-first")));
  assert.ok(errors.some((error) => error.includes(SUPPORT_HISTORY_BANNER)));
  assert.ok(
    errors.some((error) => error.includes("/api/public/support-integrations")),
  );
});

test("TS and Python support reads cannot lose bounded manual-continuation truth", () => {
  const poisoned = (path) => {
    const source = readRepositorySource(path);
    if (path === "packages/sdk-ts/README.md") {
      return source.replace(
        "A first page is not complete history",
        "The first page is the complete history",
      );
    }
    if (path === "packages/sdk-py/README.md") {
      return source.replace("Continue manually only when", "Continue whenever");
    }
    return source;
  };
  const errors = inspectHelpdeskReleaseClaims(poisoned);
  assert.ok(
    errors.some(
      (error) =>
        error.includes("packages/sdk-ts/README.md") &&
        error.includes("A first page is not complete history"),
    ),
  );
  assert.ok(
    errors.some(
      (error) =>
        error.includes("packages/sdk-py/README.md") &&
        error.includes("Continue manually only when"),
    ),
  );
});
