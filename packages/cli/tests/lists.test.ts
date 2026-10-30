// SPDX-License-Identifier: MIT

import { afterEach, describe, expect, it, vi } from "vitest";
import { createClient } from "../src/lib/client.js";
import {
  listCreateInputFromOptions,
  listsCreate,
  listsDelete,
} from "../src/commands/lists.js";

vi.mock("../src/lib/client.js", () => ({
  createClient: vi.fn(),
}));

function makeLists() {
  return {
    create: vi.fn(async () => ({ id: 7, name: "Newsletter" })),
    delete: vi.fn(async () => ({ ok: true })),
  };
}

function mockClient() {
  const lists = makeLists();
  vi.mocked(createClient).mockReturnValue({ lists } as unknown as ReturnType<
    typeof createClient
  >);
  return lists;
}

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

describe("list payload builder", () => {
  it("builds a create input with optin, type, tags", () => {
    expect(
      listCreateInputFromOptions({
        name: "Newsletter",
        type: "public",
        optin: "double",
        tags: "weekly, product",
        description: "Main list",
      }),
    ).toEqual({
      name: "Newsletter",
      type: "public",
      optin: "double",
      tags: ["weekly", "product"],
      description: "Main list",
    });
  });

  it("requires --name", () => {
    expect(() => listCreateInputFromOptions({})).toThrow(/--name/);
  });

  it("rejects invalid --type", () => {
    expect(() =>
      listCreateInputFromOptions({ name: "x", type: "bogus" }),
    ).toThrow(/--type/);
  });

  it("rejects invalid --optin", () => {
    expect(() =>
      listCreateInputFromOptions({ name: "x", optin: "triple" }),
    ).toThrow(/--optin/);
  });
});

describe("lists create / delete commands", () => {
  it("create calls the SDK", async () => {
    const lists = mockClient();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    await listsCreate({ name: "Newsletter" });
    expect(lists.create).toHaveBeenCalledWith({ name: "Newsletter" });
  });

  it("delete requires --yes confirmation", async () => {
    const lists = mockClient();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await listsDelete("7", {});
    expect(lists.delete).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);

    process.exitCode = undefined;
    await listsDelete("7", { yes: true });
    expect(lists.delete).toHaveBeenCalledWith("7");
  });

  it("delete requires an id", async () => {
    const lists = mockClient();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await listsDelete(undefined, { yes: true });
    expect(lists.delete).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });
});
