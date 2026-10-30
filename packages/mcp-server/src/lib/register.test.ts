// SPDX-License-Identifier: MIT
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import {
  deriveAnnotations,
  registerToolList,
  SetHeldScopes,
  type AnyToolDef,
} from "./register.js";
import { migrationTools } from "../tools/migration.js";

const sampleTools: AnyToolDef[] = [
  {
    name: "list_widgets",
    description: "List all widgets in the account.",
    schema: z.object({}),
    annotations: { readOnlyHint: true },
    requiredScopes: ["read:reports"],
    handler: async () => [],
  },
  {
    name: "delete_widget",
    description: "Delete a widget by id.",
    schema: z.object({ id: z.string() }),
    annotations: { destructiveHint: true },
    requiredScopes: ["admin"],
    handler: async () => ({ ok: true }),
  },
  {
    name: "frobnicate",
    description: "Frobnicate the thing.",
    schema: z.object({}),
    requiredScopes: ["read:reports"],
    handler: async () => ({ ok: true }),
  },
];

async function connectedClient(tools: AnyToolDef[]): Promise<Client> {
  const server = new Server(
    { name: "test", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  registerToolList(server, tools);
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client(
    { name: "c", version: "1.0.0" },
    { capabilities: {} },
  );
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return client;
}

describe("deriveAnnotations", () => {
  it("never infers behavioral safety from a tool name", () => {
    expect(deriveAnnotations("list_widgets")).toEqual({});
    expect(deriveAnnotations("list_create")).toEqual({});
    expect(deriveAnnotations("getStats")).toEqual({});
    expect(deriveAnnotations("delete_widget")).toEqual({});
    expect(deriveAnnotations("frobnicate")).toEqual({});
    expect(deriveAnnotations("campaign_send")).toEqual({});
  });
});

describe("registerToolList discovery surface", () => {
  // Scope state is process-global; reset after each test so it can't leak.
  beforeEach(() => SetHeldScopes(new Set(["admin"])));
  afterEach(() => SetHeldScopes(null));

  it("exposes search_tools first and emits only explicit tool annotations", async () => {
    const client = await connectedClient(sampleTools);
    const list = await client.listTools();
    const names = list.tools.map((t) => t.name);

    expect(names[0]).toBe("search_tools");
    expect(names).toContain("list_widgets");

    const del = list.tools.find((t) => t.name === "delete_widget");
    expect(del?.annotations?.destructiveHint).toBe(true);
    const ls = list.tools.find((t) => t.name === "list_widgets");
    expect(ls?.annotations?.readOnlyHint).toBe(true);

    await client.close();
  });

  it("publishes refined migration account IDs as strings and retains the Customer.io length guard", async () => {
    const tools = migrationTools({} as never);
    const credentials = tools.find(
      (tool) => tool.name === "migrate_credentials",
    )!;

    expect(
      credentials.schema.safeParse({
        source: "customerio",
        api_key: "cio_app_key",
        account_id: "9".repeat(64),
        region: "us",
      }).success,
    ).toBe(true);
    expect(
      credentials.schema.safeParse({
        source: "customerio",
        api_key: "cio_app_key",
        account_id: "9".repeat(65),
        region: "us",
      }).success,
    ).toBe(false);

    const client = await connectedClient(tools);
    const descriptors = (await client.listTools()).tools;
    for (const toolName of [
      "migrate_credentials",
      "migrate_source_session_refresh",
    ]) {
      const descriptor = descriptors.find((tool) => tool.name === toolName);
      const inputSchema = descriptor?.inputSchema as {
        properties?: Record<string, { type?: string; description?: string }>;
      };
      expect(inputSchema.properties?.account_id).toMatchObject({
        type: "string",
      });
    }
    await client.close();
  });

  it("publishes a refined top-level object as its exact closed input shape", async () => {
    const schema = z
      .object({ start: z.string(), end: z.string() })
      .strict()
      .superRefine((value, context) => {
        if (value.start === value.end) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: "start and end must differ",
          });
        }
      });
    const client = await connectedClient([
      {
        name: "refined_window",
        description: "test refined input",
        schema,
        requiredScopes: ["admin"],
        handler: async (input) => input,
      },
    ]);

    const descriptor = (await client.listTools()).tools.find(
      (tool) => tool.name === "refined_window",
    );
    expect(descriptor?.inputSchema).toMatchObject({
      type: "object",
      required: ["start", "end"],
      additionalProperties: false,
      properties: {
        start: { type: "string" },
        end: { type: "string" },
      },
    });
    const invalid = await client.callTool({
      name: "refined_window",
      arguments: { start: "same", end: "same" },
    });
    expect((invalid as { isError?: boolean }).isError).toBe(true);
    await client.close();
  });

  it("hides + refuses tools the key isn't scoped for, and fails closed when scopes are unknown", async () => {
    const tools: AnyToolDef[] = [
      {
        name: "list_widgets",
        description: "list",
        schema: z.object({}),
        requiredScopes: ["read:reports"],
        handler: async () => [],
      },
      // api_key_revoke is gated on "admin" via HIGH_RISK_SCOPES.
      {
        name: "api_key_revoke",
        description: "revoke a key",
        schema: z.object({ id: z.string() }),
        handler: async () => ({ revoked: true }),
      },
    ];

    // Non-admin key: admin tool hidden + refused.
    SetHeldScopes(new Set(["read:reports"]));
    let client = await connectedClient(tools);
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain("list_widgets");
    expect(names).not.toContain("api_key_revoke");
    const denied = await client.callTool({
      name: "api_key_revoke",
      arguments: { id: "k1" },
    });
    expect((denied as { isError?: boolean }).isError).toBe(true);
    await client.close();

    // admin grants everything.
    SetHeldScopes(new Set(["admin"]));
    client = await connectedClient(tools);
    expect((await client.listTools()).tools.map((t) => t.name)).toContain(
      "api_key_revoke",
    );
    await client.close();

    // unknown scopes → discovery and calls fail closed.
    SetHeldScopes(null);
    client = await connectedClient(tools);
    expect((await client.listTools()).tools).toEqual([]);
    const unavailable = await client.callTool({
      name: "list_widgets",
      arguments: {},
    });
    expect((unavailable as { isError?: boolean }).isError).toBe(true);
    await client.close();
  });

  it("hides and refuses an unclassified tool even for a verified admin key", async () => {
    SetHeldScopes(new Set(["admin"]));
    const client = await connectedClient([
      {
        name: "unclassified_mutation",
        description: "must not cross an absent policy boundary",
        schema: z.object({}),
        handler: async () => ({ changed: true }),
      },
    ]);
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual([
      "search_tools",
    ]);
    const response = await client.callTool({
      name: "unclassified_mutation",
      arguments: {},
    });
    expect((response as { isError?: boolean }).isError).toBe(true);
    await client.close();
  });

  it("search_tools ranks matches by keyword over name + description", async () => {
    const client = await connectedClient(sampleTools);
    const res = await client.callTool({
      name: "search_tools",
      arguments: { query: "widget" },
    });
    const sc = (
      res as {
        structuredContent?: { count: number; tools: { name: string }[] };
      }
    ).structuredContent;
    expect(sc).toBeDefined();
    expect(sc!.count).toBeGreaterThanOrEqual(2);
    const found = sc!.tools.map((t) => t.name);
    expect(found).toContain("list_widgets");
    expect(found).toContain("delete_widget");
    expect(found).not.toContain("frobnicate");
    await client.close();
  });

  it("search_tools cannot rediscover a tool hidden by scope filtering", async () => {
    const tools: AnyToolDef[] = [
      {
        name: "reports_list",
        description: "widget report",
        schema: z.object({}),
        requiredScopes: ["read:reports"],
        handler: async () => [],
      },
      {
        name: "api_key_revoke",
        description: "widget admin secret",
        schema: z.object({}),
        requiredScopes: ["admin"],
        handler: async () => ({ ok: true }),
      },
    ];
    SetHeldScopes(new Set(["read:reports"]));
    const client = await connectedClient(tools);
    const listed = (await client.listTools()).tools.map((tool) => tool.name);
    expect(listed).toContain("reports_list");
    expect(listed).not.toContain("api_key_revoke");
    const response = await client.callTool({
      name: "search_tools",
      arguments: { query: "widget" },
    });
    const found =
      (
        response as { structuredContent?: { tools?: { name: string }[] } }
      ).structuredContent?.tools?.map((tool) => tool.name) ?? [];
    expect(found).toContain("reports_list");
    expect(found).not.toContain("api_key_revoke");
    await client.close();
  });
});
