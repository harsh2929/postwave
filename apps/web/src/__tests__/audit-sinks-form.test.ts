// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// SETA-056: locks in the two HIGH data-loss fixes from the adversarial review —
// the edit PATCH must NOT wipe an advanced kind's nested config, and a partial
// credential rotation must be blocked (the backend replaces the whole envelope).

import { describe, it, expect } from "vitest";

import {
  buildSinkEditInput,
  missingRequired,
  sinkEditIsUnchanged,
  type SinkFormValue,
} from "@/app/(dashboard)/app/settings/audit-sinks/sink-form";

function form(over: Partial<SinkFormValue> = {}): SinkFormValue {
  return {
    name: "x",
    kind: "http",
    config: {},
    credentials: {},
    outputFormat: "postwave_native",
    webhookFormat: "postwave_v1",
    ...over,
  };
}

describe("buildSinkEditInput", () => {
  it("omits config for advanced kinds so nested server config isn't wiped", () => {
    const input = buildSinkEditInput(form({ kind: "archive", config: {} }));
    expect("config" in input).toBe(false);
    const input2 = buildSinkEditInput(
      form({ kind: "snowflake_shareback", config: {} }),
    );
    expect("config" in input2).toBe(false);
  });

  it("includes config for flat-spec kinds (s3)", () => {
    const input = buildSinkEditInput(
      form({ kind: "s3", config: { bucket: "b", region: "r" } }),
    );
    expect(input.config).toEqual({ bucket: "b", region: "r" });
  });

  it("omits credentials when none entered (keeps the stored secrets)", () => {
    const input = buildSinkEditInput(form({ kind: "s3", credentials: {} }));
    expect("credentials" in input).toBe(false);
  });

  it("sends credentials only when entered", () => {
    const input = buildSinkEditInput(
      form({ kind: "datadog", credentials: { api_key: "k" } }),
    );
    expect(input.credentials).toEqual({ api_key: "k" });
  });
});

describe("sinkEditIsUnchanged", () => {
  it("normalizes harmless whitespace and empty credential fields", () => {
    const initial = form({
      name: "Production SIEM",
      config: { url: "https://audit.example.test", bearer_token: "" },
      credentials: {},
    });
    const current = form({
      name: "  Production SIEM  ",
      config: { url: " https://audit.example.test ", bearer_token: "   " },
      credentials: { hmac_secret: "" },
    });

    expect(sinkEditIsUnchanged(current, initial)).toBe(true);
  });

  it("detects semantic changes to formats, config, or credentials", () => {
    const initial = form({ config: { url: "https://audit.example.test" } });

    expect(
      sinkEditIsUnchanged(
        form({ outputFormat: "ocsf_1_8", config: initial.config }),
        initial,
      ),
    ).toBe(false);
    expect(
      sinkEditIsUnchanged(
        form({ config: { url: "https://other.example.test" } }),
        initial,
      ),
    ).toBe(false);
    expect(
      sinkEditIsUnchanged(
        form({
          config: initial.config,
          credentials: { hmac_secret: "rotated-secret" },
        }),
        initial,
      ),
    ).toBe(false);
  });
});

describe("missingRequired — credential all-or-nothing on edit", () => {
  it("blocks a partial s3 credential rotation (would wipe the sibling secret)", () => {
    const err = missingRequired(
      form({
        kind: "s3",
        config: { bucket: "b", region: "r" },
        credentials: { aws_access_key_id: "k" },
      }),
      true,
    );
    expect(err).toMatch(/complete set|envelope/i);
  });

  it("allows a full s3 credential rotation", () => {
    const err = missingRequired(
      form({
        kind: "s3",
        config: { bucket: "b", region: "r" },
        credentials: { aws_access_key_id: "k", aws_secret_access_key: "s" },
      }),
      true,
    );
    expect(err).toBeNull();
  });

  it("allows an edit with no credentials entered (unchanged)", () => {
    const err = missingRequired(
      form({
        kind: "s3",
        config: { bucket: "b", region: "r" },
        credentials: {},
      }),
      true,
    );
    expect(err).toBeNull();
  });

  it("requires the credential on create", () => {
    const err = missingRequired(
      form({ kind: "datadog", credentials: {} }),
      false,
    );
    expect(err).toMatch(/required/i);
  });
});
