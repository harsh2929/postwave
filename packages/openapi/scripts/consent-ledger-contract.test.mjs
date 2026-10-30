import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import YAML from "yaml";

const packageRoot = new URL("../", import.meta.url);
const spec = YAML.parse(
  readFileSync(new URL("openapi.yaml", packageRoot), "utf8"),
);
const packageJSON = JSON.parse(
  readFileSync(new URL("openapi.json", packageRoot), "utf8"),
);
const embeddedJSON = JSON.parse(
  readFileSync(
    new URL("../../apps/api/internal/apidocs/openapi.json", packageRoot),
    "utf8",
  ),
);
const routeAuthManifest = JSON.parse(
  readFileSync(
    new URL("../../apps/api/internal/routeauth/manifest.json", packageRoot),
    "utf8",
  ),
);

const sensitiveReads = [
  "/api/v1/consent/receipts",
  "/api/v1/consent/receipts/by-email/{email}",
  "/api/v1/consent/events",
];
const heldPortableExports = [
  "/api/v1/subscribers/{id}/consent-receipt.json",
  "/api/v1/subscribers/{id}/consent-receipt.zip",
];

function resolveResponse(response) {
  if (!response?.$ref) return response;
  const prefix = "#/components/responses/";
  assert.ok(response.$ref.startsWith(prefix), response.$ref);
  return spec.components.responses[response.$ref.slice(prefix.length)];
}

function parameters(operation) {
  return new Map(
    operation.parameters.map((parameter) => {
      if (!parameter.$ref) return [parameter.name, parameter];
      const prefix = "#/components/parameters/";
      assert.ok(parameter.$ref.startsWith(prefix), parameter.$ref);
      const resolved =
        spec.components.parameters[parameter.$ref.slice(prefix.length)];
      return [resolved.name, resolved];
    }),
  );
}

test("consent evidence reads have one exact reviewed admin boundary", () => {
  for (const path of sensitiveReads) {
    const operation = spec.paths[path]?.get;
    assert.ok(operation, path);
    assert.deepEqual(operation["x-required-scopes"], ["admin"]);
    assert.equal(operation["x-required-role"], "admin");
    assert.deepEqual(operation.security, [
      { bearerAuth: [] },
      { sessionCookie: [] },
    ]);
    assert.equal(
      operation["x-postwave-source"],
      "apps/api/internal/consent/ledger_reads.go",
    );
    for (const status of ["200", "400", "401", "403", "500", "503"]) {
      assert.ok(operation.responses[status], `${path} ${status}`);
    }
  }

  const policies = new Map(
    routeAuthManifest.routes.map((route) => [
      `${route.method} ${route.path}`,
      route,
    ]),
  );
  for (const path of sensitiveReads) {
    const policy = policies.get(`GET ${path}`);
    assert.ok(policy, path);
    assert.equal(policy.exposure, "authenticated");
    assert.deepEqual(policy.auth_methods, ["session", "api_key"]);
    assert.equal(policy.session_minimum_role, "admin");
    assert.deepEqual(policy.api_key_scopes, ["admin"]);
    assert.equal(policy.api_key_scope_mode, "any");
    assert.equal(policy.policy_source, "openapi.x-required-scopes");
    assert.equal(policy.review_status, "reviewed");
  }
});

test("portable consent exports expose only the exact-admin release hold", () => {
  const policies = new Map(
    routeAuthManifest.routes.map((route) => [
      `${route.method} ${route.path}`,
      route,
    ]),
  );
  for (const path of heldPortableExports) {
    const operation = spec.paths[path]?.get;
    assert.ok(operation, path);
    assert.equal(operation.deprecated, true);
    assert.deepEqual(operation["x-required-scopes"], ["admin"]);
    assert.equal(operation["x-required-role"], "admin");
    assert.deepEqual(operation.security, [
      { bearerAuth: [] },
      { sessionCookie: [] },
    ]);
    assert.deepEqual(Object.keys(operation.responses).sort(), [
      "401",
      "403",
      "503",
    ]);
    const unavailable = resolveResponse(operation.responses["503"]);
    assert.equal(
      unavailable.content["application/json"].example.error.code,
      "consent_receipt_export_unavailable",
    );
    assert.ok(unavailable.headers["Cache-Control"]);
    assert.ok(unavailable.headers.Vary);

    const policy = policies.get(`GET ${path}`);
    assert.ok(policy, path);
    assert.equal(policy.session_minimum_role, "admin");
    assert.deepEqual(policy.api_key_scopes, ["admin"]);
    assert.equal(policy.policy_source, "openapi.x-required-scopes");
    assert.equal(policy.review_status, "reviewed");
  }
});

