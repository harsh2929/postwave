import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import YAML from "yaml";

const packageRoot = new URL("../", import.meta.url);
const spec = YAML.parse(
  readFileSync(new URL("openapi.yaml", packageRoot), "utf8"),
);

const collectionPath = "/api/v1/campaigns/{campaign}/polls";
const tallyPath = "/api/v1/campaigns/{campaign}/polls/{poll}/tally";
const publicPath = "/api/public/polls/{tenant}/{poll}/{option}";

test("authenticated campaign poll operations match the mounted scope split", () => {
  const materialize = spec.paths[collectionPath]?.post;
  const list = spec.paths[collectionPath]?.get;
  const tally = spec.paths[tallyPath]?.get;

  assert.ok(materialize);
  assert.ok(list);
  assert.ok(tally);
  assert.deepEqual(materialize["x-required-scopes"], ["write:campaigns"]);
  assert.equal(materialize["x-required-role"], "editor");
  assert.deepEqual(list["x-required-scopes"], ["read:campaigns"]);
  assert.equal(list["x-required-role"], "viewer");
  assert.deepEqual(tally["x-required-scopes"], ["read:reports"]);
  assert.equal(tally["x-required-role"], "viewer");
  for (const operation of [materialize, list, tally]) {
    assert.deepEqual(operation.security, [
      { bearerAuth: [] },
      { sessionCookie: [] },
    ]);
    assert.ok(operation.responses["200"] ?? operation.responses["201"]);
    assert.ok(operation.responses["401"]);
    assert.ok(operation.responses["403"]);
  }
  assert.equal(spec.paths["/api/v1/polls/{poll}/tally"], undefined);
});

test("campaign poll definitions use a bounded context-bound keyset page", () => {
  const list = spec.paths[collectionPath].get;
  const parameters = Object.fromEntries(
    list.parameters.map((parameter) => [parameter.name, parameter]),
  );
  assert.deepEqual(parameters.limit.schema, {
    type: "integer",
    minimum: 1,
    maximum: 100,
    default: 100,
  });
  assert.equal(parameters.cursor.schema.minLength, 1);
  assert.equal(parameters.cursor.schema.maxLength, 512);
  assert.match(parameters.cursor.description, /tenant- and campaign-bound/u);
  assert.match(list.responses["400"].description, /another tenant\/campaign context/u);

  const page = spec.components.schemas.CampaignPollList;
  assert.deepEqual(page.required, ["items"]);
  assert.equal(page.additionalProperties, false);
  assert.equal(page.properties.items.maxItems, 100);
  assert.equal(page.properties.next_cursor.maxLength, 512);
  assert.match(page.properties.next_cursor.description, /Omitted on the terminal page/u);
  assert.match(list.responses["200"].description, /`\(created_at, id\)`/u);
});

test("materialization input is closed and cannot duplicate AST meaning", () => {
  const input = spec.components.schemas.CampaignPollMaterializationInput;
  assert.equal(input.additionalProperties, false);
  assert.deepEqual(Object.keys(input.properties).sort(), [
    "closes_at",
    "content_revision_id",
    "poll_key",
    "two_step_required",
  ]);
  assert.deepEqual(input.required, ["content_revision_id", "poll_key"]);
  for (const forbidden of [
    "question",
    "options",
    "option_labels",
    "tenant_id",
    "recipient",
  ]) {
    assert.equal(forbidden in input.properties, false);
  }
});

test("tally exposes unknown classification as an exclusion, never a vote", () => {
  const tally = spec.components.schemas.CampaignPollTally;
  assert.equal(tally.additionalProperties, false);
  assert.ok(tally.required.includes("unclassified_excluded"));
  assert.ok(tally.required.includes("content_revision_id"));
  assert.ok(tally.required.includes("superseded_choices"));
  assert.ok(tally.required.includes("submission_receipts"));
  assert.match(
    tally.properties.unclassified_excluded.description,
    /unknown never defaults to human/u,
  );
  assert.match(
    tally.description,
    /Only an explicit human classification/u,
  );
  assert.equal(
    tally.properties.options.items.$ref,
    "#/components/schemas/CampaignPollOptionTally",
  );

  const option = spec.components.schemas.CampaignPollOptionTally;
  assert.match(option.properties.counted.description, /explicitly classified human/u);

  for (const schemaName of [
    "CampaignPollDefinition",
    "CampaignPollList",
    "CampaignPollTally",
  ]) {
    const properties = Object.keys(spec.components.schemas[schemaName].properties);
    assert.ok(!properties.some((name) => /tenant|recipient|token|email/u.test(name)));
  }
});

