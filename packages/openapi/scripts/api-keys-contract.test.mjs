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

const CREATE_FIELDS = [
  "allowed_ips",
  "expires_at",
  "label",
  "sandbox_only",
  "scopes",
];
const UPDATE_FIELDS = ["label", "scopes"];

function requestSchema(document, method) {
  const path =
    method === "post" ? "/api/v1/api-keys" : "/api/v1/api-keys/{id}";
  const operation = document.paths[path]?.[method];
  assert.ok(operation, `${method.toUpperCase()} ${path} missing`);
  assert.equal(operation.requestBody?.required, true);
  return operation.requestBody.content["application/json"].schema;
}

function goJSONFields(source, typeName) {
  const body = new RegExp(
    `type ${typeName} struct \\{([\\s\\S]*?)\\n\\}`,
    "u",
  ).exec(source)?.[1];
  assert.ok(body, `${typeName} Go struct missing`);
  return [...body.matchAll(/`json:"([^",]+)(?:,[^"]*)?"`/gu)]
    .map((match) => match[1])
    .sort();
}

test("API-key OpenAPI request bodies exactly match the strict Go inputs", () => {
  for (const document of documents) {
    const create = requestSchema(document, "post");
    assert.equal(create.additionalProperties, false);
    assert.deepEqual(Object.keys(create.properties).sort(), CREATE_FIELDS);
    assert.deepEqual(create.required, ["label", "scopes"]);
    assert.equal(create.properties.scopes.minItems, 1);
    assert.equal(create.properties.expires_at.format, "date-time");
    assert.deepEqual(create.properties.allowed_ips, {
      items: { type: "string" },
      type: "array",
    });

    const update = requestSchema(document, "patch");
    assert.equal(update.additionalProperties, false);
    assert.deepEqual(Object.keys(update.properties).sort(), UPDATE_FIELDS);
    assert.deepEqual(update.required, ["label", "scopes"]);
    assert.equal(update.properties.scopes.minItems, 1);
  }

  const go = ["apikeys.go", "handlers.go"]
    .map((file) =>
      readFileSync(
        resolve(repoRoot, "apps/api/internal/apikeys", file),
        "utf8",
      ),
    )
    .join("\n");
  assert.deepEqual(goJSONFields(go, "CreateInput"), CREATE_FIELDS);
  assert.deepEqual(goJSONFields(go, "UpdateInput"), UPDATE_FIELDS);
});

test("published SDK and CLI surfaces do not advertise rejected budget fields", () => {
  const sources = [
    "packages/sdk-ts/src/resources/api-keys.ts",
    "packages/sdk-php/src/Resources/APIKeysResource.php",
    "packages/sdk-py/postwave/resources/api_keys.py",
    "packages/cli/src/commands/developer-tools.ts",
    "packages/cli/src/index.ts",
  ].map((path) => readFileSync(resolve(repoRoot, path), "utf8"));

  for (const source of sources) {
    assert.doesNotMatch(source, /sends_per_day|dollars_per_month_cents/u);
  }

  const typescriptSDK = sources[0];
  const createInput = /export interface CreateAPIKeyInput \{([\s\S]*?)\n\}/u.exec(
    typescriptSDK,
  )?.[1];
  assert.ok(createInput, "CreateAPIKeyInput missing from the TypeScript SDK");
  for (const field of CREATE_FIELDS) {
    assert.match(createInput, new RegExp(`\\b${field}\\??:`));
  }
});
