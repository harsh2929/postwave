import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { startDemoApi } from "./desktop-demo-api.mjs";

const apiKey = `pw_live_demo_${"a".repeat(48)}`;
let server;
let origin;

before(async () => {
  const started = await startDemoApi({ apiKey, port: 0 });
  server = started.server;
  origin = started.origin;
});

after(async () => {
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

test("serves health without a credential", async () => {
  const response = await fetch(`${origin}/api/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    status: "ok",
    version: "desktop-demo",
    service: "postwave-demo-api",
  });
});

test("uses API-key mode and returns a bounded demo identity", async () => {
  const session = await fetch(`${origin}/api/v1/auth/me`);
  assert.equal(session.status, 401);

  const identity = await fetch(`${origin}/api/v1/api-keys/me`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  assert.equal(identity.status, 200);
  assert.deepEqual(await identity.json(), {
    tenant_id: "00000000-0000-4000-8000-000000000099",
    tenant_slug: "postwave-desktop-demo",
    scopes: ["admin"],
    actor: "Demo host",
  });
});

test("hands reads to fixtures and rejects writes", async () => {
  const headers = { Authorization: `Bearer ${apiKey}` };
  const read = await fetch(`${origin}/api/v1/tags`, { headers });
  assert.equal(read.status, 404);
  assert.equal((await read.json()).error.code, "demo_fixture_fallback");

  const write = await fetch(`${origin}/api/v1/tags`, {
    method: "POST",
    headers,
  });
  assert.equal(write.status, 409);
  assert.equal((await write.json()).error.code, "demo_read_only");
});

test("keeps the authenticated demo event stream open", async () => {
  const headers = { Authorization: `Bearer ${apiKey}` };
  const tokenResponse = await fetch(`${origin}/api/v1/streams/token`, {
    method: "POST",
    headers,
  });
  assert.equal(tokenResponse.status, 200);
  const token = (await tokenResponse.json()).token;

  const controller = new AbortController();
  const stream = await fetch(
    `${origin}/api/v1/events?topics=campaign.*&stream_token=${encodeURIComponent(token)}`,
    { signal: controller.signal },
  );
  assert.equal(stream.status, 200);
  assert.match(stream.headers.get("content-type") ?? "", /^text\/event-stream/u);
  const firstChunk = await stream.body.getReader().read();
  assert.match(new TextDecoder().decode(firstChunk.value), /event: ready/u);
  controller.abort();
});
