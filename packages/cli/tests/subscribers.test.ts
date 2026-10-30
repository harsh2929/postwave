// SPDX-License-Identifier: MIT

import { afterEach, describe, expect, it, vi } from "vitest";
import { createClient } from "../src/lib/client.js";
import {
  subscriberCreateInputFromOptions,
  subscriberPatchFromOptions,
  subscribersCreate,
  subscribersDelete,
  subscribersImport,
  subscribersUpdate,
} from "../src/commands/subscribers.js";

vi.mock("../src/lib/client.js", () => ({
  createClient: vi.fn(),
}));

// Avoid touching the real filesystem in import tests; the CSV body is irrelevant
// to the behaviors under test (exit code on errored rows, cross-platform filename).
vi.mock("../src/lib/input.js", () => ({
  readTextFileLimited: vi.fn(() => "email\na@example.com\n"),
}));

function subscriberFixture() {
  return {
    id: "sub_1",
    email: "a@example.com",
    status: "enabled",
    consent_timestamp: null,
    custom_fields: {},
    tags: [],
  };
}

// Mirror of the SDK's SubscriberImportCsvResult (not re-exported from the index),
// so the import-result fixtures typecheck without coupling to a deep import path.
interface ImportCsvResult {
  total_rows: number;
  created: number;
  updated: number;
  skipped: number;
  errored: number;
  rows: Array<{
    row_number: number;
    email?: string;
    status: "created" | "updated" | "skipped" | "error";
    error?: string;
  }>;
}

function makeSubscribers() {
  return {
    create: vi.fn(async () => subscriberFixture()),
    update: vi.fn(async () => ({ ...subscriberFixture(), status: "disabled" })),
    delete: vi.fn(async (): Promise<void> => undefined),
    importCsv: vi.fn(
      async (): Promise<ImportCsvResult> => ({
        total_rows: 2,
        created: 2,
        updated: 0,
        skipped: 0,
        errored: 0,
        rows: [],
      }),
    ),
  };
}

function mockClient() {
  const subscribers = makeSubscribers();
  vi.mocked(createClient).mockReturnValue({ subscribers } as unknown as ReturnType<
    typeof createClient
  >);
  return subscribers;
}

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

describe("subscriber payload builders", () => {
  it("builds a create input with email, tags, and custom fields", () => {
    const input = subscriberCreateInputFromOptions({
      email: "a@example.com",
      tags: "vip, beta",
      customFields: '{"plan":"pro"}',
    });
    expect(input).toEqual({
      email: "a@example.com",
      tags: ["vip", "beta"],
      custom_fields: { plan: "pro" },
    });
  });

  it("requires --email on create", () => {
    expect(() => subscriberCreateInputFromOptions({})).toThrow(/--email/);
  });

  it("rejects invalid custom-fields JSON", () => {
    expect(() =>
      subscriberCreateInputFromOptions({ email: "a@example.com", customFields: "{bad" }),
    ).toThrow(/--custom-fields/);
  });

  it("builds a patch with only the provided fields", () => {
    expect(subscriberPatchFromOptions({ status: "disabled" })).toEqual({
      status: "disabled",
    });
    expect(subscriberPatchFromOptions({ tags: "x,y" })).toEqual({ tags: ["x", "y"] });
  });

  it("throws when a patch would be empty", () => {
    expect(() => subscriberPatchFromOptions({})).toThrow(/at least one/i);
  });

  // Finding 4: `--tags ""` (CAC surfaces this as the number 0) must clear tags
  // by sending an empty array, not silently no-op or crash on 0.trim().
  it("clears tags on an explicit empty --tags (CAC number 0)", () => {
    expect(subscriberPatchFromOptions({ tags: 0 })).toEqual({ tags: [] });
  });

  it("clears tags on an explicit empty-string --tags", () => {
    expect(subscriberPatchFromOptions({ tags: "   " })).toEqual({ tags: [] });
  });

  it("leaves tags untouched when the flag is absent", () => {
    expect(() => subscriberPatchFromOptions({ tags: undefined })).toThrow(/at least one/i);
  });
});

describe("subscribers create / update / delete commands", () => {
  it("create calls the SDK and prints the result", async () => {
    const subscribers = mockClient();
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await subscribersCreate({ email: "a@example.com" });
    expect(subscribers.create).toHaveBeenCalledWith({ email: "a@example.com" });
    expect(spy).toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });

  it("create reports validation errors without calling the SDK", async () => {
    const subscribers = mockClient();
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await subscribersCreate({});
    expect(subscribers.create).not.toHaveBeenCalled();
    expect(spy).toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it("update passes id and patch", async () => {
    const subscribers = mockClient();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    await subscribersUpdate("sub_1", { status: "disabled" });
    expect(subscribers.update).toHaveBeenCalledWith("sub_1", { status: "disabled" });
  });

  it("update requires an id", async () => {
    const subscribers = mockClient();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await subscribersUpdate(undefined, { status: "disabled" });
    expect(subscribers.update).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it("delete requires confirmation and calls the SDK with --yes", async () => {
    const subscribers = mockClient();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await subscribersDelete("sub_1", {});
    expect(subscribers.delete).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);

    process.exitCode = undefined;
    await subscribersDelete("sub_1", { yes: true });
    expect(subscribers.delete).toHaveBeenCalledWith("sub_1");
  });
});

describe("subscribers import command", () => {
  it("requires --file", async () => {
    const subscribers = mockClient();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await subscribersImport({});
    expect(subscribers.importCsv).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it("exits 0 when every row imported cleanly", async () => {
    const subscribers = mockClient();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    await subscribersImport({ file: "/tmp/import.csv" });
    expect(subscribers.importCsv).toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });

  // Finding 2: a CSV with malformed rows still returns 200 with errored > 0.
  // The CLI must surface the error count and exit non-zero for automation.
  it("exits non-zero and reports the error count when rows errored", async () => {
    const subscribers = mockClient();
    subscribers.importCsv.mockResolvedValueOnce({
      total_rows: 3,
      created: 2,
      updated: 0,
      skipped: 0,
      errored: 1,
      rows: [
        { row_number: 3, status: "error", error: "invalid email" },
      ],
    });
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await subscribersImport({ file: "/tmp/import.csv" });
    expect(process.exitCode).toBe(1);
    expect(errSpy).toHaveBeenCalled();
    const message = errSpy.mock.calls.map((c) => String(c[0])).join(" ");
    expect(message).toMatch(/1/);
  });

  // Finding 3: a Windows backslash path must be reduced to its basename before
  // it is sent as the X-Postwave-Filename header.
  it("sends a cross-platform basename for backslash (Windows) paths", async () => {
    const subscribers = mockClient();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    await subscribersImport({ file: "C:\\Users\\me\\Downloads\\contacts.csv" });
    expect(subscribers.importCsv).toHaveBeenCalledWith(
      "contacts.csv",
      expect.any(String),
    );
  });

  it("still derives the basename for POSIX paths", async () => {
    const subscribers = mockClient();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    await subscribersImport({ file: "/var/data/contacts.csv" });
    expect(subscribers.importCsv).toHaveBeenCalledWith(
      "contacts.csv",
      expect.any(String),
    );
  });
});
