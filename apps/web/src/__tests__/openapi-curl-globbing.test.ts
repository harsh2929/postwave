// SPDX-License-Identifier: AGPL-3.0-only
//
// Every API reference page renders a copy-pasteable curl under "Try it".
// curl treats {} and [] in a URL as glob patterns, so
//
//     curl -X GET "https://api.moosewave.com/api/v1/subscribers/{id}"
//
// does not request that path. curl expands the single-item set and asks for
// /api/v1/subscribers/id — verified against the real binary:
//
//     $ curl -o /dev/null -w '%{url_effective}' "http://127.0.0.1:1/x/{id}"
//     http://127.0.0.1:1/x/id
//
// The reader gets a 404 that looks like a bad key or a wrong endpoint, with
// nothing on the page to suggest otherwise. 807 of the spec's 1538 paths are
// parameterised, so this was every one of their examples. --globoff keeps the
// placeholder visible and the request literal.
import { describe, expect, it } from "vitest";

import { buildCurl } from "@/components/docs/OpenAPIEndpoint";
import { listOperations } from "@/lib/docs/loadOpenAPI";

describe("generated curl examples", () => {
  const ops = listOperations();

  it("has parameterised paths to check", () => {
    // Guard the guard: no operations, or none with path parameters, would
    // make the sweep below pass without checking anything.
    expect(ops.length).toBeGreaterThan(100);
    expect(ops.filter((o) => /[{[]/.test(o.path)).length).toBeGreaterThan(100);
  });

  it("disables globbing on every URL containing braces", () => {
    const unsafe = ops
      .filter((o) => /[{[]/.test(o.path))
      .filter((o) => !/curl\s+--globoff\b/.test(buildCurl(o)))
      .map((o) => `${o.method.toUpperCase()} ${o.path}`);
    expect(unsafe.slice(0, 10)).toEqual([]);
  });

  it("leaves plain paths alone", () => {
    // --globoff on a URL with no braces is noise in a doc example.
    const noisy = ops
      .filter((o) => !/[{[]/.test(o.path))
      .filter((o) => /--globoff/.test(buildCurl(o)))
      .map((o) => `${o.method.toUpperCase()} ${o.path}`);
    expect(noisy.slice(0, 10)).toEqual([]);
  });

  it("keeps the flag before the URL, where curl reads it", () => {
    const sample = ops.find((o) => /[{[]/.test(o.path));
    expect(sample).toBeDefined();
    const curl = buildCurl(sample!);
    expect(curl.indexOf("--globoff")).toBeLessThan(curl.indexOf("http"));
    // And the placeholder must survive — substituting it away would hide
    // which segment the reader has to replace.
    expect(curl).toMatch(/\{/);
  });

  it("authenticates the way the spec says to", () => {
    // The spec's top-level security is bearerAuth (http/bearer), so the
    // example header has to be Authorization: Bearer, not an X-API-Key.
    const curl = buildCurl(ops[0]!);
    expect(curl).toContain('-H "Authorization: Bearer $POSTWAVE_API_KEY"');
  });
});
