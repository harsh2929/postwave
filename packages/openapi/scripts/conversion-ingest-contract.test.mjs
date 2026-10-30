import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../../../", import.meta.url);
const spec = JSON.parse(
  await readFile(new URL("packages/openapi/openapi.json", root), "utf8"),
);
const embeddedSpec = JSON.parse(
  await readFile(
    new URL("apps/api/internal/apidocs/openapi.json", root),
    "utf8",
  ),
);
assert.deepEqual(
  embeddedSpec,
  spec,
  "published and API-embedded OpenAPI artifacts have drifted",
);

const routes = [
  "/api/public/conversions/ingest",
  "/api/public/conversions/ingest/batch",
];
for (const path of routes) {
  const operation = spec.paths?.[path]?.post;
  assert.ok(operation, `${path} POST is absent`);
  assert.deepEqual(
    operation.security,
    [{ signedConversionHMAC: [] }],
    `${path} must advertise HMAC auth rather than bearer/session/no-auth`,
  );
  const parameterNames = operation.parameters.map((parameter) => {
    const name = parameter.$ref?.split("/").at(-1);
    return spec.components.parameters[name]?.name;
  });
  assert.deepEqual(parameterNames, [
    "X-Postwave-Timestamp",
    "X-Postwave-Signature",
    "Idempotency-Key",
  ]);
  for (const status of [
    "202",
    "400",
    "401",
    "409",
    "413",
    "429",
    "500",
    "503",
  ]) {
    assert.ok(operation.responses[status], `${path} omits response ${status}`);
  }
  assert.match(operation.description, /exact raw/i);
  assert.match(operation.description, /never include|no tenant identifier/i);
}

assert.deepEqual(
  spec.paths[routes[0]].post.requestBody.content["application/json"].schema,
  {
    $ref: "#/components/schemas/SignedConversionInput",
  },
);
assert.deepEqual(
  spec.paths[routes[1]].post.requestBody.content["application/json"].schema,
  {
    $ref: "#/components/schemas/SignedConversionBatchInput",
  },
);
assert.equal(
  spec.components.securitySchemes.signedConversionHMAC.type,
  "apiKey",
);
assert.equal(
  spec.components.securitySchemes.signedConversionHMAC.name,
  "X-Postwave-Signature",
);

for (const schemaName of [
  "SignedConversionInput",
  "SignedConversionIdentity",
  "SignedConversionBatchInput",
  "SignedConversionReceipt",
  "SignedConversionBadRequest",
  "SignedConversionUnauthorized",
  "SignedConversionConflict",
]) {
  assert.equal(
    spec.components.schemas[schemaName].additionalProperties,
    false,
    `${schemaName} is not a closed object`,
  );
}
const receiptProperties = Object.keys(
  spec.components.schemas.SignedConversionReceipt.properties,
);
assert.deepEqual(receiptProperties.sort(), [
  "accepted",
  "conversion_ids",
  "key_id",
]);
assert.ok(!receiptProperties.some((name) => /tenant|workspace/i.test(name)));
assert.equal(
  spec.components.schemas.SignedConversionBatchInput.properties.conversions
    .maxItems,
  500,
);
assert.equal(
  spec.components.parameters.SignedConversionIdempotencyKey.required,
  true,
);
assert.equal(
  spec.components.headers.SignedConversionCacheControl.schema.const,
  "private, no-store",
);
const signedIdentity = spec.components.schemas.SignedConversionIdentity;
assert.ok(Object.hasOwn(signedIdentity.properties, "email_hmac_sha256"));
assert.ok(!Object.hasOwn(signedIdentity.properties, "email_sha256"));
assert.ok(
  signedIdentity.anyOf.some((branch) =>
    branch.required?.includes("email_hmac_sha256"),
  ),
);
assert.ok(
  spec.components.schemas.SignedConversionBadRequest.properties.error.enum.includes(
    "unsafe_email_sha256_rejected",
  ),
);
for (const path of routes) {
  assert.equal(
    spec.paths[path].post.responses["503"].content["application/json"].schema
      .$ref,
    "#/components/schemas/SignedConversionUnavailable",
    `${path} must advertise the projection-not-ready failure`,
  );
}
assert.deepEqual(spec.components.schemas.SignedConversionUnavailable.oneOf, [
  { $ref: "#/components/schemas/SignedConversionRateLimitUnavailable" },
  { $ref: "#/components/schemas/SignedConversionProjectionUnavailable" },
]);
assert.equal(
  spec.components.schemas.SignedConversionProjectionUnavailable.properties.error
    .const,
  "email_identity_projection_not_ready",
);

