import { describe, expect, it } from "vitest";

import {
  ASSET_UPLOAD_CONCURRENCY,
  ASSET_UPLOAD_MAX_FILES,
  decodeAsset,
  decodeAssetCounts,
  decodeAssetDetail,
  decodeAssetFolders,
  decodeAssetList,
  decodeAssetReferenceConflict,
  decodeAssetTagCounts,
  decodeAssetUsage,
  decodeMutationAck,
  decodeTags,
  isSupportedAssetFile,
  publicAssetDeliveryUrl,
} from "../../lib/asset-runtime";

const validAsset = {
  id: "00000000-0000-4000-8000-000000000002",
  tenantId: "00000000-0000-4000-8000-000000000001",
  filename: "hero.png",
  mime: "image/png",
  bytes: 128,
  width: 1200,
  height: 600,
  url: "/api/v1/assets/asset-1/blob",
  createdAt: "2026-07-22T00:00:00.000Z",
  updatedAt: "2026-07-22T00:00:00.000Z",
  version: 1,
  altText: "Hero",
  referencesCount: 0,
  tags: ["hero"],
  folderId: null,
};

const validCounts = { all: 1, recent: 1, inUse: 0, unused: 1, large: 0 };
const validNextCursor = "4fd4d527-f6e8-4ec9-a7f7-75a5d5be87e0";
const validUsage = [{ kind: "campaign", id: "campaign-1", name: "Launch" }];

describe("asset runtime decoders", () => {
  it("accepts fully verified list, count, detail, usage, folder, and tag envelopes", () => {
    expect(decodeAsset(validAsset)).toEqual({ ok: true, value: validAsset });
    expect(decodeAssetCounts(validCounts)).toEqual({
      ok: true,
      value: validCounts,
    });
    expect(
      decodeAssetList({
        items: [validAsset],
        counts: validCounts,
        nextCursor: validNextCursor,
      }),
    ).toEqual({
      ok: true,
      value: {
        items: [validAsset],
        counts: validCounts,
        nextCursor: validNextCursor,
      },
    });
    expect(decodeAssetDetail({ asset: validAsset, usage: validUsage })).toEqual(
      {
        ok: true,
        value: { asset: validAsset, usage: validUsage },
      },
    );
    expect(decodeAssetUsage({ usage: validUsage }).ok).toBe(true);
    expect(
      decodeAssetReferenceConflict({ count: 1, usage: validUsage }).ok,
    ).toBe(true);
    expect(
      decodeAssetFolders({
        folders: [
          {
            id: "00000000-0000-4000-8000-000000000003",
            tenantId: "00000000-0000-4000-8000-000000000001",
            name: "Heroes",
            createdAt: "2026-07-22T00:00:00.000Z",
            updatedAt: "2026-07-22T00:00:00.000Z",
            version: 1,
            assetCount: 1,
          },
        ],
      }).ok,
    ).toBe(true);
    expect(decodeAssetTagCounts({ tags: [{ tag: "hero", count: 1 }] }).ok).toBe(
      true,
    );
    expect(decodeTags({ tags: ["hero"], version: 1 })).toEqual({
      ok: true,
      value: ["hero"],
    });
    expect(
      decodeMutationAck({
        ok: true,
        id: "00000000-0000-4000-8000-000000000002",
        version: 2,
      }),
    ).toEqual({ ok: true, value: true });
  });

  it.each([
    ["asset", () => decodeAsset({ ...validAsset, bytes: "128" })],
    ["counts", () => decodeAssetCounts({ ...validCounts, unused: -1 })],
    [
      "list item",
      () => decodeAssetList({ items: [{ ...validAsset, id: "" }] }),
    ],
    ["missing list", () => decodeAssetList({ counts: validCounts })],
    [
      "missing counts",
      () => decodeAssetList({ items: [] }, { requireCounts: true }),
    ],
    [
      "missing cursor",
      () =>
        decodeAssetList(
          { items: [], counts: validCounts },
          { requireCursor: true },
        ),
    ],
    ["cursor", () => decodeAssetList({ items: [], nextCursor: "NOT-A-UUID" })],
    [
      "detail",
      () =>
        decodeAssetDetail({ asset: validAsset, usage: [{ kind: "email" }] }),
    ],
    ["usage", () => decodeAssetUsage({ usage: "none" })],
    [
      "conflict",
      () => decodeAssetReferenceConflict({ count: 2, usage: validUsage }),
    ],
    [
      "folders",
      () => decodeAssetFolders({ folders: [{ id: "x", name: "X" }] }),
    ],
    [
      "tag counts",
      () => decodeAssetTagCounts({ tags: [{ tag: "hero", count: NaN }] }),
    ],
    ["tags", () => decodeTags({ tags: [""] })],
    ["ack", () => decodeMutationAck({ ok: false })],
  ])("fails closed for malformed successful %s responses", (_label, decode) => {
    expect(decode().ok).toBe(false);
  });

  it("enforces the renderer upload format and queue policy", () => {
    expect(ASSET_UPLOAD_CONCURRENCY).toBe(3);
    expect(ASSET_UPLOAD_MAX_FILES).toBe(20);
    expect(
      isSupportedAssetFile({ name: "photo.JPG", type: "image/jpeg" }),
    ).toBe(true);
    expect(
      isSupportedAssetFile({ name: "vector.svg", type: "image/svg+xml" }),
    ).toBe(false);
    expect(
      isSupportedAssetFile({ name: "fake.png", type: "image/svg+xml" }),
    ).toBe(false);
  });

  it("only describes genuinely public delivery URLs as copyable", () => {
    expect(publicAssetDeliveryUrl("https://cdn.example.test/hero.png")).toBe(
      "https://cdn.example.test/hero.png",
    );
    expect(publicAssetDeliveryUrl("/api/v1/assets/asset-1/blob")).toBeNull();
    expect(
      publicAssetDeliveryUrl(
        "https://api.example.test/api/v1/assets/asset-1/blob",
      ),
    ).toBeNull();
    for (const unsafe of [
      "http://cdn.example.test/hero.png",
      "https://user:secret@cdn.example.test/hero.png",
      "https://cdn.example.test/hero.png?token=secret",
      "https://cdn.example.test/hero.png#fragment",
      "https://localhost/hero.png",
      "https://127.0.0.1/hero.png",
      "https://10.0.0.8/hero.png",
      "https://192.168.1.8/hero.png",
      "https://[::1]/hero.png",
      "https://[fd00::1]/hero.png",
    ]) {
      expect(publicAssetDeliveryUrl(unsafe), unsafe).toBeNull();
    }
  });
});
