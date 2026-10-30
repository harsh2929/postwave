// SPDX-License-Identifier: AGPL-3.0-only

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const spec = JSON.parse(
  await readFile(new URL("../openapi.json", import.meta.url), "utf8"),
);

const heldOperations = [
  ["/api/v1/agency/children", "post"],
  ["/api/v1/agency/children/{id}", "delete"],
  ["/api/v1/agency/branding", "patch"],
  ["/api/v1/agency/billing-mode", "post"],
  ["/api/v1/agency/invoice-preview", "get"],
];

test("Agency publishes exactly two success-bearing bounded reads", () => {
  const children = spec.paths["/api/v1/agency/children"].get;
  const branding = spec.paths["/api/v1/agency/branding"].get;
  assert.deepEqual(
    Object.keys(children.responses).filter((code) => /^2/.test(code)),
    ["200"],
  );
  assert.deepEqual(
    Object.keys(branding.responses).filter((code) => /^2/.test(code)),
    ["200"],
  );
  assert.equal(
    children.responses["200"].content["application/json"].schema.$ref,
    "#/components/schemas/AgencyChildrenPage",
  );
  assert.equal(
    branding.responses["200"].content["application/json"].schema.$ref,
    "#/components/schemas/AgencyBranding",
  );
  for (const operation of [children, branding]) {
    assert.deepEqual(operation["x-required-scopes"], ["admin"]);
    assert.equal(operation["x-required-role"], "admin");
    assert.equal(
      operation.responses["200"].headers["Cache-Control"].$ref,
      "#/components/headers/AgencyPrivateNoStore",
    );
  }
});

test("all five unavailable Agency capabilities are structurally release-held", () => {
  for (const [path, method] of heldOperations) {
    const operation = spec.paths[path][method];
    assert.equal(
      operation["x-postwave-release-status"],
      "held",
      `${method} ${path}`,
    );
    assert.deepEqual(
      Object.keys(operation.responses).filter((code) => /^2/.test(code)),
      [],
      `${method} ${path} must not advertise success`,
    );
    assert.ok(
      operation.responses["503"],
      `${method} ${path} needs a stable hold response`,
    );
  }
  assert.equal(
    spec.paths["/api/v1/agency/children"].post.responses["503"].$ref,
    "#/components/responses/AgencyMutationReleaseHeld",
  );
  assert.equal(
    spec.paths["/api/v1/agency/invoice-preview"].get.responses["503"].$ref,
    "#/components/responses/AgencyInvoiceReleaseHeld",
  );
});

test("Agency roster and branding schemas are exact and continuation-safe", () => {
  const page = spec.components.schemas.AgencyChildrenPage;
  assert.equal(page.additionalProperties, false);
  assert.deepEqual(page.required, ["children", "count", "has_more"]);
  assert.equal(page.properties.children.maxItems, 200);
  assert.equal(page.properties.count.maximum, 200);
  assert.match(page.properties.count.description, /not a portfolio total/i);
  assert.deepEqual(page.allOf, [
    {
      if: { properties: { has_more: { const: true } } },
      then: { required: ["next_cursor"] },
      else: { not: { required: ["next_cursor"] } },
    },
  ]);

  const child = spec.components.schemas.AgencyChild;
  assert.equal(child.additionalProperties, false);
  for (const required of ["parent_tenant_id", "updated_at"]) {
    assert.ok(child.required.includes(required));
  }

  const branding = spec.components.schemas.AgencyBranding;
  assert.equal(branding.additionalProperties, false);
  for (const required of ["updated_at", "etag", "brand_name", "legal_entity"]) {
    assert.ok(branding.required.includes(required));
  }
  assert.equal(spec.components.schemas.AgencyBrandingPatch.minProperties, 1);
  assert.deepEqual(spec.components.schemas.AgencyBillingModeInput.required, [
    "target_tenant_id",
    "mode",
    "reason",
  ]);
});
