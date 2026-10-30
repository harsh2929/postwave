import { describe, expect, it } from "vitest";

import { parseJsonStreamPayload } from "../lib/stream-payload";

describe("web stream payload parser", () => {
  it("parses bounded JSON stream payloads", () => {
    expect(parseJsonStreamPayload<{ status: string }>('{"status":"running"}')).toEqual({
      ok: true,
      value: { status: "running" },
    });
  });

  it("rejects malformed stream payloads", () => {
    expect(parseJsonStreamPayload("{bad-json")).toEqual({
      ok: false,
      message: expect.stringContaining("JSON"),
    });
  });

  it("rejects oversized stream payloads before JSON parsing", () => {
    expect(parseJsonStreamPayload(JSON.stringify({ blob: "x".repeat(140_000) }))).toEqual({
      ok: false,
      message: "Stream payload is too large",
    });
  });

  it("counts UTF-8 bytes rather than JavaScript characters", () => {
    const payload = JSON.stringify({ blob: "😀".repeat(40_000) });

    expect(payload.length).toBeLessThan(128 * 1024);
    expect(parseJsonStreamPayload(payload)).toEqual({
      ok: false,
      message: "Stream payload is too large",
    });
  });
});