const secretCollection = spec.paths["/api/v1/conversions/ingest-secrets"];
const secretRevocation =
  spec.paths["/api/v1/conversions/ingest-secrets/{keyID}/revoke"];
assert.ok(secretCollection?.get, "signing-key list route is absent");
assert.ok(secretCollection?.post, "signing-key issue route is absent");
assert.ok(secretRevocation?.post, "signing-key revoke route is absent");
for (const operation of [
  secretCollection.get,
  secretCollection.post,
  secretRevocation.post,
]) {
  assert.deepEqual(operation.security, [
    { bearerAuth: [] },
    { sessionCookie: [] },
  ]);
  assert.deepEqual(operation["x-required-scopes"], ["admin"]);
  assert.equal(operation["x-required-role"], "admin");
  assert.match(operation["x-postwave-source"], /ingest_secret_handlers\.go/);
}
assert.equal(secretCollection.post["x-postwave-max-body-bytes"], 1024);
assert.equal(secretCollection.post["x-postwave-idempotency"], "forbidden");
assert.equal(secretCollection.post["x-postwave-retry-policy"], "one-attempt");
assert.ok(
  !(secretCollection.post.parameters ?? []).some(
    (parameter) => parameter.name?.toLowerCase() === "idempotency-key",
  ),
  "reveal-once signing-key issuance must not advertise Idempotency-Key",
);
assert.match(secretCollection.post.description, /MUST NOT be sent/);
assert.match(
  secretCollection.post.description,
  /excluded from the durable replay ledger/,
);
assert.match(
  secretCollection.post.description,
  /never be retried\s+automatically/,
);
assert.match(secretCollection.post.description, /list key metadata/);
assert.match(secretCollection.post.description, /revoke it/);
assert.match(secretCollection.post.description, /never retry issuance blindly/);
assert.match(secretCollection.post.description, /Every response/);
assert.match(secretCollection.post.description, /private, no-store/);
assert.match(
  secretCollection.post.responses["400"].description,
  /Idempotency-Key/,
);
assert.equal(secretRevocation.post["x-postwave-bodyless"], true);
assert.equal(
  secretCollection.post.responses["201"].headers["Cache-Control"].schema.const,
  "private, no-store",
);
assert.deepEqual(
  secretCollection.get.parameters.map((parameter) => parameter.name),
  ["limit", "cursor"],
);
assert.equal(secretCollection.get.parameters[0].schema.default, 100);
assert.equal(secretCollection.get.parameters[0].schema.maximum, 100);
assert.equal(secretCollection.get.parameters[1].schema.maxLength, 512);
assert.ok(secretCollection.get.responses["400"]);
assert.ok(secretCollection.post.responses["409"]);
assert.equal(
  spec.components.schemas.ConversionIngestSecretList.properties.items.maxItems,
  100,
);
assert.equal(
  spec.components.schemas.ConversionIngestSecretList.properties.next_cursor
    .maxLength,
  512,
);
assert.ok(
  !spec.components.schemas.ConversionIngestSecretList.required.includes(
    "next_cursor",
  ),
);

