/**
 * The mirror's outcome fold: an unconfigured provider is DATA, not an error —
 * and only the genuine 503 `not_configured` reply gets folded, so a real
 * outage can never dress up as a setup prompt.
 */
import { describe, expect, it } from "vitest";

import {
  interpretMirrorFailure,
  mirrorNotConfiguredCopy,
  MIRROR_PROVIDERS,
  parseMirrorResult,
  summarizeMirrorRun,
} from "./suppressionMirror";

describe("interpretMirrorFailure", () => {
  it("folds the 503 not_configured reply into the data channel", () => {
    const outcome = interpretMirrorFailure(
      503,
      { provider: "mailchimp", not_configured: true, not_configured_reason: "no API key on file" },
      "mailchimp",
    );
    expect(outcome).toEqual({ kind: "not_configured", reason: "no API key on file" });
  });

  it("replaces the handler's generic internal sentence with the setup pointer", () => {
    const outcome = interpretMirrorFailure(
      503,
      { not_configured: true, not_configured_reason: "an internal error occurred" },
      "sendgrid",
    );
    expect(outcome?.kind).toBe("not_configured");
    expect(outcome && outcome.kind === "not_configured" ? outcome.reason : "").toMatch(
      /sendgrid.*ESP API key/su,
    );
  });

  it("does NOT fold a 503 without the not_configured marker (a real outage)", () => {
    expect(interpretMirrorFailure(503, { error: "db down" }, "mailchimp")).toBeNull();
    expect(interpretMirrorFailure(503, undefined, "mailchimp")).toBeNull();
  });

  it("does NOT fold other statuses even when the body carries the marker", () => {
    expect(
      interpretMirrorFailure(500, { not_configured: true }, "mailchimp"),
    ).toBeNull();
    expect(
      interpretMirrorFailure(403, { not_configured: true }, "mailchimp"),
    ).toBeNull();
  });
});

describe("parseMirrorResult", () => {
  it("reads the summary counts and clamps garbage to zero", () => {
    expect(
      parseMirrorResult(
        { provider: "sendgrid", fetched: 120, imported: 7, skipped: 113, errors: "x" },
        "sendgrid",
      ),
    ).toEqual({ provider: "sendgrid", fetched: 120, imported: 7, skipped: 113, errors: 0 });
  });

  it("throws on a body that is not the summary", () => {
    expect(() => parseMirrorResult(null, "mailchimp")).toThrow();
    expect(() => parseMirrorResult("ok", "mailchimp")).toThrow();
  });
});

describe("copy", () => {
  it("summarizes a run, naming failures only when there were any", () => {
    expect(
      summarizeMirrorRun({ provider: "mailchimp", fetched: 10, imported: 3, skipped: 7, errors: 0 }),
    ).toBe("Checked 10 provider rows — 3 imported, 7 already present.");
    expect(
      summarizeMirrorRun({ provider: "mailchimp", fetched: 10, imported: 3, skipped: 5, errors: 2 }),
    ).toMatch(/2 failed/u);
  });

  it("keeps a specific server reason verbatim", () => {
    expect(mirrorNotConfiguredCopy("mailchimp", "custom reason")).toBe("custom reason");
  });

  it("offers exactly the providers with real tenant-credential mirror clients", () => {
    expect(MIRROR_PROVIDERS.map((p) => p.value)).toEqual(["mailchimp", "sendgrid"]);
  });
});
