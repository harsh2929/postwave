import { describe, expect, it } from "vitest";

import openapi from "../../../../packages/openapi/openapi.json";
import {
  normalizePlaygroundCatalog,
  type NormalizedPlaygroundOperation,
} from "../pages/api-playground-openapi";
import {
  executionPolicyFor,
  reviewedExecutionKeys,
} from "../pages/api-playground-policy";

function operationCount(spec: typeof openapi): number {
  const methods = new Set(["get", "post", "put", "patch", "delete"]);
  return Object.values(spec.paths).reduce(
    (total, item) =>
      total + Object.keys(item).filter((key) => methods.has(key)).length,
    0,
  );
}

function keyOf(operation: NormalizedPlaygroundOperation): string {
  return `${operation.method.toUpperCase()} ${operation.path}`;
}

describe("API Playground OpenAPI normalization", () => {
  it("requires an explicit OpenAPI 3.1 dialect", () => {
    for (const openapiVersion of [undefined, "3.0.3", "4.0.0"]) {
      expect(() =>
        normalizePlaygroundCatalog({
          ...(openapiVersion ? { openapi: openapiVersion } : {}),
          paths: {
            "/api/v1/tags": {
              get: {
                responses: {
                  "200": { content: { "application/json": {} } },
                },
              },
            },
          },
        }),
      ).toThrow("requires an explicit OpenAPI 3.1 document");
    }
  });

  it("resolves refs and applies operation parameter overrides", () => {
    const catalog = normalizePlaygroundCatalog({
      openapi: "3.1.0",
      info: { title: "Fixture", version: "1" },
      security: [{ bearerAuth: [] }],
      components: {
        parameters: {
          ResourceId: {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string", example: "from-ref" },
          },
        },
      },
      paths: {
        "/api/v1/resources/{id}": {
          parameters: [{ $ref: "#/components/parameters/ResourceId" }],
          get: {
            operationId: "getResource",
            tags: ["Resources"],
            parameters: [
              {
                name: "id",
                in: "path",
                required: true,
                description: "Operation wins",
                schema: { type: "string" },
              },
            ],
            responses: { "200": { content: { "application/json": {} } } },
          },
        },
      },
    });

    expect(catalog.operations).toHaveLength(1);
    expect(catalog.operations[0]?.parameters).toEqual([
      expect.objectContaining({
        name: "id",
        location: "path",
        required: true,
        description: "Operation wins",
      }),
    ]);
    expect(catalog.operations[0]?.contractIssues).toEqual([]);
  });

  it("normalizes every operation and every path placeholder in the live spec", () => {
    const catalog = normalizePlaygroundCatalog(openapi);
    expect(catalog.operations).toHaveLength(operationCount(openapi));
    expect(catalog.operations.length).toBeGreaterThanOrEqual(1_959);

    for (const operation of catalog.operations) {
      const placeholders = [...operation.path.matchAll(/\{([^{}]+)\}/g)].map(
        (match) => match[1],
      );
      for (const placeholder of new Set(placeholders)) {
        expect(
          operation.parameters.filter(
            (parameter) =>
              parameter.location === "path" && parameter.name === placeholder,
          ),
          `${keyOf(operation)} must expose ${placeholder} exactly once`,
        ).toHaveLength(1);
      }
    }
  });

  it("keeps execution default-deny while preserving the reviewed customer set", () => {
    const operations = normalizePlaygroundCatalog(openapi).operations;
    const byKey = new Map(
      operations.map((operation) => [keyOf(operation), operation]),
    );

    for (const key of reviewedExecutionKeys()) {
      const operation = byKey.get(key);
      expect(
        operation,
        `${key} must remain in the canonical spec`,
      ).toBeDefined();
      expect(executionPolicyFor(operation!).executable, key).toBe(true);
    }

    for (const key of [
      "POST /api/v1/tags",
      "PATCH /api/v1/tags/{id}",
      "DELETE /api/v1/tags/{id}",
    ]) {
      expect(executionPolicyFor(byKey.get(key)!).idempotency, key).toBe(
        "optional",
      );
    }

    const held = operations.filter((operation) => operation.releaseHold);
    expect(held).toHaveLength(56);
    expect(
      held.every((operation) => !executionPolicyFor(operation).executable),
    ).toBe(true);
    expect(
      operations
        .filter((operation) => operation.explicitlyPublic)
        .every((operation) => !executionPolicyFor(operation).executable),
    ).toBe(true);
    const underspecified = byKey.get("GET /api/v1/suppressions");
    expect(underspecified).toBeDefined();
    expect(executionPolicyFor(underspecified!).executable).toBe(false);
    expect(executionPolicyFor(underspecified!).reason).toContain(
      "response media is not declared",
    );
  });

  it("fails closed when any reviewed safety-contract field drifts", () => {
    const create = normalizePlaygroundCatalog(openapi).operations.find(
      (operation) => keyOf(operation) === "POST /api/v1/tags",
    );
    expect(create).toBeDefined();
    expect(executionPolicyFor(create!).executable).toBe(true);

    const mutations: Array<
      [string, (operation: NormalizedPlaygroundOperation) => void]
    > = [
      ["method", (operation) => (operation.method = "put")],
      ["path", (operation) => (operation.path = "/api/v1/tags/v2")],
      [
        "operationId",
        (operation) => (operation.operationId = `${operation.operationId}V2`),
      ],
      ["deprecated", (operation) => (operation.deprecated = true)],
      [
        "parameters",
        (operation) => {
          operation.parameters[0] = {
            ...operation.parameters[0]!,
            required: !operation.parameters[0]!.required,
          };
        },
      ],
      [
        "requestBody",
        (operation) => {
          operation.requestBody = {
            ...operation.requestBody!,
            required: !operation.requestBody!.required,
          };
        },
      ],
      [
        "responses",
        (operation) => {
          operation.responses = {
            ...operation.responses,
            private: !operation.responses.private,
          };
        },
      ],
      [
        "security",
        (operation) => (operation.security = [{ schemes: ["sessionCookie"] }]),
      ],
      ["explicitlyPublic", (operation) => (operation.explicitlyPublic = true)],
      ["requiredRole", (operation) => (operation.requiredRole = "admin")],
      ["requiredScopes", (operation) => operation.requiredScopes.push("admin")],
      [
        "requiredScopeMode",
        (operation) => (operation.requiredScopeMode = "all"),
      ],
      ["releaseHold", (operation) => (operation.releaseHold = "fixture")],
      [
        "maxBodyBytes",
        (operation) =>
          (operation.maxBodyBytes = (operation.maxBodyBytes ?? 0) + 1),
      ],
      ["bodyless", (operation) => (operation.bodyless = !operation.bodyless)],
      [
        "contractIssues",
        (operation) => operation.contractIssues.push("fixture drift"),
      ],
    ];

    for (const [field, mutate] of mutations) {
      const changed = structuredClone(create!);
      mutate(changed);
      expect(executionPolicyFor(changed).executable, field).toBe(false);
    }

    for (const field of [
      "operationId",
      "parameters",
      "requestBody",
      "responses",
      "security",
      "requiredRole",
      "requiredScopes",
      "requiredScopeMode",
      "maxBodyBytes",
      "bodyless",
    ]) {
      const changed = structuredClone(create!);
      mutations.find(([name]) => name === field)![1](changed);
      expect(executionPolicyFor(changed).reason, field).toContain(
        "independent re-review",
      );
    }
  });

  it("generates a bounded JSON example when only a schema is available", () => {
    const operation = normalizePlaygroundCatalog({
      openapi: "3.1.0",
      paths: {
        "/api/v1/widgets": {
          post: {
            requestBody: {
              required: true,
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    required: ["name", "enabled"],
                    properties: {
                      name: { type: "string", example: "Launch" },
                      enabled: { type: "boolean" },
                    },
                  },
                },
              },
            },
            responses: { "201": { content: { "application/json": {} } } },
          },
        },
      },
    }).operations[0];

    expect(operation?.requestBody).toMatchObject({
      required: true,
      selectedMediaType: "application/json",
      exampleSource: "schema",
      example: { name: "Launch", enabled: false },
    });
  });

  it("bounds hostile per-operation catalog cardinality before it reaches the UI", () => {
    const parameters = Array.from({ length: 129 }, (_, index) => ({
      name: `parameter_${index}`,
      in: "query",
      schema:
        index === 0
          ? {
              type: "string",
              enum: [
                "x".repeat(1_025),
                ...Array.from({ length: 256 }, () => "v"),
              ],
            }
          : { type: "string" },
    }));
    const responses = Object.fromEntries(
      Array.from({ length: 65 }, (_, index) => [
        String(200 + index),
        {
          content: Object.fromEntries(
            Array.from(
              { length: index === 0 ? 33 : 1 },
              (_value, mediaIndex) => [
                mediaIndex === 0
                  ? "application/json"
                  : `application/x-fixture-${mediaIndex}`,
                {},
              ],
            ),
          ),
        },
      ]),
    );
    const operation = normalizePlaygroundCatalog({
      openapi: "3.1.0",
      security: [{ bearerAuth: [] }],
      paths: {
        "/api/v1/tags": {
          get: {
            parameters,
            tags: Array.from({ length: 17 }, (_, index) => `Tag ${index}`),
            description: "d".repeat(16_385),
            responses,
          },
        },
      },
    }).operations[0]!;

    expect(operation.parameters).toHaveLength(128);
    expect(operation.tags).toHaveLength(16);
    expect(operation.description).toHaveLength(16_384);
    expect(operation.responses.statuses).toHaveLength(64);
    expect(operation.responses.mediaTypesByStatus["200"]).toHaveLength(32);
    const issues = operation.contractIssues.join(" ");
    expect(issues).toContain("more than 128 parameters");
    expect(issues).toContain("too many enum values");
    expect(issues).toContain("oversized enum value");
    expect(issues).toContain("more than 16 values");
    expect(issues).toContain("more than 64 responses");
    expect(executionPolicyFor(operation).reason).toContain(
      "Catalog contract issue",
    );
  });

  it("fails closed on malformed serialization, response, security, and hold metadata", () => {
    const oversizedScheme = "s".repeat(129);
    const responses = JSON.parse(
      '{"__proto__":{"content":{"application/json":{}}},"200":{"content":{"application/json":"malformed"}}}',
    ) as Record<string, unknown>;
    const operation = normalizePlaygroundCatalog({
      openapi: "3.1.0",
      security: [{ [oversizedScheme]: [] }],
      paths: {
        "/api/v1/tags": {
          get: {
            parameters: [
              {
                name: "mode",
                in: "query",
                required: "yes",
                style: "s".repeat(129),
                explode: "yes",
                schema: { type: "string" },
              },
            ],
            "x-postwave-release-hold": 42,
            "x-postwave-bodyless": "false",
            "x-postwave-private-response": "true",
            responses,
          },
        },
      },
    }).operations[0]!;

    const issues = operation.contractIssues.join(" ");
    expect(issues).toContain("malformed required metadata");
    expect(issues).toContain("style exceeds the 128-character display limit");
    expect(issues).toContain("malformed explode metadata");
    expect(issues).toContain("oversized scheme name");
    expect(issues).toContain("invalid response status __proto__");
    expect(issues).toContain("media application/json must be an object");
    expect(issues).toContain("release hold must be a non-empty string");
    expect(issues).toContain("x-postwave-bodyless must be boolean");
    expect(issues).toContain("x-postwave-private-response must be boolean");
    expect(Object.getPrototypeOf(operation.responses.mediaTypesByStatus)).toBe(
      null,
    );
    expect(operation.responses.statuses).toEqual(["200"]);
    expect(executionPolicyFor(operation).reason).toContain(
      "Catalog contract issue",
    );
  });

  it("rejects a catalog whose distinct tags would create an unbounded filter", () => {
    const paths = Object.fromEntries(
      Array.from({ length: 33 }, (_, operationIndex) => [
        `/api/v1/fixtures/${operationIndex}`,
        {
          get: {
            tags: Array.from(
              { length: 16 },
              (_value, tagIndex) => `Tag ${operationIndex}-${tagIndex}`,
            ),
            responses: {
              "200": { content: { "application/json": {} } },
            },
          },
        },
      ]),
    );
    expect(() =>
      normalizePlaygroundCatalog({ openapi: "3.1.0", paths }),
    ).toThrow("512-tag workbench limit");
  });

  it("treats an empty security requirement as anonymous and reference-only", () => {
    const operation = normalizePlaygroundCatalog({
      openapi: "3.1.0",
      security: [{ bearerAuth: [] }],
      paths: {
        "/api/v1/tags": {
          get: {
            security: [{}],
            responses: { "200": { content: { "application/json": {} } } },
          },
        },
      },
    }).operations[0]!;

    expect(operation.explicitlyPublic).toBe(true);
    expect(executionPolicyFor(operation)).toMatchObject({
      executable: false,
      authMode: "unsupported",
    });
  });

  it("inherits an explicitly public root security contract", () => {
    const operation = normalizePlaygroundCatalog({
      openapi: "3.1.0",
      security: [],
      paths: {
        "/api/v1/tags": {
          get: {
            responses: { "200": { content: { "application/json": {} } } },
          },
        },
      },
    }).operations[0]!;

    expect(operation.explicitlyPublic).toBe(true);
    expect(executionPolicyFor(operation).executable).toBe(false);
  });

  it("rejects an incomplete catalog and repeated path placeholders", () => {
    expect(() =>
      normalizePlaygroundCatalog({
        openapi: "3.1.0",
        paths: {
          "/api/v1/broken": { $ref: "#/components/missing" },
          "/api/v1/tags": {
            get: {
              responses: {
                "200": { content: { "application/json": {} } },
              },
            },
          },
        },
      }),
    ).toThrow("OpenAPI document is incomplete");

    expect(() =>
      normalizePlaygroundCatalog({
        openapi: "3.1.0",
        paths: {
          "/api/v1/tags": {
            get: { $ref: "#/components/missing-operation" },
            post: {
              responses: {
                "200": { content: { "application/json": {} } },
              },
            },
          },
        },
      }),
    ).toThrow("OpenAPI document is incomplete");

    const repeated = normalizePlaygroundCatalog({
      openapi: "3.1.0",
      security: [{ bearerAuth: [] }],
      paths: {
        "/api/v1/tags/{id}/related/{id}": {
          get: {
            parameters: [
              {
                name: "id",
                in: "path",
                required: true,
                schema: { type: "string" },
              },
            ],
            responses: { "200": { content: { "application/json": {} } } },
          },
        },
      },
    }).operations[0]!;
    expect(repeated.contractIssues).toContain(
      "path placeholder id appears more than once",
    );
    expect(executionPolicyFor(repeated).executable).toBe(false);
  });

  it("memoizes shared request-schema refs and enforces one catalog-wide node budget", () => {
    const shared = {
      openapi: "3.1.0",
      components: {
        schemas: { SharedScalar: { type: "string", maxLength: 64 } },
      },
      paths: {
        "/api/v1/one": {
          get: {
            parameters: [
              {
                name: "query",
                in: "query",
                schema: { $ref: "#/components/schemas/SharedScalar" },
              },
            ],
            responses: { "200": { content: { "application/json": {} } } },
          },
        },
        "/api/v1/two": {
          get: {
            parameters: [
              {
                name: "query",
                in: "query",
                schema: { $ref: "#/components/schemas/SharedScalar" },
              },
            ],
            responses: { "200": { content: { "application/json": {} } } },
          },
        },
      },
    };
    const memoized = normalizePlaygroundCatalog(shared).operations;
    expect(memoized[0]?.parameters[0]?.schema).toBe(
      memoized[1]?.parameters[0]?.schema,
    );

    const repeatedParameter = {
      name: "shared",
      in: "query",
      schema: { $ref: "#/components/schemas/SharedScalar" },
    };
    const parameters = Array.from({ length: 128 }, (_, index) => ({
      ...repeatedParameter,
      name: `shared_${index}`,
    }));
    const paths = Object.fromEntries(
      Array.from({ length: 1_025 }, (_, index) => [
        `/api/v1/repeated-${index}`,
        {
          get: {
            parameters,
            responses: { "200": { content: { "application/json": {} } } },
          },
        },
      ]),
    );
    expect(() => normalizePlaygroundCatalog({ ...shared, paths })).toThrow(
      "aggregate request-schema limit",
    );
  });
});