for (const schemaName of [
  "ConversionIngestSecretSummary",
  "ConversionIngestSecretIssued",
]) {
  const schema = spec.components.schemas[schemaName];
  assert.equal(schema.additionalProperties, false);
  assert.ok(schema.required.includes("identity_projection_status"));
  assert.ok(schema.required.includes("identity_projection_updated_at"));
  assert.equal(
    schema.properties.identity_projection_updated_at.format,
    "date-time",
  );
  assert.ok(!schema.required.includes("identity_projection_error_code"));
  assert.deepEqual(schema.allOf[0].then.required, [
    "identity_projection_error_code",
  ]);
  assert.deepEqual(schema.allOf[0].else.not.required, [
    "identity_projection_error_code",
  ]);
  assert.ok(
    !Object.keys(schema.properties).some((name) =>
      /count|cardinality|subscriber|digest/i.test(name),
    ),
    `${schemaName} leaks projection or tenant scale`,
  );
}
assert.deepEqual(
  spec.components.schemas.ConversionEmailHMACProjectionStatus.enum,
  ["pending", "ready", "failed"],
);
assert.deepEqual(
  spec.components.schemas.ConversionEmailHMACProjectionErrorCode.enum,
  ["secret_unavailable", "projection_failed"],
);
assert.equal(
  spec.components.schemas.ConversionIngestSecretIssued.properties.secret
    .readOnly,
  true,
);
assert.ok(
  spec.components.schemas.ConversionIngestSecretIssueResponse.required.includes(
    "notice",
  ),
);

const [
  main,
  projectionRuntime,
  projectionWorker,
  goSDK,
  pythonSDK,
  typeScriptSDK,
] = await Promise.all([
  readFile(new URL("apps/api/main.go", root), "utf8"),
  readFile(
    new URL(
      "apps/api/cmd/campaign-assurance-worker/email_hmac_projection.go",
      root,
    ),
    "utf8",
  ),
  readFile(
    new URL(
      "apps/api/internal/conversions/email_hmac_projection_worker.go",
      root,
    ),
    "utf8",
  ),
  readFile(new URL("packages/sdk-go/conversion_ingest.go", root), "utf8"),
  readFile(
    new URL("packages/sdk-py/postwave/resources/conversion_ingest.py", root),
    "utf8",
  ),
  readFile(
    new URL("packages/sdk-ts/src/resources/conversion-ingest.ts", root),
    "utf8",
  ),
]);
assert.match(main, /MountSignedIngestRoutes/);
assert.match(main, /httpcache\.WithPolicy\(httpcache\.Mutation\(\)\)/);
assert.match(main, /publicRateLimit\.Middleware/);
assert.match(main, /Cipher:\s+envCipher/);
assert.match(projectionRuntime, /pwcrypto\.NewKMSEnvelope\(/);
for (const [name, source] of Object.entries({
  projectionRuntime,
  projectionWorker,
})) {
  assert.doesNotMatch(
    source,
    /NewKMSEnvelopeWithFallback|POSTWAVE_SENDING_KEK|LegacyKEK|legacyKEK/,
    `${name} retains a legacy KEK dependency in the exact-KMS projection path`,
  );
}
for (const [name, source] of Object.entries({
  goSDK,
  pythonSDK,
  typeScriptSDK,
})) {
  assert.match(
    source,
    /postwave-conversion-v2/,
    `${name} does not implement the v2 preimage`,
  );
  assert.match(
    source,
    /\/api\/public\/conversions\/ingest/,
    `${name} does not expose single ingest`,
  );
  assert.match(
    source,
    /\/api\/public\/conversions\/ingest\/batch/,
    `${name} does not expose batch ingest`,
  );
  assert.match(
    source,
    /email_hmac_sha256|EmailHMACSHA256/,
    `${name} does not expose tenant-keyed email identity`,
  );
  assert.doesNotMatch(
    source,
    /json:"email_sha256|email_sha256\?:|email_sha256:/,
    `${name} still exposes unsalted email_sha256 as current identity`,
  );
}

console.log("signed conversion ingest route/OpenAPI/SDK contract: ok");
