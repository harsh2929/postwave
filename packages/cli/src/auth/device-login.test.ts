// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";

import { classifyPollError } from "./device-login.js";

describe("classifyPollError (RFC 8628 device-token poll)", () => {
  it("keeps polling while pending", () => {
    expect(classifyPollError("authorization_pending")).toBe("pending");
  });
  it("backs off on slow_down", () => {
    expect(classifyPollError("slow_down")).toBe("slow_down");
  });
  it("stops on a denied grant", () => {
    expect(classifyPollError("access_denied")).toBe("denied");
  });
  it("stops on an expired code", () => {
    expect(classifyPollError("expired_token")).toBe("expired");
  });
  it("treats an unknown / missing code as fatal (never loops forever)", () => {
    expect(classifyPollError("something_else")).toBe("fatal");
    expect(classifyPollError(undefined)).toBe("fatal");
    expect(classifyPollError("")).toBe("fatal");
  });
});
