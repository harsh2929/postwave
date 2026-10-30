import { describe, expect, it } from "vitest";

import {
  isPiiGatewayUnavailable,
  normalizePiiMaskingConfig,
  piiFieldLocked,
  piiMaskPatchBody,
  piiMaskedSummary,
  piiSaveErrorMessage,
} from "@/lib/aiPiiMasking";

describe("normalizePiiMaskingConfig", () => {
  it("leads with every built-in identifier, locked on, even with no persisted row", () => {
    const cfg = normalizePiiMaskingConfig({
      built_in_fields: ["email", "phone"],
      fields: [{ field_name: "company", sensitive: false, built_in: false }],
    });
    expect(cfg.builtInFields).toEqual(["email", "phone"]);
    expect(cfg.fields).toEqual([
      { fieldName: "email", sensitive: true, builtIn: true },
      { fieldName: "phone", sensitive: true, builtIn: true },
      { fieldName: "company", sensitive: false, builtIn: false },
    ]);
  });

  it("folds a persisted built-in row into the leading one and keeps it masked", () => {
    const cfg = normalizePiiMaskingConfig({
      built_in_fields: ["email"],
      fields: [
        { field_name: "email", sensitive: false, built_in: true },
        { field_name: "salary", sensitive: true },
      ],
    });
    expect(cfg.fields.map((f) => f.fieldName)).toEqual(["email", "salary"]);
    expect(cfg.fields[0]).toEqual({
      fieldName: "email",
      sensitive: true,
      builtIn: true,
    });
    expect(cfg.fields[1]).toEqual({
      fieldName: "salary",
      sensitive: true,
      builtIn: false,
    });
  });

  it("honours a built_in flag the server sets on a row outside built_in_fields", () => {
    const cfg = normalizePiiMaskingConfig({
      fields: [{ field_name: "ssn", sensitive: false, built_in: true }],
    });
    expect(cfg.fields).toEqual([
      { fieldName: "ssn", sensitive: true, builtIn: true },
    ]);
  });

  it("drops junk rows and tolerates a null payload", () => {
    expect(normalizePiiMaskingConfig(null)).toEqual({
      builtInFields: [],
      fields: [],
    });
    const cfg = normalizePiiMaskingConfig({
      fields: [null, { sensitive: true }, { field_name: "  " }],
    });
    expect(cfg.fields).toEqual([]);
  });
});

describe("isPiiGatewayUnavailable", () => {
  it("is true only for the unconfigured code, a 404, or a 501", () => {
    expect(
      isPiiGatewayUnavailable({
        status: 503,
        code: "pii_gateway_unconfigured",
      }),
    ).toBe(true);
    expect(isPiiGatewayUnavailable({ status: 404 })).toBe(true);
    expect(isPiiGatewayUnavailable({ status: 501 })).toBe(true);
  });

  it("treats a bare 503 as an outage, not a product boundary", () => {
    expect(isPiiGatewayUnavailable({ status: 503 })).toBe(false);
    expect(isPiiGatewayUnavailable({ status: 500 })).toBe(false);
    expect(isPiiGatewayUnavailable(null)).toBe(false);
    expect(isPiiGatewayUnavailable(new Error("x"))).toBe(false);
  });
});

describe("piiMaskPatchBody / piiFieldLocked / piiMaskedSummary", () => {
  it("shapes one toggle as the handler's batch body", () => {
    expect(piiMaskPatchBody("company", true)).toEqual({
      fields: [{ field_name: "company", sensitive: true }],
    });
  });

  it("locks built-ins for everyone and custom fields for non-admins", () => {
    const builtIn = { fieldName: "email", sensitive: true, builtIn: true };
    const custom = { fieldName: "company", sensitive: false, builtIn: false };
    expect(piiFieldLocked(builtIn, true)).toBe(true);
    expect(piiFieldLocked(custom, true)).toBe(false);
    expect(piiFieldLocked(custom, false)).toBe(true);
  });

  it("counts masked fields", () => {
    expect(
      piiMaskedSummary([
        { fieldName: "email", sensitive: true, builtIn: true },
        { fieldName: "company", sensitive: false, builtIn: false },
        { fieldName: "salary", sensitive: true, builtIn: false },
      ]),
    ).toBe("2 of 3 masked");
    expect(piiMaskedSummary([])).toBe("0 of 0 masked");
  });
});

describe("piiSaveErrorMessage", () => {
  it("names the role floor on a 403 and the gateway on the unconfigured code", () => {
    expect(piiSaveErrorMessage({ status: 403, message: "forbidden" })).toMatch(
      /workspace admins/,
    );
    expect(
      piiSaveErrorMessage({
        status: 503,
        code: "pii_gateway_unconfigured",
        message: "PII gateway is not configured",
      }),
    ).toMatch(/isn't configured/);
  });

  it("otherwise repeats the server's message, with a fallback for an empty one", () => {
    expect(piiSaveErrorMessage({ status: 500, message: "boom" })).toBe("boom");
    expect(piiSaveErrorMessage({ status: 0, message: "" })).toBe(
      "Couldn't update field privacy.",
    );
  });
});
