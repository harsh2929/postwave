import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { JSONPathPreview } from "../components/webhooks/JSONPathPreview";
import {
  evaluateJSONPath,
  matchOperator,
  validateJSONPath,
  validateMatchOperand,
} from "../lib/jsonpath";

/**
 * D12-comms-webhooks#8 — the trigger-editor preview evaluator must mirror
 * the BACKEND's limited JSONPath subset (inbound_webhooks/triggers.go), not
 * a full JSONPath, or the preview shows "✓ Trigger fires" for triggers that
 * are dead on arrival server-side.
 */
describe("jsonpath preview mirrors the server subset", () => {
  it("[*] resolves to the FIRST array element only, not every element", () => {
    const root = { items: [{ sku: "A" }, { sku: "B" }] };
    // Server tests items[0] only → 'B' never matches an equals("B").
    const matches = evaluateJSONPath(root, "$.items[*].sku");
    expect(matches).toEqual(["A"]);
    expect(matchOperator("equals", matches, "B")).toBe(false);
    expect(matchOperator("equals", matches, "A")).toBe(true);
  });

  it("[*] on a non-array (object) does not fan out over values", () => {
    const root = { obj: { a: 1, b: 2 } };
    expect(evaluateJSONPath(root, "$.obj[*]")).toEqual([]);
  });

  it("$..x is invalid instead of being silently collapsed", () => {
    const root = { email: "top@x.com", nested: { email: "deep@x.com" } };
    expect(evaluateJSONPath(root, "$..email")).toEqual([]);
    expect(evaluateJSONPath(root, "$..deepOnly")).toEqual([]);
    expect(validateJSONPath("$..email")).toMatch(/recursive descent/i);
  });

  it("rejects reserved characters in dotted keys exactly like the server", () => {
    const root = {
      "user*": "wildcard-looking",
      "user]": "bracket-looking",
      "user\\name": "escape-looking",
    };
    for (const path of ["$.user*", "$.user]", "$.user\\name"]) {
      expect(validateJSONPath(path)).not.toBeNull();
      expect(evaluateJSONPath(root, path)).toEqual([]);
    }
    expect(evaluateJSONPath(root, "$['user*']")).toEqual([
      "wildcard-looking",
    ]);
    // A closing bracket ends the server's deliberately narrow bracket
    // segment, and backslashes are unsupported even in quoted keys.
    expect(validateJSONPath("$['user]']")).not.toBeNull();
    expect(validateJSONPath("$['user\\name']")).not.toBeNull();
  });

  it("negative indexes never match", () => {
    const root = { xs: [10, 20, 30] };
    expect(evaluateJSONPath(root, "$.xs[-1]")).toEqual([]);
    expect(evaluateJSONPath(root, "$.xs[0]")).toEqual([10]);
  });

  it("plain dotted paths and non-negative indexes still resolve", () => {
    const root = { a: { b: [{ c: "hit" }] } };
    expect(evaluateJSONPath(root, "$.a.b[0].c")).toEqual(["hit"]);
  });

  it("accepts the server's quoted-key subset and rejects malformed brackets", () => {
    const root = { user: { email: "ada@example.com" } };
    expect(evaluateJSONPath(root, "$['user'].email")).toEqual([
      "ada@example.com",
    ]);
    expect(evaluateJSONPath(root, '$["user"].email')).toEqual([
      "ada@example.com",
    ]);
    for (const path of ["$['user].email", "$['us\\\\er'].email", "$.user["]) {
      expect(validateJSONPath(path)).not.toBeNull();
      expect(evaluateJSONPath(root, path)).toEqual([]);
    }
  });

  it("withholds definitive preview verdicts for invalid paths", () => {
    const markup = renderToStaticMarkup(
      createElement(JSONPathPreview, {
        sampleJSON: '{"user":{"email":"ada@example.com"}}',
        jsonpath: "$.user[",
        operator: "exists",
      }),
    );
    expect(markup).toContain("Invalid path");
    expect(markup).toContain("Preview withheld");
    expect(markup).not.toContain("Trigger fires");
    expect(markup).not.toContain("No match");
  });

  it("mirrors required values and bounded RE2-compatible regex validation", () => {
    expect(validateMatchOperand("equals", null)).toMatch(/requires/i);
    expect(validateMatchOperand("contains", "")).toMatch(/non-empty/i);
    expect(validateMatchOperand("regex", "")).toMatch(/non-empty/i);
    expect(validateMatchOperand("regex", "[")).toMatch(/valid regular/i);
    expect(validateMatchOperand("regex", "(?=vip)")).toMatch(/RE2/i);
    expect(validateMatchOperand("exists", null)).toBeNull();
  });

  it("never executes catastrophic regex patterns in the renderer", () => {
    const markup = renderToStaticMarkup(
      createElement(JSONPathPreview, {
        sampleJSON: JSON.stringify({ value: `${"a".repeat(10_000)}!` }),
        jsonpath: "$.value",
        operator: "regex",
        expected: "(a+)+$",
      }),
    );
    expect(markup).toContain("Regex preview withheld");
    expect(markup).toContain("does not execute");
    expect(markup).not.toContain("Trigger fires");
    expect(markup).not.toContain("No match");
  });
});
