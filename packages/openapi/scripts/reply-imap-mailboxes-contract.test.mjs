import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import YAML from "yaml";

const packageRoot = new URL("../", import.meta.url);
const spec = YAML.parse(
  readFileSync(new URL("openapi.yaml", packageRoot), "utf8"),
);

const routes = {
  list: ["/api/v1/replies/mailboxes", "get", ["read:reports"], "viewer"],
  create: ["/api/v1/replies/mailboxes", "post", ["admin"], "admin"],
  enable: ["/api/v1/replies/mailboxes/{id}/enable", "post", ["admin"], "admin"],
  disable: ["/api/v1/replies/mailboxes/{id}/disable", "post", ["admin"], "admin"],
  delete: ["/api/v1/replies/mailboxes/{id}", "delete", ["admin"], "admin"],
};

function resolveResponse(response) {
  if (!response.$ref) return response;
  const name = response.$ref.split("/").at(-1);
  return spec.components.responses[name];
}

test("all five tenant routes publish the mounted auth split and no-store boundary", () => {
  for (const [name, [path, method, scopes, role]] of Object.entries(routes)) {
    const operation = spec.paths[path]?.[method];
    assert.ok(operation, `${name} route missing`);
    assert.deepEqual(operation["x-required-scopes"], scopes);
    assert.equal(operation["x-required-role"], role);
    assert.deepEqual(operation.security, [
      { bearerAuth: [] },
      { sessionCookie: [] },
    ]);
    assert.match(operation["x-postwave-source"], /imap_mailbox_handlers\.go/u);
    for (const response of Object.values(operation.responses)) {
      const resolved = resolveResponse(response);
      assert.equal(
        resolved.headers["Cache-Control"].$ref,
        "#/components/headers/ReplyMailboxNoStore",
      );
    }
  }
  assert.equal(
    spec.components.headers.ReplyMailboxNoStore.schema.const,
    "no-store",
  );
});

test("create accepts only a closed disabled-first tenant-reference contract", () => {
  const create = spec.paths["/api/v1/replies/mailboxes"].post;
  assert.equal(create["x-postwave-max-body-bytes"], 16 * 1024);
  assert.equal(
    create.requestBody.content["application/json"].schema.$ref,
    "#/components/schemas/ReplyIMAPMailboxCreateInput",
  );
  const input = spec.components.schemas.ReplyIMAPMailboxCreateInput;
  assert.equal(input.additionalProperties, false);
  assert.deepEqual(input.required, [
    "label",
    "host",
    "username_secret_ref",
    "password_secret_ref",
  ]);
  assert.equal(input.properties.port.const, 993);
  assert.equal(input.properties.use_tls.const, true);
  assert.equal(input.properties.folder.default, "INBOX");
  const ref = spec.components.schemas.ReplyIMAPTenantSecretReference;
  assert.match(ref.pattern, /^\^env:POSTWAVE_REPLY_IMAP_TENANT_/u);
  assert.match(create.description, /disabled state/u);
  assert.match(create.description, /never accepts or returns credential values/u);
});

test("mailbox summaries expose operational and quarantine truth without credential values", () => {
  const mailbox = spec.components.schemas.ReplyIMAPMailbox;
  assert.equal(mailbox.additionalProperties, false);
  for (const field of [
    "enabled",
    "last_polled_at",
    "last_error",
    "security_quarantined_at",
    "security_quarantine_reason",
  ]) {
    assert.ok(mailbox.properties[field], `${field} missing`);
  }
  for (const forbidden of ["username", "password", "credential", "secret_value"]) {
    assert.equal(mailbox.properties[forbidden], undefined);
  }
  for (const field of ["username_secret_ref", "password_secret_ref"]) {
    const reference = new RegExp(mailbox.properties[field].pattern, "u");
    assert.equal(reference.test("hunter2"), false);
    assert.equal(reference.test("env:POSTWAVE_REPLY_IMAP_TENANT_A_USER"), true);
  }
  assert.match(mailbox.properties.password_secret_ref.description, /never returned/u);
  const list = spec.components.schemas.ReplyIMAPMailboxList;
  assert.equal(list.additionalProperties, false);
  assert.deepEqual(list.required, ["items"]);
  assert.equal(
    list.properties.items.items.$ref,
    "#/components/schemas/ReplyIMAPMailbox",
  );
});

test("enable documents quarantine refusal and delete documents cursor loss", () => {
  const enable = spec.paths["/api/v1/replies/mailboxes/{id}/enable"].post;
  assert.ok(enable.responses["409"]);
  assert.match(enable.description, /quarantined/u);
  const remove = spec.paths["/api/v1/replies/mailboxes/{id}"].delete;
  assert.ok(remove.responses["204"]);
  assert.match(remove.description, /poll cursor/u);
  assert.match(remove.description, /high-water mark/u);
  assert.match(remove.description, /can be skipped/u);
});
