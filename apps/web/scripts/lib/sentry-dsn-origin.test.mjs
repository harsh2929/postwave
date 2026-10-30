// SPDX-License-Identifier: AGPL-3.0-only

import assert from "node:assert/strict";
import test from "node:test";

import { sentryDsnOrigin } from "./sentry-dsn-origin.mjs";

test("accepts a normal Sentry DSN and returns only its HTTPS origin", () => {
  assert.equal(
    sentryDsnOrigin(
      "https://public-key@o4500000000000000.ingest.us.sentry.io/4500000000000001?sample=secret#fragment",
    ),
    "https://o4500000000000000.ingest.us.sentry.io",
  );
});

test("rejects passwords, non-HTTPS schemes, and malformed DSNs", () => {
  assert.equal(
    sentryDsnOrigin("https://public-key:secret@ingest.sentry.io/1"),
    null,
  );
  assert.equal(
    sentryDsnOrigin("http://public-key@ingest.sentry.io/1"),
    null,
  );
  assert.equal(sentryDsnOrigin("//public-key@ingest.sentry.io/1"), null);
  assert.equal(sentryDsnOrigin("not a URL"), null);
  assert.equal(sentryDsnOrigin(undefined), null);
});

test("an HTTPS endpoint without userinfo remains a safe CSP origin", () => {
  assert.equal(
    sentryDsnOrigin("https://ingest.sentry.io/api/1/envelope/"),
    "https://ingest.sentry.io",
  );
});
