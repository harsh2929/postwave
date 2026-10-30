// SPDX-License-Identifier: MIT

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveRenderableEmailPath,
  startDevServer,
  type DevServerHandle,
} from "../../src/dev/server.js";
import type { PostwaveClient } from "@postwave/sdk";

function mockClient(): PostwaveClient {
  return {
    inboxReality: {
      predict: async () => ({
        predicted: { primary: 0.8, promotions: 0.15, spam: 0.05 },
        content: {},
        at: new Date().toISOString(),
      }),
    },
    campaigns: {
      sendTest: async () => ({
        message_id: "msg_test",
        to: "preview@postwave.local",
        accepted_at: new Date().toISOString(),
      }),
    },
  } as unknown as PostwaveClient;
}

describe("dev server", () => {
  let dir: string;
  let handle: DevServerHandle | null = null;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "postwave-dev-srv-"));
  });
  afterEach(async () => {
    if (handle) await handle.close();
    handle = null;
    rmSync(dir, { recursive: true, force: true });
  });

  it("boots and serves the UI on the chosen port", async () => {
    handle = await startDevServer({
      client: mockClient(),
      port: 0,
      cwd: dir,
      recipientEmail: "test@example.com",
    });
    expect(handle.port).toBeGreaterThan(0);
    const r = await fetch(`${handle.url}/`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/html");
    const html = await r.text();
    expect(html).toContain("MAX_JSON_RESPONSE_BYTES");
    expect(html).toContain("fetchWithTimeout");
    expect(html).toContain("parseEventJson");
  });

  it("returns 404 for unknown paths", async () => {
    handle = await startDevServer({
      client: mockClient(),
      port: 0,
      cwd: dir,
      recipientEmail: "test@example.com",
    });
    const r = await fetch(`${handle.url}/nope`);
    expect(r.status).toBe(404);
    const body = (await r.json()) as { error: string };
    expect(body.error).toBe("not found");
  });

  it("lists email files (empty dir → empty array)", async () => {
    handle = await startDevServer({
      client: mockClient(),
      port: 0,
      cwd: dir,
      recipientEmail: "test@example.com",
    });
    const r = await fetch(`${handle.url}/api/files`);
    const body = (await r.json()) as { files: string[] };
    expect(Array.isArray(body.files)).toBe(true);
    expect(body.files).toHaveLength(0);
  });

  it("returns at least one persona (default fallback)", async () => {
    handle = await startDevServer({
      client: mockClient(),
      port: 0,
      cwd: dir,
      recipientEmail: "test@example.com",
    });
    const r = await fetch(`${handle.url}/api/personas`);
    const body = (await r.json()) as { personas: { email: string }[] };
    expect(body.personas.length).toBeGreaterThan(0);
  });

  it("exposes a health endpoint for editor integrations", async () => {
    handle = await startDevServer({
      client: mockClient(),
      port: 0,
      cwd: dir,
      recipientEmail: "test@example.com",
    });
    const r = await fetch(`${handle.url}/health`);
    expect(r.status).toBe(200);
    await expect(r.json()).resolves.toMatchObject({ ok: true });
  });

  it("rejects malformed JSON with a 400 instead of crashing the dev server", async () => {
    handle = await startDevServer({
      client: mockClient(),
      port: 0,
      cwd: dir,
      recipientEmail: "test@example.com",
    });

    const r = await fetch(`${handle.url}/api/render`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });

    expect(r.status).toBe(400);
    const body = (await r.json()) as { error: string };
    expect(body.error).toContain("invalid JSON request body");
  });

  it("rejects oversized JSON request bodies", async () => {
    handle = await startDevServer({
      client: mockClient(),
      port: 0,
      cwd: dir,
      recipientEmail: "test@example.com",
    });

    const r = await fetch(`${handle.url}/api/subject`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ html: "x".repeat(600 * 1024), candidates: ["A"] }),
    });

    expect(r.status).toBe(413);
    const body = (await r.json()) as { error: string };
    expect(body.error).toBe("JSON request body is too large");
  });

  it("keeps renderable file paths inside the dev server cwd", () => {
    writeFileSync(join(dir, "welcome.email.tsx"), "export default function Email(){}");
    const outsideDir = mkdtempSync(join(tmpdir(), "postwave-dev-outside-"));
    writeFileSync(join(outsideDir, "outside.email.tsx"), "export default function Email(){}");
    expect(resolveRenderableEmailPath(dir, "welcome.email.tsx")).toBe(
      realpathSync(join(dir, "welcome.email.tsx")),
    );
    try {
      expect(() => resolveRenderableEmailPath(dir, join(outsideDir, "outside.email.tsx"))).toThrow(
        "inside the dev server cwd",
      );
      expect(() => resolveRenderableEmailPath(dir, "notes.txt")).toThrow(
        "email file not found",
      );
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")("rejects renderable symlinks that escape cwd", () => {
    const outsideDir = mkdtempSync(join(tmpdir(), "postwave-dev-outside-"));
    try {
      writeFileSync(join(outsideDir, "outside.email.tsx"), "export default function Email(){}");
      symlinkSync(join(outsideDir, "outside.email.tsx"), join(dir, "linked.email.tsx"));

      expect(() => resolveRenderableEmailPath(dir, "linked.email.tsx")).toThrow(
        "inside the dev server cwd",
      );
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it("rejects unsafe render path values before filesystem access", () => {
    expect(() => resolveRenderableEmailPath(dir, " welcome.email.tsx")).toThrow(
      "unsafe email file path",
    );
    expect(() => resolveRenderableEmailPath(dir, "welcome.email.tsx\nx")).toThrow(
      "unsafe email file path",
    );
    expect(() => resolveRenderableEmailPath(dir, `${"x".repeat(2049)}.email.tsx`)).toThrow(
      "unsafe email file path",
    );
  });
});
