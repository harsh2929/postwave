// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  head: vi.fn(),
}));

vi.mock("@/lib/api", () => ({ api: mocks }));

import {
  authorizeWorkspaceExportDownload,
  createWorkspaceExport,
  getWorkspaceExport,
  listWorkspaceExports,
  parseWorkspaceExport,
} from "@/lib/workspace-exports-api";

const ID = "22222222-2222-4222-8222-222222222222";
const PATH = `/api/v1/exports/${ID}/download`;

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: ID,
    status: "ready",
    include: ["subscribers", "consent"],
    requested_by_email: "owner@example.test",
    bytes_total: 1_024,
    rows_total: 42,
    download_url: PATH,
    download_path: PATH,
    expires_at: "2030-08-30T10:00:00Z",
    error: "",
    created_at: "2026-08-30T10:00:00Z",
    ...overrides,
  };
}

beforeEach(() => vi.clearAllMocks());

describe("workspace exports client", () => {
  it("binds detail reads to one validated, encoded export-id segment", async () => {
    mocks.get.mockResolvedValue(row());

    await expect(getWorkspaceExport(ID)).resolves.toMatchObject({ id: ID });
    expect(mocks.get).toHaveBeenCalledWith(`/api/v1/exports/${ID}`, {
      signal: undefined,
    });

    mocks.get.mockClear();
    await expect(getWorkspaceExport("22222222/other")).rejects.toThrow(
      /canonical UUID/u,
    );
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it("strictly parses a bounded list and never accepts a public object URL", async () => {
    mocks.get.mockResolvedValue({ exports: [row()] });
    await expect(listWorkspaceExports()).resolves.toMatchObject([
      {
        id: ID,
        status: "ready",
        include: ["subscribers", "consent"],
        downloadPath: PATH,
      },
    ]);
    mocks.get.mockResolvedValue({
      exports: [
        row({
          download_path: "https://cdn.example.test/export.zip",
          download_url: "https://cdn.example.test/export.zip",
        }),
      ],
    });
    await expect(listWorkspaceExports()).rejects.toThrow(
      /authenticated export route/u,
    );
  });

  it.each([
    ["unknown status", row({ status: "complete" })],
    ["empty resources", row({ include: [] })],
    ["duplicate resources", row({ include: ["consent", "consent"] })],
    ["unknown resource", row({ include: ["billing_secrets"] })],
    ["unsafe id", row({ id: "../other-tenant" })],
    ["negative size", row({ bytes_total: -1 })],
    ["bad timestamp", row({ expires_at: "tomorrow" })],
    ["early path", row({ status: "running" })],
  ])("fails closed on %s", (_label, payload) => {
    expect(() => parseWorkspaceExport(payload)).toThrow();
  });

  it("queues only an explicit unique supported selection online", async () => {
    const signal = new AbortController().signal;
    mocks.post.mockResolvedValue({
      id: ID,
      status: "queued",
      include: ["subscribers", "consent"],
    });
    await expect(
      createWorkspaceExport(["subscribers", "consent"], { signal }),
    ).resolves.toEqual({
      id: ID,
      status: "queued",
      include: ["subscribers", "consent"],
    });
    expect(mocks.post).toHaveBeenCalledWith(
      "/api/v1/exports",
      { include: ["subscribers", "consent"] },
      { signal, requireOnline: true, maxAttempts: 1 },
    );
    await expect(createWorkspaceExport([])).rejects.toThrow(/at least one/u);
    await expect(
      createWorkspaceExport(["consent", "consent"]),
    ).rejects.toThrow(/duplicate/u);
  });

  it("step-up preflights only the exact authenticated path before navigation", async () => {
    mocks.head.mockResolvedValue(undefined);
    const parsed = parseWorkspaceExport(row());
    await expect(authorizeWorkspaceExportDownload(parsed)).resolves.toBe(PATH);
    expect(mocks.head).toHaveBeenCalledWith(PATH, {
      signal: undefined,
      requireOnline: true,
      maxAttempts: 1,
      cache: "no-store",
    });
    await expect(
      authorizeWorkspaceExportDownload(
        parseWorkspaceExport(
          row({ status: "expired", download_url: "", download_path: "" }),
        ),
      ),
    ).rejects.toThrow(/not ready/u);
  });

  it("reconciles list uniqueness and the 200-row ceiling", async () => {
    mocks.get.mockResolvedValue({ exports: [row(), row()] });
    await expect(listWorkspaceExports()).rejects.toThrow(/duplicate ids/u);
    mocks.get.mockResolvedValue({ exports: Array.from({ length: 201 }, () => row()) });
    await expect(listWorkspaceExports()).rejects.toThrow(/no more than 200/u);
  });
});
