// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync } from "node:fs";

import {
  redactEvent,
  redactQueryString,
  redactUrl,
  type RedactableEvent,
} from "@postwave/telemetry";
import { describe, expect, it } from "vitest";

describe("web Sentry shared redaction", () => {
  it("strips credentials, bodies, cookies, and non-allowlisted headers", () => {
    const event: RedactableEvent = {
      request: {
        data: { password: "hunter2" },
        cookies: "session=abc",
        headers: {
          Authorization: "Bearer pw_secret",
          Cookie: "session=abc",
          "X-Postwave-Token": "tok_123",
          "User-Agent": "Mozilla/5.0",
          Accept: "application/json",
        },
      },
    };
    const out = redactEvent(event);
    expect(out.request?.data).toBeUndefined();
    expect(out.request?.cookies).toBeUndefined();
    expect(out.request?.headers).toEqual({ Accept: "application/json" });
  });

  it("redacts sensitive query values while retaining safe keys", () => {
    const out = redactQueryString(
      "user_email=ada%40example.com&session_id=s1&cursor=payload.signature&keep=value",
    );
    expect(out).not.toContain("ada%40example.com");
    expect(out).not.toContain("payload.signature");
    expect(out).toContain("user_email=%5Bredacted%5D");
    expect(out).toContain("cursor=%5Bredacted%5D");
    expect(out).toContain("keep=value");
  });

  it("redacts the hosted preference bearer and preserves its route shape", () => {
    const token =
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    const out = redactUrl(
      `https://moosewave.com/api/public/preferences/${token}/one-click?keep=value`,
    );
    expect(out).not.toContain(token);
    expect(out).toContain(
      "/api/public/preferences/[redacted]/one-click?keep=value",
    );
  });

  it("redacts the preference capability inside a complete event", () => {
    const token =
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    const event: RedactableEvent = {
      request: {
        url: `https://moosewave.com/api/public/preferences/${token}`,
      },
    };
    const out = redactEvent(event);
    expect(String(out.request?.url)).not.toContain(token);
    expect(String(out.request?.url)).toContain(
      "/api/public/preferences/[redacted]",
    );
  });

  it("keeps the Edge Sentry runtime on the shared telemetry scrubber", () => {
    const source = readFileSync(
      new URL("../../../sentry.edge.config.ts", import.meta.url),
      "utf8",
    );
    expect(source).toContain('from "@postwave/telemetry"');
    expect(source).toContain(
      "redactEvent(event as unknown as RedactableEvent)",
    );
    expect(source).not.toContain("function redactUrl(");
  });
});
