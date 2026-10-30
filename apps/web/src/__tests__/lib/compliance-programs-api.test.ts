// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));

vi.mock("@/lib/api", () => ({ api: mocks }));

import {
  attestComplianceProgram,
  getComplianceProgram,
  listComplianceEvents,
  listCompliancePrograms,
  normalizeComplianceEvents,
  normalizeCompliancePrograms,
  revokeComplianceProgram,
} from "@/lib/compliance-programs-api";

const REVISION = "2026-08-30T10:00:00Z";
const NEXT_REVISION = "2026-08-30T10:01:00Z";
const DIGEST = "a".repeat(64);

function hipaa() {
  return {
    framework: "hipaa",
    status: "unsupported",
    notes: "No BAA is offered and PHI workloads are prohibited.",
  };
}

function soc2(overrides: Record<string, unknown> = {}) {
  return {
    framework: "soc2",
    status: "attested",
    signedByEmail: "owner@example.com",
    signerName: "Legal",
    documentPath: "s3://private/evidence.pdf",
    documentSha256: DIGEST,
    notes: "Reviewed",
    attestedAt: "2026-08-29T10:00:00Z",
    renewalAt: "2027-08-29T10:00:00Z",
    updatedAt: REVISION,
    ...overrides,
  };
}

function event(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    framework: "soc2",
    eventType: "attested",
    signedByEmail: "owner@example.com",
    documentSha256: DIGEST,
    at: REVISION,
    ...overrides,
  };
}

beforeEach(() => vi.clearAllMocks());

describe("compliance programme browser contract", () => {
  it("parses bounded programme evidence and preserves the explicit HIPAA refusal", () => {
    expect(
      normalizeCompliancePrograms({ programs: [hipaa(), soc2()] }),
    ).toEqual([
      expect.objectContaining({ framework: "hipaa", status: "unsupported" }),
      expect.objectContaining({
        framework: "soc2",
        status: "attested",
        documentSha256: DIGEST,
        updatedAt: REVISION,
      }),
    ]);
  });

  it.each([
    ["HIPAA support claim", { programs: [{ ...hipaa(), status: "attested" }] }],
    ["omitted HIPAA refusal", { programs: [soc2()] }],
    ["duplicate framework", { programs: [hipaa(), hipaa()] }],
    [
      "missing stored revision",
      { programs: [hipaa(), soc2({ updatedAt: undefined })] },
    ],
    [
      "malformed digest",
      { programs: [hipaa(), soc2({ documentSha256: "abc" })] },
    ],
  ])("fails closed on %s", (_label, response) => {
    expect(() => normalizeCompliancePrograms(response)).toThrow();
  });

  it("binds detail and a deterministic, bounded ledger to the selected framework", async () => {
    mocks.get.mockResolvedValueOnce(soc2()).mockResolvedValueOnce({
      events: [event()],
      hasMore: false,
      limit: 100,
      nextCursor: null,
    });
    const signal = new AbortController().signal;
    await expect(
      getComplianceProgram("soc2", { signal, fresh: true }),
    ).resolves.toMatchObject({ framework: "soc2", updatedAt: REVISION });
    await expect(
      listComplianceEvents("soc2", {
        signal,
        fresh: true,
        cursor: "eyJpZCI6MX0",
      }),
    ).resolves.toMatchObject({
      hasMore: false,
      limit: 100,
      nextCursor: null,
    });
    expect(mocks.get).toHaveBeenNthCalledWith(
      1,
      "/api/v1/compliance/programs/soc2",
      { signal, requireOnline: true, maxAttempts: 1 },
    );
    expect(mocks.get).toHaveBeenNthCalledWith(
      2,
      "/api/v1/compliance/programs/soc2/events?cursor=eyJpZCI6MX0",
      { signal, requireOnline: true, maxAttempts: 1 },
    );

    expect(() =>
      normalizeComplianceEvents(
        {
          events: [event({ framework: "gdpr" })],
          hasMore: false,
          limit: 100,
          nextCursor: null,
        },
        "soc2",
      ),
    ).toThrow(/different framework/u);
    expect(() =>
      normalizeComplianceEvents(
        {
          events: [event(), event()],
          hasMore: false,
          limit: 100,
          nextCursor: null,
        },
        "soc2",
      ),
    ).toThrow(/duplicate/u);
    expect(() =>
      normalizeComplianceEvents(
        {
          events: [event()],
          hasMore: true,
          limit: 100,
          nextCursor: null,
        },
        "soc2",
      ),
    ).toThrow(/inconsistent/u);
    await expect(
      listComplianceEvents("soc2", { cursor: " forged cursor " }),
    ).rejects.toThrow(/cursor is malformed/u);
  });

  it("normalizes an online-only attestation and requires an exact mutation receipt", async () => {
    mocks.post.mockResolvedValue({
      ok: true,
      framework: "soc2",
      updatedAt: NEXT_REVISION,
    });
    await expect(
      attestComplianceProgram("soc2", {
        signedByEmail: " owner@example.com ",
        signerName: " Legal ",
        documentPath: " s3://private/evidence.pdf ",
        documentSha256: DIGEST.toUpperCase(),
        notes: " Reviewed ",
        renewalAt: "2027-08-30T00:00:00Z",
        expectedUpdatedAt: REVISION,
      }),
    ).resolves.toEqual({
      ok: true,
      framework: "soc2",
      updatedAt: NEXT_REVISION,
    });
    expect(mocks.post).toHaveBeenCalledWith(
      "/api/v1/compliance/programs/soc2/attest",
      {
        signedByEmail: "owner@example.com",
        signerName: "Legal",
        documentPath: "s3://private/evidence.pdf",
        documentSha256: DIGEST,
        notes: "Reviewed",
        renewalAt: "2027-08-30T00:00:00Z",
        expectedUpdatedAt: REVISION,
      },
      { requireOnline: true, maxAttempts: 1 },
    );

    mocks.post.mockResolvedValue({
      ok: true,
      framework: "gdpr",
      updatedAt: NEXT_REVISION,
    });
    await expect(
      attestComplianceProgram("soc2", { signedByEmail: "owner@example.com" }),
    ).rejects.toThrow(/different framework/u);

    await expect(
      attestComplianceProgram("soc2", {
        signedByEmail: "owner@example.com",
        signerName: "é".repeat(101),
      }),
    ).rejects.toThrow(/UTF-8 bytes/u);
  });

  it("requires the loaded revision and bounds revocation reasons", async () => {
    mocks.post.mockResolvedValue({ ok: true, updatedAt: NEXT_REVISION });
    await expect(
      revokeComplianceProgram("soc2", {
        reason: " Evidence expired ",
        expectedUpdatedAt: REVISION,
      }),
    ).resolves.toEqual({ ok: true, updatedAt: NEXT_REVISION });
    expect(mocks.post).toHaveBeenCalledWith(
      "/api/v1/compliance/programs/soc2/revoke",
      { reason: "Evidence expired", expectedUpdatedAt: REVISION },
      { requireOnline: true, maxAttempts: 1 },
    );
    await expect(
      revokeComplianceProgram("soc2", {
        reason: "x".repeat(2001),
        expectedUpdatedAt: REVISION,
      }),
    ).rejects.toThrow(/2,000/u);
  });

  it("requests list state without silently converting malformed payloads to empty", async () => {
    const signal = new AbortController().signal;
    mocks.get.mockResolvedValue({ programs: "not-an-array" });
    await expect(listCompliancePrograms({ signal })).rejects.toThrow(
      /malformed/u,
    );
    expect(mocks.get).toHaveBeenCalledWith("/api/v1/compliance/programs", {
      signal,
    });
  });
});
