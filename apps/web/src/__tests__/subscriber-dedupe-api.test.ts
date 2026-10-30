// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  applyMerge,
  duplicatePairMatchesSelection,
  listScanPairs,
  parseSelectedDuplicatePairIds,
  previewMerge,
  selectedDuplicateReviewPath,
  startDuplicateScan,
  type MergeTarget,
} from "@/lib/subscriber-dedupe-api";

afterEach(() => {
  vi.unstubAllGlobals();
});

const scanId = "11111111-1111-4111-8111-111111111111";
const primaryId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const duplicateId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const now = "2026-08-29T08:00:00Z";
const fingerprint = `sha256:${"a".repeat(64)}`;

const target: MergeTarget = {
  scanId,
  primaryId,
  duplicateId,
  primaryUpdatedAt: "2026-08-01T00:00:00Z",
  duplicateUpdatedAt: "2026-08-02T00:00:00Z",
};

const scan = {
  scan_id: scanId,
  status: "complete",
  subscriber_count: 2,
  candidate_count: 1,
  created_at: now,
  completed_at: now,
  expires_at: "2026-08-30T08:00:00Z",
  complete: true,
};

function mergeResponse(dryRun: boolean) {
  return {
    primary_id: primaryId,
    duplicate_id: duplicateId,
    dry_run: dryRun,
    plan: {
      tags: [],
      custom_fields: {},
      status: "enabled",
      gdpr_permissions: [],
      conflicts: [],
      preserved_on_duplicate: [],
    },
    events_moved: 0,
    suppressions_moved: 0,
    loser_soft_deleted: !dryRun,
    primary_updated_at: now,
    duplicate_updated_at: now,
    plan_fingerprint: fingerprint,
  };
}

describe("subscriber dedupe api", () => {
  it("hands selected review off with only two validated opaque ids", () => {
    const path = selectedDuplicateReviewPath([primaryId, duplicateId]);
    const selected = new URL(path, "https://web.example.test").searchParams.get(
      "selected",
    );
    expect(parseSelectedDuplicatePairIds(selected)).toEqual([
      primaryId,
      duplicateId,
    ]);
    expect(path).not.toContain("@");
    expect(
      duplicatePairMatchesSelection(
        { primary_id: duplicateId, duplicate_id: primaryId },
        [primaryId, duplicateId],
      ),
    ).toBe(true);
    expect(parseSelectedDuplicatePairIds(`${primaryId},${primaryId}`)).toBeNull();
    expect(() => selectedDuplicateReviewPath([primaryId, "not-a-uuid"])).toThrow(
      "invalid response",
    );
  });

  it("starts an online-only scan and validates its identity", async () => {
    const fetchMock = vi.fn(async () => Response.json(scan));
    vi.stubGlobal("fetch", fetchMock);
    await startDuplicateScan({ idempotencyKey: "scan-request-1" });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe(
      "http://localhost:8080/api/v1/subscribers/duplicate-scans",
    );
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("Idempotency-Key")).toBe(
      "scan-request-1",
    );
  });

  it("pages only the requested immutable scan", async () => {
    const page = { scan, pairs: [], count: 0, complete: true };
    const fetchMock = vi.fn(async () => Response.json(page));
    vi.stubGlobal("fetch", fetchMock);
    await listScanPairs(scanId, { cursor: "40", limit: 50 });
    const [url] = fetchMock.mock.calls[0] as unknown as [string];
    expect(url).toBe(
      `http://localhost:8080/api/v1/subscribers/duplicate-scans/${scanId}/pairs?cursor=40&limit=50`,
    );
  });

  it("previews online with dry_run=true and no mutation identity", async () => {
    const fetchMock = vi.fn(async () => Response.json(mergeResponse(true)));
    vi.stubGlobal("fetch", fetchMock);
    await previewMerge(target);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("http://localhost:8080/api/v1/merge/apply");
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("Idempotency-Key")).toBeNull();
    expect(JSON.parse(init.body as string)).toMatchObject({
      primary_id: target.primaryId,
      duplicate_id: target.duplicateId,
      scan_id: target.scanId,
      expected_primary_updated_at: target.primaryUpdatedAt,
      expected_duplicate_updated_at: target.duplicateUpdatedAt,
      dry_run: true,
    });
  });

  it("applies only the fingerprinted reviewed plan with a stable mutation identity", async () => {
    const fetchMock = vi.fn(async () => Response.json(mergeResponse(false)));
    vi.stubGlobal("fetch", fetchMock);
    await applyMerge(target, fingerprint, {
      idempotencyKey: "merge-apply-1",
    });
    const init = (
      fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    )[1];
    const body = JSON.parse(init.body as string);
    expect(body.dry_run).toBe(false);
    expect(body.expected_plan_fingerprint).toBe(fingerprint);
    expect(new Headers(init.headers).get("Idempotency-Key")).toBe(
      "merge-apply-1",
    );
  });

  it("fails closed on a response for a different survivor", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({ ...mergeResponse(true), primary_id: duplicateId }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await expect(previewMerge(target)).rejects.toThrow("invalid response");
  });
});
