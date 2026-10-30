// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";
import type { PostwaveClient } from "@postwave/sdk";

import {
  createServer,
  PROMPT_SURFACE_RELEASED,
  RESOURCE_SURFACE_RELEASED,
} from "./server.js";
import { candidateToolNames } from "./index.js";

describe("candidate server surface containment", () => {
  it("keeps the template candidate catalogue bounded and duplicate-free", () => {
    const names = candidateToolNames("templates");
    expect(names.length).toBeGreaterThan(0);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toEqual([...names].sort());
    expect(names.every((name) => name.startsWith("campaign_template_"))).toBe(true);
    expect(candidateToolNames("full").length).toBeGreaterThan(names.length);
  });
  it("does not advertise resources or prompts while their authority/output contracts are unclassified", () => {
    expect(RESOURCE_SURFACE_RELEASED).toBe(false);
    expect(PROMPT_SURFACE_RELEASED).toBe(false);
    const server = createServer({} as PostwaveClient);
    const capabilities = (
      server as unknown as {
        _capabilities: Record<string, unknown>;
      }
    )._capabilities;
    expect(capabilities).toHaveProperty("tools");
    expect(capabilities).not.toHaveProperty("resources");
    expect(capabilities).not.toHaveProperty("prompts");
  });
});
