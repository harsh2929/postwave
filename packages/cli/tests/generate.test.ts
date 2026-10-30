// SPDX-License-Identifier: MIT

import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateEmail, generateWebhookHandler } from "../src/commands/generate.js";

function captureStdout(fn: () => void): string {
  let out = "";
  const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    out += String(chunk);
    return true;
  });
  try {
    fn();
  } finally {
    spy.mockRestore();
  }
  return out;
}

describe("generate webhook-handler", () => {
  it.each(["express", "hono", "next-route"] as const)(
    "emits event-family dispatch for %s",
    (framework) => {
      const out = captureStdout(() => generateWebhookHandler({ framework }));
      expect(out).toContain("verifySignature");
      expect(out).toContain("handlePostwaveEvent");
      expect(out).toContain('case "campaign.sent"');
      expect(out).toContain('case "subscriber.unsubscribed"');
      expect(out).toContain('case "list.subscriber.added"');
      expect(out).toContain("type PostwaveWebhookEnvelope");
      expect(out).toContain("envelope.event.id");
      expect(out).not.toContain('case "campaign.opened"');
      expect(out).not.toContain('case "sms.replied"');
      expect(out).toContain("MAX_WEBHOOK_BODY_BYTES");
      expect(out).not.toContain("TODO: handle event.type");
    },
  );

  it("emits bounded request body readers for Fetch-style frameworks", () => {
    expect(captureStdout(() => generateWebhookHandler({ framework: "hono" }))).toContain(
      "readRequestTextLimited(c.req.raw)",
    );
    expect(
      captureStdout(() => generateWebhookHandler({ framework: "next-route" })),
    ).toContain("readRequestTextLimited(req)");
  });

  it("emits explicit 413 responses for oversized Fetch-style webhooks", () => {
    expect(captureStdout(() => generateWebhookHandler({ framework: "hono" }))).toContain(
      'return c.json({ error: "webhook body too large" }, 413)',
    );
    expect(
      captureStdout(() => generateWebhookHandler({ framework: "next-route" })),
    ).toContain('status: 413');
  });

  it("sets an Express raw-body limit", () => {
    const out = captureStdout(() => generateWebhookHandler({ framework: "express" }));
    expect(out).toContain('limit: MAX_WEBHOOK_BODY_BYTES');
  });
});

describe("generate file writes", () => {
  it("refuses to overwrite generated files unless forced", () => {
    const dir = mkdtempSync(join(tmpdir(), "postwave-generate-"));
    const oldCwd = process.cwd();
    const oldExitCode = process.exitCode;
    process.chdir(dir);
    try {
      writeFileSync("Welcome.tsx", "existing", "utf8");
      generateEmail({ name: "Welcome" });
      expect(readFileSync("Welcome.tsx", "utf8")).toBe("existing");
      expect(process.exitCode).toBe(1);

      process.exitCode = undefined;
      generateEmail({ name: "Welcome", force: true });
      expect(readFileSync("Welcome.tsx", "utf8")).toContain(
        "export default function Welcome",
      );
      expect(process.exitCode).toBeUndefined();
    } finally {
      process.exitCode = oldExitCode;
      process.chdir(oldCwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
