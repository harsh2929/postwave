// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock("@/lib/api", () => ({ api: mocks }));

import {
  formatTransformJSON,
  getCDPTransformOperations,
  parseTransformDraft,
  previewCDPTransforms,
} from "@/lib/cdp-transform-preview-api";

const CATALOG = ["trim", "lowercase", "truncate", "regex_replace"];

beforeEach(() => vi.clearAllMocks());

describe("CDP transform preview API", () => {
  it("strictly decodes a unique bounded operation catalog", async () => {
    mocks.get.mockResolvedValue({ ops: ["lowercase", "trim"] });
    await expect(getCDPTransformOperations({ fresh: true })).resolves.toEqual([
      "lowercase",
      "trim",
    ]);
    expect(mocks.get).toHaveBeenCalledWith("/api/v1/cdp/transforms/ops", {
      signal: undefined,
      requireOnline: true,
      maxAttempts: 1,
      cache: "no-store",
    });
    mocks.get.mockResolvedValue({ ops: ["trim", "trim"] });
    await expect(getCDPTransformOperations()).rejects.toThrow();
  });

  it("parses only registered operations and validates op-specific arguments", () => {
    const valid = parseTransformDraft(
      '{"name":" Ada "}',
      '[{"type":"truncate","field":"name","args":{"max":4}}]',
      CATALOG,
    );
    expect(valid.propertiesError).toBeNull();
    expect(valid.operations).toEqual([
      { type: "truncate", field: "name", args: { max: 4 } },
    ]);

    expect(
      parseTransformDraft(
        "{}",
        '[{"type":"truncate","field":"name","args":{"max":-1}}]',
        CATALOG,
      ).operationsError,
    ).toMatch(/integer max/u);
    expect(
      parseTransformDraft(
        "{}",
        '[{"type":"delete","field":"name"}]',
        CATALOG,
      ).operationsError,
    ).toMatch(/not registered/u);
    expect(
      parseTransformDraft(
        "{}",
        '[{"type":"trim","field":"__proto__.name"}]',
        CATALOG,
      ).operationsError,
    ).toMatch(/unsafe field path/u);
  });

  it("rejects dangerous property keys, excessive nesting, and malformed format requests", () => {
    expect(
      parseTransformDraft('{"__proto__":{"x":1}}', '[{"type":"trim","field":"x"}]', CATALOG)
        .propertiesError,
    ).toMatch(/Unsafe/u);
    const deep = `${"[".repeat(33)}0${"]".repeat(33)}`;
    expect(parseTransformDraft(`{"x":${deep}}`, '[{"type":"trim","field":"x"}]', CATALOG).propertiesError).toMatch(/32 levels/u);
    expect(() => formatTransformJSON("{", "properties")).toThrow(/invalid JSON|malformed/u);
  });

  it("uses a non-queueable read-only POST and reconciles every result", async () => {
    const operations = [
      { type: "trim", field: "name" },
      { type: "lowercase", field: "email" },
    ];
    mocks.post.mockResolvedValue({
      properties: { name: "Ada", email: "ada@example.com" },
      results: [
        {
          op: operations[0],
          changed: true,
          old_value: " Ada ",
          new_value: "Ada",
        },
        {
          op: operations[1],
          changed: true,
          old_value: "ADA@EXAMPLE.COM",
          new_value: "ada@example.com",
        },
      ],
      success: 2,
      failed: 0,
    });
    await expect(
      previewCDPTransforms({
        properties: { name: " Ada ", email: "ADA@EXAMPLE.COM" },
        operations,
      }),
    ).resolves.toMatchObject({ success: 2, failed: 0 });
    expect(mocks.post).toHaveBeenCalledWith(
      "/api/v1/cdp/transforms/preview",
      {
        properties: { name: " Ada ", email: "ADA@EXAMPLE.COM" },
        ops: operations,
      },
      {
        requireOnline: true,
        maxAttempts: 1,
        idempotencyKey: null,
        signal: undefined,
      },
    );
  });

  it.each([
    ["counter mismatch", { success: 0, failed: 0 }],
    [
      "operation mismatch",
      {
        results: [
          {
            op: { type: "lowercase", field: "name" },
            changed: true,
            old_value: " A ",
            new_value: "a",
          },
        ],
      },
    ],
    [
      "changed failure",
      {
        results: [
          {
            op: { type: "trim", field: "name" },
            changed: true,
            error: "failed",
          },
        ],
        success: 0,
        failed: 1,
      },
    ],
  ])("fails closed on %s", async (_label, override) => {
    mocks.post.mockResolvedValue({
      properties: { name: "A" },
      results: [
        {
          op: { type: "trim", field: "name" },
          changed: true,
          old_value: " A ",
          new_value: "A",
        },
      ],
      success: 1,
      failed: 0,
      ...override,
    });
    await expect(
      previewCDPTransforms({
        properties: { name: " A " },
        operations: [{ type: "trim", field: "name" }],
      }),
    ).rejects.toThrow();
  });
});