test("public GET previews and public POST reports the actual counted state", () => {
  const preview = spec.paths[publicPath]?.get;
  const confirm = spec.paths[publicPath]?.post;
  assert.ok(preview);
  assert.ok(confirm);
  assert.deepEqual(preview.security, []);
  assert.deepEqual(confirm.security, []);
  assert.match(preview.description, /A GET never records or counts/u);
  assert.match(preview.description, /text\/html[\s\S]*actually preferred/u);
  assert.match(confirm.description, /explicit human classification/u);
  assert.match(confirm.description, /form-urlencoded/u);
  assert.match(confirm.description, /does not redirect/u);

  const previewSchema = spec.components.schemas.CampaignPollPreview;
  assert.deepEqual(previewSchema.properties.recorded, {
    type: "boolean",
    const: false,
  });
  const confirmation = spec.components.schemas.CampaignPollConfirmation;
  assert.ok(confirmation.required.includes("state"));
  assert.ok(confirmation.required.includes("counted"));
  assert.deepEqual(spec.components.schemas.CampaignPollResponseState.enum, [
    "counted",
    "machine_excluded",
    "unclassified_excluded",
    "voided_multi_option",
    "superseded_choice",
  ]);
  for (const field of ["receipt_id", "replayed", "choice_changed"]) {
    assert.ok(confirmation.required.includes(field));
  }
  assert.ok(confirm.responses["428"]);
  assert.ok(confirm.responses["400"]);
  assert.ok(confirm.responses["409"]);
  assert.ok(preview.responses["200"].content["text/html"]);
  assert.ok(confirm.responses["200"].content["text/html"]);
  assert.equal(
    confirm.requestBody.content["application/x-www-form-urlencoded"].schema
      .additionalProperties,
    false,
  );
  assert.deepEqual(
    Object.keys(
      confirm.requestBody.content["application/x-www-form-urlencoded"].schema
        .properties,
    ),
    ["c"],
  );

  for (const operation of [preview, confirm]) {
    for (const response of Object.values(operation.responses)) {
      assert.equal(response.headers.Vary.schema.const, "Accept");
      assert.equal(response.headers["Cache-Control"].schema.const, "no-store");
      assert.equal(response.headers.Pragma.schema.const, "no-cache");
      assert.equal(response.headers["Referrer-Policy"].schema.const, "no-referrer");
      assert.match(
        response.headers["Content-Security-Policy"].schema.const,
        /default-src 'none'/u,
      );
      assert.ok(response.content["text/html"]);
    }
  }
});

test("SDK surfaces expose authenticated campaign operations without recipient credentials", () => {
  const sources = {
    go: readFileSync(new URL("../sdk-go/campaign_polls.go", packageRoot), "utf8"),
    python: readFileSync(
      new URL("../sdk-py/postwave/resources/campaign_polls.py", packageRoot),
      "utf8",
    ),
    typescript: readFileSync(
      new URL("../sdk-ts/src/resources/campaign-polls.ts", packageRoot),
      "utf8",
    ),
    php: readFileSync(
      new URL("../sdk-php/src/Resources/CampaignPollsResource.php", packageRoot),
      "utf8",
    ),
  };
  for (const [name, source] of Object.entries(sources)) {
    assert.match(source, /\/api\/v1\/campaigns\//u, `${name} campaign path`);
    assert.match(source, /\/polls/u, `${name} list/materialization path`);
    assert.match(source, /\/tally/u, `${name} tally path`);
    assert.doesNotMatch(source, /\/api\/public\/polls/u, `${name} must not expose signed recipient URLs`);
  }
});
