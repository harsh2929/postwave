// SPDX-License-Identifier: AGPL-3.0-only
//
// The audit portal is embedded in a customer's page by an SDK, so the iframe
// boundary is a trust boundary in both directions.
//
// Outbound is handled: notifyParent posts only to the exact HTTPS origin the
// embedding SDK supplied, only when actually framed, and never to "*". A "*"
// targetOrigin would broadcast portal state to whatever page happened to frame
// it, including one that framed it without permission.
//
// Inbound is handled by not existing. There is no window "message" listener at
// all, which is the strongest available answer: an embedded widget that
// listens without comparing event.origin will act on instructions from any
// page on the internet that can get a handle to it. Nothing today catches the
// addition of one, which is what this file is for — if a listener ever
// arrives, it has to check the origin against the same validated value the
// outbound path uses.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { normalizeParentOriginForTest } from "./bootstrap";

const SRC = resolve(process.cwd(), "src");

function sources(): { rel: string; text: string }[] {
  const out: { rel: string; text: string }[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) {
        walk(p);
        continue;
      }
      if (!/\.tsx?$/.test(p) || /\.test\.tsx?$/.test(p)) continue;
      out.push({ rel: p.slice(SRC.length + 1), text: readFileSync(p, "utf8") });
    }
  };
  walk(SRC);
  return out;
}

describe("iframe trust boundary", () => {
  const files = sources();

  it("reads the portal source", () => {
    // Guard the guard: an empty walk passes every check below while proving
    // nothing about a security boundary.
    expect(files.length).toBeGreaterThan(3);
    expect(files.some((f) => /postMessage\(/.test(f.text))).toBe(true);
  });

  it("never posts to a wildcard target origin", () => {
    const wildcard = files
      .filter((f) => /postMessage\([^)]*,\s*["']\*["']/.test(f.text))
      .map((f) => f.rel);
    expect(wildcard.sort()).toEqual([]);
  });

  it("posts only to the validated parent origin, and only when framed", () => {
    const app = files.find((f) => f.rel === "App.tsx");
    expect(app, "App.tsx not found").toBeDefined();
    expect(app!.text).toMatch(
      /const targetOrigin = portalParentOrigin\(\);/,
    );
    // Both conditions matter: a non-empty origin AND an actual parent frame.
    expect(app!.text).toMatch(
      /if \(targetOrigin && window\.parent !== window\)/,
    );
  });

  it("registers no inbound message listener without an origin check", () => {
    // The rule, not a prohibition: a listener may exist, but it must compare
    // event.origin. Today there are none, so this is a tripwire.
    const offenders: string[] = [];
    for (const f of files) {
      if (!/addEventListener\(\s*["']message["']/.test(f.text)) continue;
      if (!/\.origin\s*!==|\.origin\s*===/.test(f.text)) {
        offenders.push(`${f.rel}: message listener with no event.origin check`);
      }
    }
    expect(offenders.sort()).toEqual([]);
  });
});

describe("parent origin validation", () => {
  it("accepts a bare HTTPS origin", () => {
    expect(normalizeParentOriginForTest("https://app.customer.com")).toBe(
      "https://app.customer.com",
    );
    expect(normalizeParentOriginForTest("https://app.customer.com/")).toBe(
      "https://app.customer.com",
    );
  });

  it("rejects anything that is not a bare HTTPS origin", () => {
    for (const raw of [
      "http://app.customer.com", // plaintext
      "https://user:pw@app.customer.com/", // embedded credentials
      "https://app.customer.com/path", // path
      "https://app.customer.com/?a=1", // query
      "https://app.customer.com/#f", // fragment
      "javascript:alert(1)", // scheme abuse
      "not a url",
      "",
    ]) {
      expect(normalizeParentOriginForTest(raw), raw).toBe("");
    }
  });

  it("rejects an absurdly long value rather than parsing it", () => {
    expect(
      normalizeParentOriginForTest(`https://${"a".repeat(600)}.com`),
    ).toBe("");
  });

  it("returns empty for a missing value, so notifyParent stays silent", () => {
    // The empty string is what makes the `targetOrigin &&` guard in App.tsx
    // fail closed: no origin, no post.
    expect(normalizeParentOriginForTest(null)).toBe("");
  });
});