test("consent evidence query contracts are bounded, strict, and cursor based", () => {
  const receipts = parameters(spec.paths["/api/v1/consent/receipts"].get);
  assert.deepEqual(
    [...receipts.keys()],
    ["limit", "cursor", "source", "since"],
  );
  assert.deepEqual(receipts.get("limit").schema, {
    type: "integer",
    minimum: 1,
    maximum: 1000,
    default: 200,
  });
  assert.equal(receipts.get("cursor").schema.maxLength, 8192);
  assert.equal(
    receipts.get("cursor")["x-postwave-cursor-integrity"],
    "hmac-sha256-canonical-envelope",
  );
  assert.match(receipts.get("cursor").description, /HMAC-authenticated/iu);
  assert.match(receipts.get("cursor").description, /offline dictionary/iu);
  assert.match(receipts.get("cursor").description, /no embedded expiry/iu);
  assert.match(
    receipts.get("cursor").description,
    /application logs and client telemetry[\s\S]*redact/iu,
  );
  assert.match(
    receipts.get("cursor").description,
    /edge and access-log query governance[\s\S]*deployment acceptance/iu,
  );
  assert.doesNotMatch(receipts.get("cursor").description, /must not be logged/iu);
  assert.doesNotMatch(receipts.get("cursor").description, /short-lived/iu);
  assert.equal(receipts.get("source").schema.maxLength, 512);
  assert.equal(receipts.get("since").schema.format, "date-time");

  const byEmail = parameters(
    spec.paths["/api/v1/consent/receipts/by-email/{email}"].get,
  );
  assert.deepEqual([...byEmail.keys()], ["limit", "cursor"]);

  const events = parameters(spec.paths["/api/v1/consent/events"].get);
  assert.deepEqual(
    [...events.keys()],
    ["limit", "cursor", "subject_type", "category", "action", "since"],
  );
  assert.deepEqual(spec.components.schemas.ConsentEventSubjectType.enum, [
    "visitor",
    "user",
    "subscriber",
    "workspace",
  ]);
  assert.deepEqual(spec.components.schemas.ConsentEventAction.enum, [
    "granted",
    "denied",
    "revoked",
    "opted_out",
    "imported",
  ]);
  assert.match(
    spec.paths["/api/v1/consent/events"].get.description,
    /unknown[\s\S]*duplicate[\s\S]*query parameters are[\s\S]*rejected/iu,
  );
});

