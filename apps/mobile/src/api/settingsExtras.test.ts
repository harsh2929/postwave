import { describe, expect, it, vi } from "vitest";

vi.mock("./request", () => ({ rawRequest: vi.fn() }));

const { rawRequest } = await import("./request");
const {
  FAILURE_RATE_BOUNDS,
  LATENCY_BOUNDS,
  clampFailureRate,
  clampLatencyMs,
  normalizeDigestFrequency,
  putDigestPrefs,
  regionForTimezone,
} = await import("./settingsExtras");

const rawRequestMock = vi.mocked(rawRequest);

describe("normalizeDigestFrequency", () => {
  it("passes the two real cadences through", () => {
    expect(normalizeDigestFrequency("daily")).toBe("daily");
    expect(normalizeDigestFrequency("weekly")).toBe("weekly");
  });

  it("maps the server's own 'off' through unchanged", () => {
    expect(normalizeDigestFrequency("off")).toBe("off");
  });

  it("treats the literal false, the string 'false', and junk as 'off'", () => {
    // The handler decodes `frequency` into a Go string and 400s on a JSON
    // boolean, so `false` must never reach the wire.
    expect(normalizeDigestFrequency(false)).toBe("off");
    expect(normalizeDigestFrequency("false")).toBe("off");
    expect(normalizeDigestFrequency(undefined)).toBe("off");
    expect(normalizeDigestFrequency("monthly")).toBe("off");
  });
});

describe("putDigestPrefs", () => {
  it("always puts a STRING frequency on the wire, never a boolean", async () => {
    rawRequestMock.mockReset();
    rawRequestMock.mockResolvedValue({ data: null, error: null } as never);
    await putDigestPrefs("off");
    // A JSON boolean cannot unmarshal into the handler's `string` field: it
    // 400s before validation, which is how "Off" used to be unsavable.
    expect(rawRequestMock).toHaveBeenCalledWith(
      "PUT",
      "/api/v1/dashboard/digest",
      { frequency: "off" },
    );
    await putDigestPrefs("weekly" as never);
    expect(rawRequestMock).toHaveBeenLastCalledWith(
      "PUT",
      "/api/v1/dashboard/digest",
      { frequency: "weekly" },
    );
  });

  it("coerces a legacy boolean caller back to 'off' rather than 400ing", async () => {
    rawRequestMock.mockReset();
    rawRequestMock.mockResolvedValue({ data: null, error: null } as never);
    await putDigestPrefs(false as never);
    expect(rawRequestMock).toHaveBeenCalledWith(
      "PUT",
      "/api/v1/dashboard/digest",
      { frequency: "off" },
    );
  });
});

describe("clampFailureRate", () => {
  it("holds the server's 1..100 bounds so a slider can't produce a 422", () => {
    expect(clampFailureRate(0)).toBe(FAILURE_RATE_BOUNDS.min);
    expect(clampFailureRate(-5)).toBe(FAILURE_RATE_BOUNDS.min);
    expect(clampFailureRate(250)).toBe(FAILURE_RATE_BOUNDS.max);
    expect(clampFailureRate(37)).toBe(37);
  });

  it("rounds fractional input and survives NaN", () => {
    expect(clampFailureRate(12.6)).toBe(13);
    expect(clampFailureRate(Number.NaN)).toBe(FAILURE_RATE_BOUNDS.min);
  });
});

describe("clampLatencyMs", () => {
  it("holds the server's 1..600000 bounds", () => {
    expect(clampLatencyMs(0)).toBe(LATENCY_BOUNDS.min);
    expect(clampLatencyMs(10_000_000)).toBe(LATENCY_BOUNDS.max);
    expect(clampLatencyMs(2500)).toBe(2500);
  });
});

describe("regionForTimezone", () => {
  it("maps European zones to GDPR", () => {
    expect(regionForTimezone("Europe/Berlin")).toBe("GDPR");
    expect(regionForTimezone("Europe/London")).toBe("GDPR");
  });

  it("maps US Pacific to CCPA", () => {
    expect(regionForTimezone("America/Los_Angeles")).toBe("CCPA");
  });

  it("defaults to OTHER for everything else, including a missing timezone", () => {
    expect(regionForTimezone("America/New_York")).toBe("OTHER");
    expect(regionForTimezone(undefined)).toBe("OTHER");
    expect(regionForTimezone("  ")).toBe("OTHER");
  });
});
