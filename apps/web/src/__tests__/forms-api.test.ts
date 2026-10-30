import { afterEach, describe, expect, it } from "vitest";

import {
  configuredFormsOrigin,
  normalizeLists,
  publicFormUrl,
  publicFormsOrigin,
  submissionsCsvUrl,
} from "@/lib/forms-api";

describe("forms-api URL helpers", () => {
  afterEach(() => {
    const g = globalThis as unknown as { window?: unknown };
    delete g.window;
  });

  it("encodes form IDs and slugs before placing them in URLs", () => {
    expect(submissionsCsvUrl("form/id?x=1")).toBe(
      "/api/v1/forms/form%2Fid%3Fx%3D1/submissions.csv",
    );
    expect(publicFormUrl("launch/signup?x=1")).toBe(
      "https://forms.moosewave.com/forms/launch%2Fsignup%3Fx%3D1",
    );
  });

  it("resolves a deterministic origin during render (no window read) — FORM-001", () => {
    // Even with a window present, render-time origin stays deterministic so
    // SSR and first client paint agree.
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        location: { hostname: "127.0.0.1", origin: "http://127.0.0.1:3000" },
      } as unknown as Window & typeof globalThis,
    });
    expect(publicFormsOrigin()).toBe("https://forms.moosewave.com");
    expect(publicFormUrl("local form")).toBe(
      "https://forms.moosewave.com/forms/local%20form",
    );
  });

  it("accepts an explicit origin override (post-mount browser origin)", () => {
    expect(publicFormUrl("hello", "http://127.0.0.1:3000/")).toBe(
      "http://127.0.0.1:3000/forms/hello",
    );
  });

  it("configuredFormsOrigin returns '' when no env is set", () => {
    expect(configuredFormsOrigin()).toBe("");
  });
});

describe("normalizeLists (target-list picker) — FORM-033", () => {
  it("unwraps the Listmonk {data:{results}} envelope", () => {
    expect(
      normalizeLists({
        data: { results: [{ id: 42, name: "Newsletter", subscriber_count: 9 }] },
      }),
    ).toEqual([{ id: 42, name: "Newsletter", subscriberCount: 9 }]);
  });

  it("tolerates a bare array and the items/results aliases", () => {
    expect(normalizeLists([{ id: 1, name: "A" }])).toEqual([
      { id: 1, name: "A", subscriberCount: undefined },
    ]);
    expect(normalizeLists({ items: [{ id: 2, name: "B" }] })).toEqual([
      { id: 2, name: "B", subscriberCount: undefined },
    ]);
    expect(normalizeLists({ results: [{ id: 3, name: "C" }] })).toEqual([
      { id: 3, name: "C", subscriberCount: undefined },
    ]);
  });

  it("names an unnamed list and drops malformed rows", () => {
    expect(
      normalizeLists({
        data: {
          results: [
            { id: 7, name: "" },
            { name: "no id" } as unknown as { id: number; name: string },
          ],
        },
      }),
    ).toEqual([{ id: 7, name: "List 7", subscriberCount: undefined }]);
  });

  it("returns [] for null/empty envelopes", () => {
    expect(normalizeLists(null)).toEqual([]);
    expect(normalizeLists({})).toEqual([]);
  });
});
