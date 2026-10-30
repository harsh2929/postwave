// API Reference tab helpers (full-surface wiring #58): the tree
// builder groups by first tag, surfaces schema NAMES from $ref
// pointers (no inlining), and tolerates malformed spec fragments
// without throwing.

import { describe, expect, it } from "vitest";

import {
  buildReferenceTree,
  countOperations,
  schemaNameFromRef,
  schemaNameOf,
} from "../pages/api-reference-helpers";

describe("schemaNameFromRef", () => {
  it("takes the last path segment", () => {
    expect(schemaNameFromRef("#/components/schemas/CampaignRow")).toBe(
      "CampaignRow",
    );
  });
});

describe("schemaNameOf", () => {
  it("resolves refs, ref arrays, and plain types", () => {
    expect(schemaNameOf({ $ref: "#/components/schemas/Foo" })).toBe("Foo");
    expect(
      schemaNameOf({
        type: "array",
        items: { $ref: "#/components/schemas/Foo" },
      }),
    ).toBe("Foo[]");
    expect(schemaNameOf({ type: "array", items: {} })).toBe("array");
    expect(schemaNameOf({ type: "object" })).toBe("object");
    expect(schemaNameOf({ type: "string" })).toBe("string");
  });

  it("returns undefined for nothing-to-say inputs", () => {
    expect(schemaNameOf(undefined)).toBeUndefined();
    expect(schemaNameOf(null)).toBeUndefined();
    expect(schemaNameOf({})).toBeUndefined();
    expect(schemaNameOf("ref")).toBeUndefined();
  });
});

describe("buildReferenceTree", () => {
  const spec = {
    paths: {
      "/api/v1/campaigns": {
        get: {
          tags: ["campaigns"],
          summary: "List campaigns",
          parameters: [
            {
              name: "status",
              in: "query",
              required: false,
              schema: { type: "string" },
            },
          ],
          responses: {
            "200": {
              description: "OK",
              content: {
                "application/json": {
                  schema: {
                    type: "array",
                    items: { $ref: "#/components/schemas/CampaignRow" },
                  },
                },
              },
            },
          },
        },
        post: {
          tags: ["campaigns"],
          summary: "Create campaign",
          requestBody: {
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/CampaignCreate" },
              },
            },
          },
          responses: {
            "201": { description: "Created" },
            "400": { description: "Validation failed" },
          },
        },
      },
      "/api/v1/anon": {
        get: { summary: "No tags → general" },
      },
    },
  };

  it("groups by first tag, sorts tags alpha, untagged → general", () => {
    const tree = buildReferenceTree(spec);
    expect(tree.map((g) => g.tag)).toEqual(["campaigns", "general"]);
    expect(countOperations(tree)).toBe(3);
  });

  it("orders operations by path then canonical method order", () => {
    const ops = buildReferenceTree(spec)[0]?.operations ?? [];
    expect(ops.map((o) => o.method)).toEqual(["get", "post"]);
  });

  it("extracts params, request schema name, and response schema names", () => {
    const [getOp, postOp] = buildReferenceTree(spec)[0]?.operations ?? [];
    expect(getOp?.params).toEqual([
      {
        name: "status",
        location: "query",
        required: false,
        type: "string",
        description: undefined,
      },
    ]);
    expect(getOp?.responses).toEqual([
      { status: "200", description: "OK", schema: "CampaignRow[]" },
    ]);
    expect(postOp?.requestSchema).toBe("CampaignCreate");
    expect(postOp?.responses.map((r) => r.status)).toEqual(["201", "400"]);
  });

  it("never throws on malformed fragments", () => {
    expect(buildReferenceTree(null)).toEqual([]);
    expect(buildReferenceTree({})).toEqual([]);
    expect(buildReferenceTree({ paths: { "/x": null } })).toEqual([]);
    expect(
      buildReferenceTree({ paths: { "/x": { get: "not-an-object" } } }),
    ).toEqual([]);
    expect(
      buildReferenceTree({
        paths: { "/x": { get: { parameters: [{ in: "query" }] } } },
      })[0]?.operations[0]?.params,
    ).toEqual([]);
  });
});