test("consent receipt and event pages freeze the v1 wire envelope", () => {
  const receipts = spec.components.schemas.ConsentReceiptPage;
  assert.equal(receipts.additionalProperties, false);
  assert.deepEqual(receipts.required, [
    "schema_version",
    "workspace_id",
    "snapshot_at",
    "source_planes",
    "receipts",
    "count",
    "has_more",
  ]);
  assert.equal(receipts.properties.schema_version.const, 1);
  assert.equal(receipts.properties.workspace_id.format, "uuid");
  assert.deepEqual(
    receipts.properties.source_planes.prefixItems.map((item) => item.const),
    ["consent_receipts", "consent_records"],
  );
  assert.deepEqual(receipts.properties.source_planes.items, { not: {} });
  assert.equal(receipts.properties.receipts.maxItems, 1000);
  assert.equal(receipts.properties.next_cursor.maxLength, 8192);
  assert.equal(receipts.properties.total, undefined);
  assert.equal(receipts.properties.nextCursor, undefined);
  assert.equal(receipts.properties.email, undefined);

  const subjectReceipts = spec.components.schemas.ConsentSubjectReceiptPage;
  assert.equal(subjectReceipts.additionalProperties, false);
  assert.ok(subjectReceipts.required.includes("email"));
  assert.equal(subjectReceipts.properties.email.maxLength, 320);
  assert.equal(subjectReceipts.allOf, undefined);

  const receiptRow = spec.components.schemas.ConsentReceiptLedgerRow;
  assert.deepEqual(receiptRow.oneOf, [
    { $ref: "#/components/schemas/ConsentStateReceiptLedgerRow" },
    { $ref: "#/components/schemas/ConsentProofLedgerRow" },
  ]);
  const stateRow = spec.components.schemas.ConsentStateReceiptLedgerRow;
  const proofRow = spec.components.schemas.ConsentProofLedgerRow;
  for (const schema of [stateRow, proofRow]) {
    assert.equal(schema.additionalProperties, false);
    for (const field of ["kind", "id", "at", "recorded_at"]) {
      assert.ok(schema.required.includes(field), field);
    }
    assert.equal(schema.properties.source["x-postwave-max-utf8-bytes"], 512);
    assert.equal(
      schema.properties.source["x-postwave-max-unicode-code-points"],
      512,
    );
  }
  assert.equal(stateRow.properties.kind.const, "receipt");
  assert.match(stateRow.properties.id.pattern, /\[1-9\]/u);
  assert.deepEqual(stateRow.properties.new_state.enum, [
    "subscribed",
    "unsubscribed",
    "bounced",
    "complained",
    "pending",
  ]);
  assert.equal(proofRow.properties.kind.const, "proof");
  assert.equal(proofRow.properties.id.format, "uuid");
  assert.deepEqual(proofRow.properties.new_state.enum, [
    "granted",
    "withdrawn",
    "pending",
    "expired",
  ]);
  assert.deepEqual(spec.components.schemas.ConsentReceiptKind.enum, [
    "receipt",
    "proof",
  ]);
  assert.match(
    spec.components.schemas.ConsentReceiptKind.description,
    /\(kind, id\)/u,
  );

  const events = spec.components.schemas.ConsentEventPage;
  assert.equal(events.additionalProperties, false);
  assert.deepEqual(
    events.properties.source_planes.prefixItems.map((item) => item.const),
    ["consent_events"],
  );
  assert.equal(events.properties.events.maxItems, 1000);
  assert.equal(events.properties.total, undefined);
  const eventRow = spec.components.schemas.ConsentEventLedgerRow;
  assert.match(eventRow.description, /at least one durable subject identity/iu);
  assert.deepEqual(eventRow.anyOf, [
    { required: ["subject_id"] },
    { required: ["subject_email"] },
  ]);
  assert.equal(eventRow.properties.decision_id.format, "uuid");
  assert.ok(!eventRow.required.includes("decision_id"));
  assert.ok(eventRow.required.includes("recorded_at"));
  assert.equal(eventRow.properties.source["x-postwave-max-utf8-bytes"], 512);
  assert.equal(
    eventRow.properties.source["x-postwave-max-unicode-code-points"],
    512,
  );
  assert.equal(
    eventRow.properties.preferences["x-postwave-max-json-utf8-bytes"],
    65536,
  );

  for (const path of sensitiveReads) {
    const description = spec.paths[path].get.description;
    assert.match(description, /PostgreSQL\s+insert-visibility\s+boundary/u);
    assert.match(description, /full MVCC state/iu);
    assert.match(description, /successful\s+page[\s\S]*audit-recorded/u);
    assert.match(
      description,
      /authentication or[\s\S]*authorization[\s\S]*failures are not[\s\S]*claimed/iu,
    );
  }
});

test("public consent documents atomic keyed replay and strict GPC", () => {
  const operation = spec.paths["/api/public/consent"].post;
  assert.deepEqual(operation.security, []);
  assert.equal(operation["x-postwave-max-body-bytes"], 16384);
  assert.equal(
    operation["x-postwave-source"],
    "apps/api/internal/consent/events.go",
  );
  const params = parameters(operation);
  assert.equal(params.get("Idempotency-Key").required, false);
  assert.equal(params.get("Idempotency-Key").schema.maxLength, 255);
  assert.deepEqual(params.get("Sec-GPC").schema.enum, ["1"]);
  assert.ok(params.get("X-Postwave-Site-Key"));
  assert.equal(operation.responses["200"], undefined);
  for (const status of [
    "202",
    "400",
    "401",
    "409",
    "413",
    "415",
    "422",
    "429",
    "500",
    "503",
  ]) {
    assert.ok(operation.responses[status], status);
  }
  assert.ok(operation.responses["202"].headers["Idempotent-Replayed"]);
  assert.ok(operation.responses["202"].headers.Deprecation);

  const input = spec.components.schemas.PublicConsentInput;
  assert.equal(input.additionalProperties, false);
  assert.deepEqual(input.required, ["visitor_id", "choice"]);
  assert.deepEqual(input.properties.choice.enum, [
    "accept",
    "reject",
    "custom",
    "gpc",
  ]);
  assert.equal(input.allOf.length, 2);
  assert.deepEqual(
    input.allOf[0].then.properties.prefs.required,
    ["analytics", "marketing"],
  );
  assert.equal(
    input.allOf[0].then.properties.prefs.properties.analytics.const,
    true,
  );
  assert.equal(
    input.allOf[1].then.properties.prefs.properties.marketing.const,
    false,
  );
  assert.match(
    spec.components.schemas.PublicConsentPreferences.description,
    /contradictory|requires analytics=true/iu,
  );
  const response = spec.components.schemas.PublicConsentResponse;
  assert.equal(response.additionalProperties, false);
  assert.equal(response.properties.schema_version.const, 1);
  assert.equal(response.properties.ok.const, true);
  assert.equal(response.properties.idempotency_key.maxLength, 255);
  assert.match(
    response.properties.idempotency_key.description,
    /match it to the pending request/iu,
  );
  assert.ok(!response.required.includes("idempotency_key"));
  assert.equal(response.properties.decision_id.format, "uuid");
  assert.equal(response.properties.written.const, 3);
  assert.equal(response.properties.last_id.format, "uuid");
  assert.ok(response.required.includes("idempotent"));
  assert.deepEqual(spec.components.schemas.PublicConsentEventIDs.required, [
    "essential",
    "analytics",
    "marketing",
  ]);
});

