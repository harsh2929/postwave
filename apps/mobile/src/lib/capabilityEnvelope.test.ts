import { describe, expect, it } from "vitest";

import {
  capabilityEnvelopeFromError,
  capabilityUnavailableMessage,
  isCapabilityUnavailable,
  parseCapabilityEnvelope,
} from "./capabilityEnvelope";

/** Byte-for-byte the body runtimecapability.WriteUnavailable encodes. */
const WIRE = {
  error: {
    code: "flow_runtime_unavailable",
    message: "Flow execution is disabled in this deployment.",
    capability: "flow_runtime",
    runtime_status: "unavailable",
    retryable: false,
  },
};

describe("parseCapabilityEnvelope", () => {
  it("reads the server's envelope", () => {
    expect(parseCapabilityEnvelope(WIRE)).toEqual({
      capability: "flow_runtime",
      runtimeStatus: "unavailable",
      retryable: false,
    });
  });

  it("returns null for an ordinary {error:{code,message}} body", () => {
    expect(
      parseCapabilityEnvelope({ error: { code: "not_found", message: "no" } }),
    ).toBeNull();
  });

  it("requires BOTH capability and runtime_status", () => {
    expect(
      parseCapabilityEnvelope({ error: { capability: "flow_runtime" } }),
    ).toBeNull();
    expect(
      parseCapabilityEnvelope({ error: { runtime_status: "unavailable" } }),
    ).toBeNull();
  });

  it("ignores non-object and empty-string inputs", () => {
    expect(parseCapabilityEnvelope(null)).toBeNull();
    expect(parseCapabilityEnvelope("503")).toBeNull();
    expect(parseCapabilityEnvelope({ error: null })).toBeNull();
    expect(
      parseCapabilityEnvelope({
        error: { capability: "  ", runtime_status: "unavailable" },
      }),
    ).toBeNull();
  });

  it("never reports retryable true unless the server said so literally", () => {
    expect(
      parseCapabilityEnvelope({
        error: {
          capability: "c",
          runtime_status: "unavailable",
          retryable: "true",
        },
      })?.retryable,
    ).toBe(false);
  });
});

describe("capabilityEnvelopeFromError", () => {
  it("reads PostwaveError.payload", () => {
    expect(
      capabilityEnvelopeFromError({ status: 503, payload: WIRE })?.capability,
    ).toBe("flow_runtime");
  });

  it("returns null for an error with no payload", () => {
    expect(capabilityEnvelopeFromError(new Error("boom"))).toBeNull();
    expect(capabilityEnvelopeFromError(null)).toBeNull();
  });
});

describe("isCapabilityUnavailable", () => {
  it("is true only for a 503 carrying the full envelope", () => {
    expect(
      isCapabilityUnavailable({
        status: 503,
        capability: "flow_runtime",
        runtimeStatus: "unavailable",
      }),
    ).toBe(true);
  });

  it("is false for a plain 503", () => {
    expect(isCapabilityUnavailable({ status: 503 })).toBe(false);
  });

  it("is false for a 404 — a missing route is a different sentence", () => {
    expect(
      isCapabilityUnavailable({
        status: 404,
        capability: "flow_runtime",
        runtimeStatus: "unavailable",
      }),
    ).toBe(false);
  });

  it("is false for junk", () => {
    expect(isCapabilityUnavailable(null)).toBe(false);
    expect(isCapabilityUnavailable("503")).toBe(false);
  });
});

describe("capabilityUnavailableMessage", () => {
  const envelope = {
    capability: "flow_runtime",
    runtimeStatus: "unavailable",
    retryable: false,
  };

  it("prefers the server's own sentence", () => {
    expect(capabilityUnavailableMessage(envelope, WIRE.error.message)).toBe(
      "Flow execution is disabled in this deployment.",
    );
  });

  it("names the capability instead of inventing a reason", () => {
    expect(capabilityUnavailableMessage(envelope, "   ")).toBe(
      "flow_runtime is switched off in this deployment. Nothing to retry.",
    );
    expect(capabilityUnavailableMessage(envelope)).toContain("Nothing to retry");
  });
});
