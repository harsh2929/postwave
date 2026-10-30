import { describe, expect, it } from "vitest";

import { parseJsonStreamPayload } from "../../lib/stream-payload";

describe("desktop stream payload parser", () => {
  it("parses bounded JSON stream payloads", () => {
    expect(parseJsonStreamPayload<{ topic: string }>('{"topic":"campaign.created"}')).toEqual({
      ok: true,
      value: { topic: "campaign.created" },
    });
  });

  it("rejects malformed stream payloads", () => {
    expect(parseJsonStreamPayload("{bad-json")).toEqual({
      ok: false,
      message: expect.stringContaining("JSON"),
    });
  });

  it("rejects oversized stream payloads before JSON parsing", () => {
    const result = parseJsonStreamPayload(
      JSON.stringify({ topic: "x".repeat(140_000) }),
    );

    expect(result).toEqual({
      ok: false,
      message: "Stream payload is too large",
    });
  });

  it("counts UTF-8 bytes rather than JavaScript characters", () => {
    const payload = JSON.stringify({ topic: "😀".repeat(40_000) });

    expect(payload.length).toBeLessThan(128 * 1024);
    expect(parseJsonStreamPayload(payload)).toEqual({
      ok: false,
      message: "Stream payload is too large",
    });
  });
});