test("RFC 8058 one-click is exact, no-store, and not shared-IP rate limited", () => {
  const path = "/api/public/preferences/{token}/one-click";
  const operation = spec.paths[path].post;
  assert.deepEqual(operation.security, []);
  assert.equal(operation["x-postwave-max-body-bytes"], 1024);
  assert.equal(
    operation["x-postwave-source"],
    "apps/api/internal/preferences/one_click.go:61",
  );
  assert.deepEqual(Object.keys(operation.responses).sort(), [
    "200",
    "400",
    "404",
    "410",
    "413",
    "500",
  ]);
  assert.match(operation.description, /outside the shared\s+10\/min\/IP/iu);
  const form =
    operation.requestBody.content["application/x-www-form-urlencoded"];
  assert.equal(
    form.schema.$ref,
    "#/components/schemas/OneClickUnsubscribeForm",
  );
  const raw = operation.requestBody.content["text/plain"].schema;
  assert.equal(raw.minLength, 26);
  assert.equal(raw.maxLength, 1024);
  assert.equal(raw["x-postwave-max-utf8-bytes"], 1024);

  for (const unresolved of Object.values(operation.responses)) {
    const response = resolveResponse(unresolved);
    assert.equal(
      response.headers["Cache-Control"].$ref,
      "#/components/headers/OneClickCacheControl",
    );
  }
  assert.equal(
    spec.components.headers.OneClickCacheControl.schema.const,
    "private, no-store",
  );
  const output = spec.components.schemas.OneClickUnsubscribeResponse;
  assert.equal(output.additionalProperties, false);
  assert.deepEqual(output.required, ["unsubscribed"]);
  assert.equal(output.properties.unsubscribed.const, true);

  const policy = routeAuthManifest.routes.find(
    (route) => route.method === "POST" && route.path === path,
  );
  assert.ok(policy);
  assert.equal(policy.exposure, "public");
  assert.deepEqual(policy.auth_methods, ["anonymous_or_route_credential"]);
});

test("all consent outcomes are private no-store and credential-varying", () => {
  const operations = [
    spec.paths["/api/public/consent"].post,
    ...sensitiveReads.map((path) => spec.paths[path].get),
  ];
  for (const operation of operations) {
    for (const [status, unresolved] of Object.entries(operation.responses)) {
      const response = resolveResponse(unresolved);
      assert.equal(
        response.headers["Cache-Control"].$ref,
        "#/components/headers/ConsentSensitiveCacheControl",
        `${operation.operationId} ${status} Cache-Control`,
      );
      assert.equal(
        response.headers.Vary.$ref,
        "#/components/headers/ConsentSensitiveVary",
        `${operation.operationId} ${status} Vary`,
      );
    }
  }
  assert.equal(
    spec.components.headers.ConsentSensitiveCacheControl.schema.const,
    "private, no-store",
  );
  assert.match(
    spec.components.headers.ConsentSensitiveCacheControl.description,
    /before[\s\S]*credential parsing[\s\S]*inner boundary/iu,
  );
});

test("canonical consent contracts are synchronized into both JSON mirrors", () => {
  for (const path of [
    "/api/public/consent",
    "/api/public/preferences/{token}/one-click",
    ...sensitiveReads,
  ]) {
    assert.deepEqual(packageJSON.paths[path], spec.paths[path], path);
    assert.deepEqual(embeddedJSON.paths[path], spec.paths[path], path);
  }
  for (const name of [
    "PublicConsentInput",
    "PublicConsentResponse",
    "OneClickUnsubscribeForm",
    "OneClickUnsubscribeResponse",
    "ConsentReceiptPage",
    "ConsentSubjectReceiptPage",
    "ConsentReceiptLedgerRow",
    "ConsentStateReceiptLedgerRow",
    "ConsentProofLedgerRow",
    "ConsentEventLedgerRow",
    "ConsentEventPage",
  ]) {
    assert.deepEqual(
      packageJSON.components.schemas[name],
      spec.components.schemas[name],
    );
    assert.deepEqual(
      embeddedJSON.components.schemas[name],
      spec.components.schemas[name],
    );
  }
});
