// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import {
  GENERIC_SERVER_ERROR,
  NETWORK_ERROR,
  genericAuthErrorMessage,
  isNetworkError,
} from "@/lib/auth-errors";

// Minimal ApiError-shaped stand-ins (the helper duck-types on status/kind).
const httpError = (status: number) => ({ status, kind: "http" });
const networkError = () => ({ status: 0, kind: "network" });
const timeoutError = () => ({ status: 0, kind: "timeout" });

describe("isNetworkError", () => {
  it("treats status-0 transport failures as network errors", () => {
    expect(isNetworkError(networkError())).toBe(true);
    expect(isNetworkError(timeoutError())).toBe(true);
  });
  it("does not treat HTTP responses as network errors", () => {
    expect(isNetworkError(httpError(500))).toBe(false);
    expect(isNetworkError(httpError(401))).toBe(false);
  });
  it("treats non-ApiError values as non-network", () => {
    expect(isNetworkError(new Error("boom"))).toBe(false);
    expect(isNetworkError("nope")).toBe(false);
    expect(isNetworkError(null)).toBe(false);
  });
});

describe("genericAuthErrorMessage", () => {
  it("maps 5xx to a friendly server message", () => {
    expect(genericAuthErrorMessage(httpError(500))).toBe(GENERIC_SERVER_ERROR);
    expect(genericAuthErrorMessage(httpError(503))).toBe(GENERIC_SERVER_ERROR);
  });
  it("maps transport failures to a connection message", () => {
    expect(genericAuthErrorMessage(networkError())).toBe(NETWORK_ERROR);
  });
  it("maps unknown/plain errors to the generic server message", () => {
    expect(genericAuthErrorMessage(new Error("x"))).toBe(GENERIC_SERVER_ERROR);
  });
  it("never leaks the raw technical ApiError string", () => {
    const raw = {
      status: 500,
      kind: "http",
      message: "POST /api/v1/auth/login failed: 500 Internal Server Error",
    };
    const shown = genericAuthErrorMessage(raw);
    expect(shown).not.toContain("failed:");
    expect(shown).not.toContain("POST ");
    expect(shown).not.toContain("500");
  });
});
