// SPDX-License-Identifier: MIT
//
// Tests for the per-call AsyncLocalStorage context that carries the
// MCP tool name to the SDK's fetch wrapper.

import { describe, expect, it } from "vitest";

import {
  buildUserAgent,
  getToolContext,
  withToolContext,
} from "../../src/lib/tool-context.js";

describe("buildUserAgent", () => {
  it("renders the standard MCP UA", () => {
    expect(buildUserAgent("0.1.0")).toBe("postwave-mcp-server/0.1.0");
  });

  it("appends a sanitised `via` suffix when supplied", () => {
    expect(buildUserAgent("1.0.0", "claude-code/0.5.0")).toBe(
      "postwave-mcp-server/1.0.0 (via claude-code/0.5.0)",
    );
  });

  it("strips parentheses from the via to prevent UA-header confusion", () => {
    // The base UA already wraps the suffix in (), so a nested ()
    // would create an unparseable header for downstream proxies.
    expect(buildUserAgent("1.0.0", "weird(client)")).toBe(
      "postwave-mcp-server/1.0.0 (via weirdclient)",
    );
  });
});

describe("withToolContext / getToolContext", () => {
  it("undefined outside any run", () => {
    expect(getToolContext()).toBeUndefined();
  });

  it("returns the context inside the run", async () => {
    await withToolContext(
      { toolName: "subscribers_list", serverVersion: "0.1.0" },
      async () => {
        expect(getToolContext()?.toolName).toBe("subscribers_list");
      },
    );
  });

  it("survives await boundaries (the whole point of AsyncLocalStorage)", async () => {
    await withToolContext(
      { toolName: "campaign_send", serverVersion: "0.1.0" },
      async () => {
        await new Promise((r) => setTimeout(r, 5));
        // After an awaited timeout, the context should still resolve.
        expect(getToolContext()?.toolName).toBe("campaign_send");
        // And again after nested async work.
        await Promise.resolve().then(() => {
          expect(getToolContext()?.toolName).toBe("campaign_send");
        });
      },
    );
  });

  it("nested run shadows the outer context", async () => {
    await withToolContext(
      { toolName: "outer", serverVersion: "0.1.0" },
      async () => {
        expect(getToolContext()?.toolName).toBe("outer");
        await withToolContext(
          { toolName: "inner", serverVersion: "0.1.0" },
          async () => {
            expect(getToolContext()?.toolName).toBe("inner");
          },
        );
        // Back to the outer after the nested run resolves.
        expect(getToolContext()?.toolName).toBe("outer");
      },
    );
  });

  it("two concurrent runs don't bleed into each other", async () => {
    const a = withToolContext(
      { toolName: "a", serverVersion: "0.1.0" },
      async () => {
        await new Promise((r) => setTimeout(r, 8));
        return getToolContext()?.toolName;
      },
    );
    const b = withToolContext(
      { toolName: "b", serverVersion: "0.1.0" },
      async () => {
        await new Promise((r) => setTimeout(r, 4));
        return getToolContext()?.toolName;
      },
    );
    const [resA, resB] = await Promise.all([a, b]);
    expect(resA).toBe("a");
    expect(resB).toBe("b");
  });

  it("clears the context after the run completes", async () => {
    await withToolContext(
      { toolName: "ephemeral", serverVersion: "0.1.0" },
      async () => {
        /* no-op */
      },
    );
    expect(getToolContext()).toBeUndefined();
  });
});
