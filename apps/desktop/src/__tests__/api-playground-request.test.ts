import { describe, expect, it } from "vitest";

import openapi from "../../../../packages/openapi/openapi.json";
import { normalizePlaygroundCatalog } from "../pages/api-playground-openapi";
import { executionPolicyFor } from "../pages/api-playground-policy";
import {
  buildPlaygroundRequest,
  unsafePlaygroundPathValue,
} from "../pages/api-playground-request";

function operationFrom(
  method: "get" | "post" | "patch" | "delete",
  path: string,
  operation: Record<string, unknown> = {},
) {
  return normalizePlaygroundCatalog({
    openapi: "3.1.0",
    security: [{ bearerAuth: [] }],
    paths: {
      [path]: {
        parameters: [...path.matchAll(/\{([^{}]+)\}/g)].map((match) => ({
          name: match[1],
          in: "path",
          required: true,
          schema: { type: "string" },
        })),
        [method]: {
          operationId: `${method}Fixture`,
          responses: { "200": { content: { "application/json": {} } } },
          ...operation,
        },
      },
    },
  }).operations[0]!;
}

function operationWithSchema(
  schema: unknown,
  components: Record<string, unknown> = {},
) {
  return normalizePlaygroundCatalog({
    openapi: "3.1.0",
    security: [{ bearerAuth: [] }],
    components: { schemas: components },
    paths: {
      "/api/v1/tags": {
        post: {
          operationId: "postSchemaFixture",
          requestBody: {
            required: true,
            content: { "application/json": { schema } },
          },
          responses: { "200": { content: { "application/json": {} } } },
        },
      },
    },
  }).operations[0]!;
}

function emptyValues() {
  return {
    path: {},
    query: {},
    headers: {},
    customHeaders: [],
    body: "",
    idempotencyKey: "",
  };
}

function executablePlannerPolicy(operation: ReturnType<typeof operationFrom>) {
  const policy = executionPolicyFor(operation);
  return { ...policy, executable: true, reason: undefined };
}

