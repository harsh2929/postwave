// SPDX-License-Identifier: MIT

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  pushSuppressionAdd,
  pushSuppressionRemove,
  pushSuppressionsBulkImport,
  pushSuppressionsBulkRemove,
  pushSuppressionsList,
} from "../src/commands/push-suppressions.js";
import { createClient } from "../src/lib/client.js";

vi.mock("../src/lib/client.js", () => ({ createClient: vi.fn() }));

const TENANT = "00000000-0000-0000-0000-000000000001";
const ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SECOND_ID = "99999999-9999-4999-8999-999999999999";

function resource() {
  const pushSuppressions = {
    list: vi.fn(async () => ({
      tenantId: TENANT,
      items: [],
      total: 0,
      snapshotAt: "2026-08-28T12:00:00Z",
    })),
    add: vi.fn(async () => ({ id: ID, tenant_id: TENANT })),
    remove: vi.fn(async () => ({
      ok: true,
      tenantId: TENANT,
      id: ID,
      version: 2,
      stillSuppressed: false,
    })),
    bulkImport: vi.fn(async () => ({
      ok: true,
      tenantId: TENANT,
      created: 1,
      existing: 1,
      items: [],
    })),
    bulkRemove: vi.fn(async () => ({
      ok: true,
      tenantId: TENANT,
      removed: 2,
      stillSuppressed: 0,
      items: [],
    })),
  };
  vi.mocked(createClient).mockReturnValue({ pushSuppressions } as never);
  return pushSuppressions;
}

let directory: string | undefined;
function file(name: string, contents: string): string {
  directory ??= mkdtempSync(join(tmpdir(), "postwave-push-cli-"));
  const path = join(directory, name);
  writeFileSync(path, contents, { mode: 0o600 });
  return path;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(createClient).mockReset();
  process.exitCode = undefined;
  if (directory) rmSync(directory, { recursive: true, force: true });
  directory = undefined;
});

