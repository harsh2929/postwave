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
const manifest = JSON.parse(
  readFileSync(
    resolve(repoRoot, "apps/api/internal/routeauth/manifest.json"),
    "utf8",
  ),
);

const PATHS = [
  "/api/v1/deliverability/hub/repair-override",
  "/api/v1/deliverability/repair/override",
];
const RESPONSE_CODES = ["200", "400", "401", "403", "404", "409", "500", "503"];
const PRIVATE_RESPONSE = {
  appliesTo:
    "all outcomes, including pre-handler authentication and authorization refusals",
  cacheControl: "private, no-store",
  pragma: "no-cache",
  expires: "0",
  contentTypeOptions: "nosniff",
};
const PRIVATE_HEADER_REFS = {
  "Cache-Control": "#/components/headers/DeliverabilityRepairPrivateNoStore",
  Pragma: "#/components/headers/DeliverabilityRepairPragmaNoCache",
  Expires: "#/components/headers/DeliverabilityRepairExpires",
  "X-Content-Type-Options": "#/components/headers/DeliverabilityRepairNoSniff",
};

function dereference(document, value) {
  if (!value?.$ref) return value;
  return value.$ref
    .slice(2)
    .split("/")
    .reduce((node, part) => node?.[part], document);
}

test("repair-override mirrors publish the exact non-replayable cap outcome contract", () => {
  for (const document of documents) {
    for (const path of PATHS) {
      const operation = document.paths[path]?.post;
      assert.ok(operation, `POST ${path} missing`);
      assert.deepEqual(operation["x-required-scopes"], ["admin"]);
      assert.equal(operation["x-required-role"], "admin");
      assert.deepEqual(operation.security, [
        { bearerAuth: [] },
        { sessionCookie: [] },
      ]);
      assert.deepEqual(operation["x-postwave-private-response"], PRIVATE_RESPONSE);
      assert.equal(operation["x-postwave-idempotency"], "forbidden");
      assert.equal(operation["x-postwave-retry-policy"], "one-attempt");
      assert.deepEqual(Object.keys(operation.responses).sort(), RESPONSE_CODES);
      for (const [code, responseRef] of Object.entries(operation.responses)) {
        const response = dereference(document, responseRef);
        for (const [name, ref] of Object.entries(PRIVATE_HEADER_REFS)) {
          assert.equal(response.headers[name].$ref, ref, `${path} ${code} ${name}`);
        }
        assert.ok(response.headers["X-Postwave-Sending-Cap-Outcome"]);
      }

      const success = dereference(document, operation.responses["200"]);
      assert.equal(
        success.content["application/json"].schema.$ref,
        "#/components/schemas/DeliverabilityRepairOverrideResponse",
      );
      assert.equal(
        success.headers["X-Postwave-Sending-Cap-Outcome"].$ref,
        "#/components/headers/SendingCapOutcomeCommitted",
      );
      const forbiddenKey = dereference(document, operation.responses["400"]);
      assert.equal(
        forbiddenKey.headers["X-Postwave-Sending-Cap-Outcome"].$ref,
        "#/components/headers/SendingCapOutcomeNotCommitted",
      );
      assert.equal(
        forbiddenKey.content["application/json"].schema.$ref,
        "#/components/schemas/DeliverabilityRepairIdempotencyForbiddenError",
      );
      const pending = dereference(document, operation.responses["503"]);
      assert.deepEqual(
        pending.headers["X-Postwave-Sending-Cap-Outcome"].schema.enum,
        [
          "committed-conservatively-fenced",
          "commit-outcome-unknown-conservatively-fenced",
        ],
      );
      assert.equal(
        pending.content["application/json"].schema.$ref,
        "#/components/schemas/DeliverabilityRepairCoordinationError",
      );
    }

    const committed = document.components.schemas.DeliverabilityRepairOverrideResponse;
    assert.equal(committed.additionalProperties, false);
    assert.deepEqual(committed.required, ["ok", "cleared", "cap_coordination_outcome"]);
    assert.equal(committed.properties.ok.const, true);
    assert.equal(committed.properties.cleared.const, true);
    assert.equal(committed.properties.cap_coordination_outcome.const, "committed");

    const forbiddenKey =
      document.components.schemas.DeliverabilityRepairIdempotencyForbiddenError;
    assert.equal(forbiddenKey.additionalProperties, false);
    assert.deepEqual(forbiddenKey.required, ["error"]);
    assert.equal(forbiddenKey.properties.error.additionalProperties, false);
    assert.equal(
      forbiddenKey.properties.error.properties.code.const,
      "idempotency_forbidden",
    );

    const fenced = document.components.schemas.DeliverabilityRepairCommittedFencedError;
    assert.equal(fenced.properties.ok.const, true);
    assert.equal(fenced.properties.cleared.const, true);
    assert.equal(
      fenced.properties.cap_coordination_outcome.const,
      "committed-conservatively-fenced",
    );
    const unknown = document.components.schemas.DeliverabilityRepairCommitUnknownError;
    assert.equal(unknown.properties.ok.const, false);
    assert.equal(unknown.properties.cleared.const, false);
    assert.equal(
      unknown.properties.cap_coordination_outcome.const,
      "commit-outcome-unknown-conservatively-fenced",
    );
  }
});

test("repair-override authorization manifest is reviewed exact-admin", () => {
  for (const path of PATHS) {
    const policy = manifest.routes.find(
      (route) => route.method === "POST" && route.path === path,
    );
    assert.ok(policy, `POST ${path} policy missing`);
    assert.equal(policy.exposure, "authenticated");
    assert.deepEqual(policy.auth_methods, ["session", "api_key"]);
    assert.equal(policy.session_minimum_role, "admin");
    assert.deepEqual(policy.api_key_scopes, ["admin"]);
    assert.equal(policy.api_key_scope_mode, "any");
    assert.equal(policy.policy_source, "openapi.x-required-scopes");
    assert.equal(policy.review_status, "reviewed");
  }
});