describe("API Playground request planning", () => {
  it.each([
    ".",
    "..",
    "%2e",
    "%2e%2e",
    "%252e%252e",
    "%252525252e%252525252e",
    "a/b",
    "a%2fb",
    "a%252525252fb",
    "a\\b",
  ])("rejects unsafe path value %s", (value) => {
    expect(unsafePlaygroundPathValue(value)).not.toBeNull();
  });

  it("constructs an exact same-authority URL with inherited path and required query values", () => {
    const operation = operationFrom("get", "/api/v1/campaigns/{id}", {
      parameters: [
        {
          name: "limit",
          in: "query",
          required: true,
          schema: { type: "integer" },
        },
      ],
    });
    const result = buildPlaygroundRequest(
      "https://api.postwave.test/tenant-edge/",
      operation,
      executablePlannerPolicy(operation),
      {
        ...emptyValues(),
        path: { id: "cmp 123" },
        query: { limit: "25" },
      },
    );

    expect(result.issues).toEqual([]);
    expect(result.plan.url).toBe(
      "https://api.postwave.test/tenant-edge/api/v1/campaigns/cmp%20123?limit=25",
    );
    expect(result.plan.authMode).toBe("workspace");
    expect(result.plan.snippetAllowed).toBe(true);
  });

  it("fails closed on required query, header, and JSON body fields", () => {
    const operation = operationFrom("patch", "/api/v1/tags/{id}", {
      parameters: [
        { name: "If-Match", in: "header", required: true },
        { name: "mode", in: "query", required: true },
      ],
      requestBody: {
        required: true,
        content: { "application/json": { schema: { type: "object" } } },
      },
    });
    const result = buildPlaygroundRequest(
      "https://api.postwave.test",
      operation,
      executablePlannerPolicy(operation),
      { ...emptyValues(), path: { id: "tag_1" }, body: "{" },
    );

    expect(result.issues.map((issue) => issue.field)).toEqual(
      expect.arrayContaining(["query", "header", "body"]),
    );
    expect(
      result.issues.some(
        (issue) => issue.field === "body" && issue.message.length > 0,
      ),
    ).toBe(true);
    expect(result.plan).toMatchObject({
      snippetAllowed: false,
      snippetUnavailableReason:
        "Request validation must pass before code generation.",
    });
  });

  it("accepts only declared or portable headers and rejects controls and duplicates", () => {
    const operation = operationFrom("get", "/api/v1/tags");
    const result = buildPlaygroundRequest(
      "https://api.postwave.test",
      operation,
      executablePlannerPolicy(operation),
      {
        ...emptyValues(),
        customHeaders: [
          { key: "Accept", value: "application/json" },
          { key: "accept", value: "text/plain" },
          { key: "X-Unreviewed", value: "1" },
          { key: "Bad\nHeader", value: "2" },
          { key: "Authorization", value: "Bearer secret" },
        ],
      },
    );

    const messages = result.issues.map((issue) => issue.message).join(" ");
    expect(messages).toContain("duplicated");
    expect(messages).toContain("not portable");
    expect(messages).toContain("invalid field name");
    expect(messages).toContain("managed by the protected transport");
    expect(result.plan.headers).toEqual({ Accept: "application/json" });
  });

  it("never turns a malformed catalog path into a credentialed foreign origin", () => {
    const operation = operationFrom("get", "@evil.example/x");
    const result = buildPlaygroundRequest(
      "https://api.postwave.test",
      operation,
      executionPolicyFor(operation),
      emptyValues(),
    );

    expect(result.issues.some((issue) => issue.field === "catalog")).toBe(true);
    expect(result.plan.url).toBe("");
  });

  it("validates bounded scalar path, query, and declared-header values", () => {
    const operation = operationFrom("get", "/api/v1/tags/{id}/history", {
      parameters: [
        {
          name: "id",
          in: "path",
          required: true,
          schema: { type: "string", format: "uuid" },
        },
        {
          name: "page",
          in: "query",
          schema: { type: "integer", minimum: 1, maximum: 100 },
        },
        {
          name: "ratio",
          in: "query",
          schema: {
            type: "number",
            exclusiveMinimum: 0,
            exclusiveMaximum: 1,
          },
        },
        {
          name: "archived",
          in: "query",
          schema: { type: "boolean" },
        },
        {
          name: "mode",
          in: "query",
          schema: { type: "string", enum: ["active", "all"] },
        },
        {
          name: "contract",
          in: "query",
          schema: { type: "string", const: "v1" },
        },
        {
          name: "label",
          in: "query",
          schema: { type: "string", minLength: 2, maxLength: 4 },
        },
        {
          name: "X-Mode",
          in: "header",
          schema: { type: "string", enum: ["safe", "audit"] },
        },
      ],
    });
    const valid = buildPlaygroundRequest(
      "https://api.postwave.test",
      operation,
      executablePlannerPolicy(operation),
      {
        ...emptyValues(),
        path: { id: "550e8400-e29b-41d4-a716-446655440000" },
        query: {
          page: "25",
          ratio: "0.5",
          archived: "false",
          mode: "active",
          contract: "v1",
          label: "wave",
        },
        headers: { "X-Mode": "safe" },
      },
    );
    expect(valid.issues).toEqual([]);

    const invalid = buildPlaygroundRequest(
      "https://api.postwave.test",
      operation,
      executablePlannerPolicy(operation),
      {
        ...emptyValues(),
        path: { id: "not-a-uuid" },
        query: {
          page: "01",
          ratio: "1",
          archived: "TRUE",
          mode: "paused",
          contract: "v2",
          label: "x",
        },
        headers: { "X-Mode": "unsafe" },
      },
    );
    const messages = invalid.issues.map((issue) => issue.message).join("\n");
    expect(messages).toContain("id must be a canonical UUID");
    expect(messages).toContain("page must be an integer");
    expect(messages).toContain("ratio must be less than 1");
    expect(messages).toContain("archived must be true or false");
    expect(messages).toContain("mode must match one of the documented values");
    expect(messages).toContain("contract must equal the documented constant");
    expect(messages).toContain("label must contain at least 2 characters");
    expect(messages).toContain(
      "X-Mode must match one of the documented values",
    );
  });

  it("validates bounded JSON objects, primitives, arrays, and alternatives", () => {
    const operation = operationFrom("post", "/api/v1/tags", {
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              additionalProperties: false,
              minProperties: 2,
              required: ["name", "meta"],
              properties: {
                name: { type: "string", minLength: 1, maxLength: 8 },
                group_id: {
                  oneOf: [
                    { type: "string", format: "uuid" },
                    { type: "string", const: "" },
                  ],
                },
                pii: { type: "boolean" },
                priority: { type: "integer", minimum: 0, maximum: 10 },
                ratio: {
                  type: "number",
                  exclusiveMinimum: 0,
                  exclusiveMaximum: 1,
                },
                labels: {
                  type: "array",
                  minItems: 1,
                  maxItems: 3,
                  items: { type: "string", minLength: 2, maxLength: 5 },
                },
                meta: {
                  type: "object",
                  additionalProperties: false,
                  required: ["active"],
                  properties: { active: { type: "boolean" } },
                },
              },
            },
          },
        },
      },
    });
    const valid = buildPlaygroundRequest(
      "https://api.postwave.test",
      operation,
      executablePlannerPolicy(operation),
      {
        ...emptyValues(),
        body: JSON.stringify({
          name: "Launch",
          group_id: "",
          pii: false,
          priority: 4,
          ratio: 0.5,
          labels: ["new", "vip"],
          meta: { active: true },
        }),
      },
    );
    expect(valid.issues).toEqual([]);

    const invalid = buildPlaygroundRequest(
      "https://api.postwave.test",
      operation,
      executablePlannerPolicy(operation),
      {
        ...emptyValues(),
        body: JSON.stringify({
          name: "",
          group_id: "not-a-uuid",
          pii: "false",
          priority: 11,
          ratio: 0,
          labels: ["x", 2, "okay", "extra"],
          meta: {},
          unknown: true,
        }),
      },
    );
    const messages = invalid.issues.map((issue) => issue.message).join("\n");
    expect(messages).toContain('$["name"] must contain at least 1 character');
    expect(messages).toContain(
      '$["group_id"] must match exactly one documented alternative',
    );
    expect(messages).toContain('$["pii"] must be boolean');
    expect(messages).toContain('$["priority"] must be at most 10');
    expect(messages).toContain('$["ratio"] must be greater than 0');
    expect(messages).toContain('$["labels"] must contain at most 3 items');
    expect(messages).toContain(
      '$["labels"][0] must contain at least 2 characters',
    );
    expect(messages).toContain('$["labels"][1] must be string');
    expect(messages).toContain('$["meta"]["active"] is required');
    expect(messages).toContain('$["unknown"] is not allowed');
  });

  it("blocks schemas that exceed validation budgets without executing catalog regexes", () => {
    let nestedSchema: Record<string, unknown> = { type: "string" };
    let nestedValue: unknown = "leaf";
    for (let index = 0; index < 14; index += 1) {
      nestedSchema = {
        type: "object",
        required: ["child"],
        properties: { child: nestedSchema },
      };
      nestedValue = { child: nestedValue };
    }
    const deepOperation = operationFrom("post", "/api/v1/tags", {
      requestBody: {
        required: true,
        content: {
          "application/json": { schema: nestedSchema },
        },
      },
    });
    const deep = buildPlaygroundRequest(
      "https://api.postwave.test",
      deepOperation,
      executionPolicyFor(deepOperation),
      { ...emptyValues(), body: JSON.stringify(nestedValue) },
    );
    expect(deep.issues.map((issue) => issue.message).join(" ")).toContain(
      "safe workbench depth or node budget",
    );

    const arrayOperation = operationFrom("post", "/api/v1/tags", {
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: { type: "array", items: { type: "integer" } },
          },
        },
      },
    });
    const oversizedArray = buildPlaygroundRequest(
      "https://api.postwave.test",
      arrayOperation,
      executionPolicyFor(arrayOperation),
      {
        ...emptyValues(),
        body: JSON.stringify(Array.from({ length: 513 }, () => 1)),
      },
    );
    expect(
      oversizedArray.issues.map((issue) => issue.message).join(" "),
    ).toContain("safe array-item budget");

    const patternOperation = operationFrom("post", "/api/v1/tags", {
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                value: { type: "string", pattern: "^(a+)+$" },
              },
            },
          },
        },
      },
    });
    const pattern = buildPlaygroundRequest(
      "https://api.postwave.test",
      patternOperation,
      executionPolicyFor(patternOperation),
      {
        ...emptyValues(),
        body: JSON.stringify({ value: `${"a".repeat(20_000)}!` }),
      },
    );
    expect(pattern.issues.map((issue) => issue.message).join(" ")).toContain(
      "pattern constraint that the workbench will not execute",
    );
  });

  it("deep-resolves bounded local refs and fails closed on unresolved or cyclic refs", () => {
    const nested = operationWithSchema(
      { $ref: "#/components/schemas/Envelope" },
      {
        Envelope: {
          type: "object",
          required: ["value"],
          properties: {
            value: { $ref: "#/components/schemas/BoundedValue" },
          },
        },
        BoundedValue: { type: "string", enum: ["safe"] },
      },
    );
    const nestedInvalid = buildPlaygroundRequest(
      "https://api.postwave.test",
      nested,
      executionPolicyFor(nested),
      { ...emptyValues(), body: JSON.stringify({ value: "unsafe" }) },
    );
    expect(
      nestedInvalid.issues.map((issue) => issue.message).join(" "),
    ).toContain("must match one of the documented values");

    const unresolved = operationWithSchema({
      type: "object",
      properties: {
        value: { $ref: "#/components/schemas/Missing" },
      },
    });
    expect(unresolved.contractIssues.join(" ")).toContain(
      "unresolved reference",
    );
    expect(executionPolicyFor(unresolved).executable).toBe(false);
    const unresolvedResult = buildPlaygroundRequest(
      "https://api.postwave.test",
      unresolved,
      executionPolicyFor(unresolved),
      { ...emptyValues(), body: JSON.stringify({ value: "unsafe" }) },
    );
    expect(
      unresolvedResult.issues.map((issue) => issue.message).join(" "),
    ).toContain("unresolved or cyclic schema reference");

    const cyclic = operationWithSchema(
      { $ref: "#/components/schemas/Recursive" },
      {
        Recursive: {
          type: "object",
          properties: {
            next: { $ref: "#/components/schemas/Recursive" },
          },
        },
      },
    );
    expect(cyclic.contractIssues.join(" ")).toContain("cyclic reference");
    expect(executionPolicyFor(cyclic).executable).toBe(false);
  });

  it.each([
    ["multipleOf", { type: "number", multipleOf: 2 }, 3],
    [
      "uniqueItems",
      { type: "array", uniqueItems: true, items: { type: "string" } },
      ["duplicate", "duplicate"],
    ],
    ["not", { not: { const: "blocked" } }, "blocked"],
    ["contains", { type: "array", contains: { const: "required" } }, ["other"]],
  ])("fails closed instead of ignoring %s", (keyword, schema, body) => {
    const operation = operationWithSchema(schema);
    const result = buildPlaygroundRequest(
      "https://api.postwave.test",
      operation,
      executionPolicyFor(operation),
      { ...emptyValues(), body: JSON.stringify(body) },
    );
    expect(result.issues.map((issue) => issue.message).join(" ")).toContain(
      `unsupported JSON Schema constraint “${keyword}”`,
    );
  });

  it("preserves boolean schemas, blocks request readOnly values, and rejects unsafe integers", () => {
    const deniedBody = operationWithSchema(false);
    const deniedResult = buildPlaygroundRequest(
      "https://api.postwave.test",
      deniedBody,
      executionPolicyFor(deniedBody),
      { ...emptyValues(), body: "{}" },
    );
    expect(
      deniedResult.issues.map((issue) => issue.message).join(" "),
    ).toContain("$ is not allowed");

    const readOnly = operationWithSchema({
      type: "object",
      properties: {
        server_id: { type: "string", readOnly: true },
      },
    });
    const readOnlyResult = buildPlaygroundRequest(
      "https://api.postwave.test",
      readOnly,
      executionPolicyFor(readOnly),
      { ...emptyValues(), body: JSON.stringify({ server_id: "forged" }) },
    );
    expect(
      readOnlyResult.issues.map((issue) => issue.message).join(" "),
    ).toContain('$["server_id"] is read-only and cannot be sent');

    const unsafeParameter = operationFrom("get", "/api/v1/tags", {
      parameters: [
        {
          name: "cursor",
          in: "query",
          schema: {
            type: "integer",
            maximum: Number.MAX_SAFE_INTEGER,
          },
        },
      ],
    });
    const parameterResult = buildPlaygroundRequest(
      "https://api.postwave.test",
      unsafeParameter,
      executionPolicyFor(unsafeParameter),
      {
        ...emptyValues(),
        query: { cursor: "9007199254740993" },
      },
    );
    expect(
      parameterResult.issues.map((issue) => issue.message).join(" "),
    ).toContain("safely representable integer");

    const unsafeBody = operationWithSchema({ type: "integer" });
    const bodyResult = buildPlaygroundRequest(
      "https://api.postwave.test",
      unsafeBody,
      executionPolicyFor(unsafeBody),
      { ...emptyValues(), body: "9007199254740993" },
    );
    expect(bodyResult.issues.map((issue) => issue.message).join(" ")).toContain(
      "safe numeric precision boundary",
    );
  });

  it("rejects duplicate JSON keys and formats the workbench cannot enforce", () => {
    const objectOperation = operationWithSchema({
      type: "object",
      additionalProperties: true,
    });
    const duplicate = buildPlaygroundRequest(
      "https://api.postwave.test",
      objectOperation,
      executionPolicyFor(objectOperation),
      { ...emptyValues(), body: '{"name":"first","name":"second"}' },
    );
    expect(duplicate.issues.map((issue) => issue.message).join(" ")).toContain(
      "duplicate JSON object key",
    );

    for (const format of ["email", "date-time", "int64"]) {
      const formatted = operationWithSchema({ type: "string", format });
      const result = buildPlaygroundRequest(
        "https://api.postwave.test",
        formatted,
        executionPolicyFor(formatted),
        { ...emptyValues(), body: JSON.stringify("value") },
      );
      expect(result.issues.map((issue) => issue.message).join(" ")).toContain(
        `unsupported JSON Schema format “${format}”`,
      );
    }
  });

  it("matches native header count, byte, and forbidden-name boundaries", () => {
    const headerParameters = Array.from({ length: 66 }, (_, index) => ({
      name: index === 0 ? "X-Forwarded-For" : `X-Fixture-${index}`,
      in: "header",
      schema: { type: "string" },
    }));
    const operation = operationFrom("get", "/api/v1/tags", {
      parameters: headerParameters,
    });
    const headers = Object.fromEntries(
      headerParameters.map((parameter, index) => [
        parameter.name,
        index < 5 ? "x".repeat(8 * 1024) : "x",
      ]),
    );
    const result = buildPlaygroundRequest(
      "https://api.postwave.test",
      operation,
      executionPolicyFor(operation),
      { ...emptyValues(), headers },
    );
    const messages = result.issues.map((issue) => issue.message).join(" ");
    expect(messages).toContain(
      "X-Forwarded-For is rejected by the protected native transport",
    );
    expect(messages).toContain("64-header native transport limit");
    expect(messages).toContain("32768-byte native transport limit");
  });

  it.each([
    "9007199254740993",
    "9007199254740993.0",
    "9.007199254740993e15",
    "90071992547409930e-1",
    "1e400",
  ])("rejects unsafe raw JSON numeric precision for %s", (body) => {
    const numeric = operationWithSchema({
      type: ["number", "string"],
    });
    const result = buildPlaygroundRequest(
      "https://api.postwave.test",
      numeric,
      executionPolicyFor(numeric),
      { ...emptyValues(), body },
    );
    expect(result.issues.map((issue) => issue.message).join(" ")).toContain(
      "safe numeric precision boundary",
    );
  });

  it("accepts the exact maximum safe JSON integer lexeme", () => {
    const numeric = operationWithSchema({ type: "number" });
    const result = buildPlaygroundRequest(
      "https://api.postwave.test",
      numeric,
      executionPolicyFor(numeric),
      { ...emptyValues(), body: "9007199254740991" },
    );
    expect(result.issues.filter((issue) => issue.field === "body")).toEqual([]);
  });

  it("enforces the live reviewed tag create and update request contracts", () => {
    const operations = normalizePlaygroundCatalog(openapi).operations;
    const create = operations.find(
      (operation) =>
        operation.method === "post" && operation.path === "/api/v1/tags",
    )!;
    const update = operations.find(
      (operation) =>
        operation.method === "patch" && operation.path === "/api/v1/tags/{id}",
    )!;
    const createResult = (body: unknown) =>
      buildPlaygroundRequest(
        "https://api.postwave.test",
        create,
        executionPolicyFor(create),
        { ...emptyValues(), body: JSON.stringify(body) },
      ).issues.filter((issue) => issue.field === "body");
    const updateResult = (body: unknown) =>
      buildPlaygroundRequest(
        "https://api.postwave.test",
        update,
        executionPolicyFor(update),
        {
          ...emptyValues(),
          path: { id: "tag_1" },
          headers: { "If-Match": '"tag-1-v1"' },
          body: JSON.stringify(body),
        },
      ).issues.filter((issue) => issue.field === "body");

    expect(createResult({ name: "Launch", group_id: "", pii: false })).toEqual(
      [],
    );
    expect(createResult({ name: "Launch", color: "teal" })).toEqual([]);
    expect(
      createResult({})
        .map((issue) => issue.message)
        .join(" "),
    ).toContain('$["name"] is required');
    const invalidCreate = createResult({
      name: "",
      group_id: "not-a-uuid",
      pii: "yes",
      surprise: true,
    })
      .map((issue) => issue.message)
      .join(" ");
    expect(invalidCreate).toContain("at least 1 character");
    expect(invalidCreate).toContain("exactly one documented alternative");
    expect(invalidCreate).toContain("must be boolean");
    expect(invalidCreate).toContain("is not allowed");
    expect(
      createResult({ name: "Launch", color: "not-a-color" })
        .map((issue) => issue.message)
        .join(" "),
    ).toContain("exactly one documented alternative");
    expect(
      createResult({ name: "Launch", color: { arbitrary: true } })
        .map((issue) => issue.message)
        .join(" "),
    ).toContain("exactly one documented alternative");
    expect(
      updateResult({})
        .map((issue) => issue.message)
        .join(" "),
    ).toContain("at least 1 property");
    expect(
      updateResult({ name: "x".repeat(65) })
        .map((issue) => issue.message)
        .join(" "),
    ).toContain("at most 64 characters");
  });
});