describe("Route43 CLI push suppression commands", () => {
  it("preserves snapshot filters and exact tenant binding", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const push = resource();
    await pushSuppressionsList({
      tenantUuid: TENANT,
      platform: "fcm",
      reason: "manual",
      hashPrefix: "01234567",
      cursor: "eyJ2IjoxLCJwYWdlIjoxfQ",
      limit: "25",
    });
    expect(push.list).toHaveBeenCalledWith({
      tenantId: TENANT,
      platform: "fcm",
      reason: "manual",
      hashPrefix: "01234567",
      cursor: "eyJ2IjoxLCJwYWdlIjoxfQ",
      limit: 25,
    });
  });

  it("keeps a raw token out of argv and binds add/removal receipts", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const push = resource();
    const token = "fcm-device-token-with-enough-entropy-123";
    const tokenFile = file("token", token);
    await pushSuppressionAdd({
      tenantUuid: TENANT,
      platform: "fcm",
      tokenFile,
    });
    await pushSuppressionRemove(ID, {
      tenantUuid: TENANT,
      expectedVersion: "1",
      yes: true,
    });
    expect(push.add).toHaveBeenCalledWith(
      { device_token: token, platform: "fcm", reason: "manual" },
      { tenantId: TENANT },
    );
    expect(push.remove).toHaveBeenCalledWith(ID, 1, { tenantId: TENANT });
  });

  it("reads strict private bulk payload files without logging their tokens", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const push = resource();
    const imports = [
      {
        device_token: "fcm-device-token-with-enough-entropy-123",
        platform: "fcm",
      },
      {
        device_token: "web-device-token-with-enough-entropy-456",
        platform: "web",
        reason: "manual",
      },
    ];
    const removals = [
      { id: ID, expected_version: 1 },
      { id: SECOND_ID, expected_version: 4 },
    ];
    await pushSuppressionsBulkImport({
      tenantUuid: TENANT,
      payloadFile: file("imports.json", JSON.stringify({ items: imports })),
    });
    await pushSuppressionsBulkRemove({
      tenantUuid: TENANT,
      payloadFile: file("removals.json", JSON.stringify(removals)),
      yes: true,
    });
    expect(push.bulkImport).toHaveBeenCalledWith(
      imports.map((item) => ({ ...item, reason: "manual" })),
      { tenantId: TENANT },
    );
    expect(push.bulkRemove).toHaveBeenCalledWith(removals, {
      tenantId: TENANT,
    });
    expect(log.mock.calls.flat().join(" ")).not.toContain("device-token");
  });

  it("rejects malformed, duplicate, newline, stale, and unconfirmed input before auth", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const invalidImports = [
      {
        device_token: "fcm-device-token-with-enough-entropy-123",
        platform: "fcm",
      },
      {
        device_token: "fcm-device-token-with-enough-entropy-123",
        platform: "fcm",
      },
    ];
    await pushSuppressionsList({ tenantUuid: TENANT, hashPrefix: "0123456" });
    await pushSuppressionsList({ tenantUuid: TENANT, cursor: "bad.cursor" });
    await pushSuppressionAdd({
      tenantUuid: TENANT,
      platform: "apns",
      tokenFile: file("newline-token", "apns-token-with-enough-entropy\n"),
    });
    await pushSuppressionRemove(ID, {
      tenantUuid: TENANT,
      expectedVersion: "01",
      yes: true,
    });
    await pushSuppressionRemove(ID, {
      tenantUuid: TENANT,
      expectedVersion: "1",
    });
    await pushSuppressionsBulkImport({
      tenantUuid: TENANT,
      payloadFile: file("duplicates.json", JSON.stringify(invalidImports)),
    });
    await pushSuppressionsBulkRemove({
      tenantUuid: TENANT,
      payloadFile: file("remove.json", "[]"),
    });
    expect(createClient).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it("documents five exact-admin commands without accepting token argv", () => {
    const readme = readFileSync(
      new URL("../README.md", import.meta.url),
      "utf8",
    );
    const joined = readme.replace(/\\\n[ \t]*/gu, " ");
    const commands = [
      ...joined.matchAll(/^postwave push suppressions .+$/gmu),
    ].map((match) => match[0]);

    expect(commands).toHaveLength(5);
    expect(
      commands.some((line) =>
        line.startsWith("postwave push suppressions list "),
      ),
    ).toBe(true);
    expect(
      commands.find((line) =>
        line.startsWith("postwave push suppressions add "),
      ),
    ).toContain("--token-file ./customer-push-token.secret");
    expect(
      commands.find((line) =>
        line.startsWith("postwave push suppressions remove "),
      ),
    ).toContain("--expected-version 3 --yes");
    expect(
      commands.find((line) =>
        line.startsWith("postwave push suppressions bulk-import "),
      ),
    ).toContain("--payload-file ./customer-push-holds.private.json");
    expect(
      commands.find((line) =>
        line.startsWith("postwave push suppressions bulk-remove "),
      ),
    ).toContain("--payload-file ./reviewed-push-removals.json --yes");
    for (const command of commands) {
      expect(command).not.toMatch(/--(?:device-)?token(?:[ =]|$)/u);
    }

    const normalized = readme.replace(/\s+/gu, " ");
    expect(normalized).toContain("Exact-admin tenant-customer push authority");
    expect(normalized).toContain("not operator Expo-device management");
    expect(normalized).toContain("Raw tokens are never accepted in argv");
    expect(normalized).toContain(
      "never accepted in argv or echoed in command output",
    );
    expect(normalized).toContain("compare-and-swap guard");
    expect(normalized).toContain("stillSuppressed");
    expect(normalized).toContain("HOLD / NO-GO");
    expect(normalized).toContain("automatic provider feedback");
    expect(normalized).toContain("Web is registry-only");
  });
});
