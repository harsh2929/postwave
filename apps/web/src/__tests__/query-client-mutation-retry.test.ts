// SPDX-License-Identifier: AGPL-3.0-only

import { MutationObserver } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";

import { makeQueryClient } from "@/lib/query-client";

describe("query client mutation retry defaults", () => {
  it("disables both global and outbox-resource Query retries", () => {
    const client = makeQueryClient();
    expect(client.getDefaultOptions().mutations?.retry).toBe(false);
    expect(client.getMutationDefaults(["segments", "save"]).retry).toBe(false);
    expect(client.getMutationDefaults(["forms", "publish"]).retry).toBe(false);
  });

  it.each([
    ["global", undefined],
    ["segments outbox resource", ["segments", "save"] as const],
    ["forms outbox resource", ["forms", "publish"] as const],
  ])(
    "invokes a failed %s mutation exactly once",
    async (_label, mutationKey) => {
      const client = makeQueryClient();
      let calls = 0;
      const observer = new MutationObserver<never, Error, void>(client, {
        ...(mutationKey ? { mutationKey } : {}),
        mutationFn: async () => {
          calls += 1;
          throw Object.assign(new Error("transport exhausted"), {
            status: 503,
          });
        },
      });

      await expect(observer.mutate()).rejects.toThrow("transport exhausted");
      expect(calls).toBe(1);
    },
  );

  it("keeps the replay engine out of the synchronous query-client boundary", async () => {
    const source = await import("node:fs/promises").then(({ readFile }) =>
      readFile(new URL("../lib/query-client.ts", import.meta.url), "utf8"),
    );

    expect(source).toContain('const OUTBOX_RESOURCES = ["segments", "forms"]');
    expect(source).toContain("client.setMutationDefaults([resource]");
    expect(source).not.toContain('from "./outbox-query-defaults"');
    expect(source).not.toContain('from "./outbox"');
  });
});
