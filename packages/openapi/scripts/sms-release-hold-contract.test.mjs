// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");
const documents = [
  resolve(repoRoot, "packages/openapi/openapi.json"),
  resolve(repoRoot, "apps/api/internal/apidocs/openapi.json"),
].map((path) => JSON.parse(readFileSync(path, "utf8")));

const heldMutations = [
  [
    "/api/v1/sms/campaigns/{id}/schedule",
    "sms_campaign_schedule_release_held",
  ],
  [
    "/api/v1/sms/campaigns/{id}/send",
    "sms_campaign_dispatch_release_held",
  ],
  [
    "/api/v1/sms/senders/{id}/a2p/brand/submit",
    "sms_a2p_registration_release_held",
  ],
  [
    "/api/v1/sms/senders/{id}/a2p/campaign/submit",
    "sms_a2p_registration_release_held",
  ],
  ["/api/v1/sms/test-send", "sms_test_dispatch_release_held"],
];

test("source-held SMS mutations advertise no request or success contract", () => {
  for (const document of documents) {
    for (const [path, code] of heldMutations) {
      const operation = document.paths[path]?.post;
      assert.ok(operation, `${path} POST missing`);
      assert.equal(
        Object.hasOwn(operation, "requestBody"),
        false,
        `${path} must not invite a body that the structural hold never reads`,
      );
      assert.deepEqual(
        Object.keys(operation.responses),
        ["503"],
        `${path} must expose only its stable source hold`,
      );
      assert.match(operation.description, new RegExp(`\\b${code}\\b`, "u"));
    }
  }
});
