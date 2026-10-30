// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  delete: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  ApiError: class ApiError extends Error {},
  api: mocks,
}));

import {
  addAssetTags,
  deleteAsset,
  deleteAssetFolder,
  getAsset,
  getAssetTags,
  listAssets,
  moveAsset,
  removeAssetTag,
  renameAssetFolder,
  uploadAsset,
  updateAssetAltText,
} from "@/lib/assets-api";
import {
  createCollection,
  createSavedBlock,
  deleteCollection,
  deleteSavedBlock,
  getCollection,
  getSavedBlock,
  listCollections,
  listSavedBlocks,
  updateCollection,
  updateSavedBlock,
} from "@/lib/content-library-api";

const tenant = "00000000-0000-4000-8000-000000000001";
const assetId = "00000000-0000-4000-8000-000000000002";
const blockId = "00000000-0000-4000-8000-000000000003";
const collectionId = "00000000-0000-4000-8000-000000000004";

const asset = {
  id: assetId,
  tenantId: tenant,
  filename: "hero.png",
  mime: "image/png",
  bytes: 68,
  width: 1,
  height: 1,
  url: "https://cdn.example.test/hero.png",
  createdAt: "2026-08-29T10:00:00Z",
  updatedAt: "2026-08-29T10:01:00Z",
  version: 7,
  altText: "Hero",
  referencesCount: 0,
  lastUsedAt: null,
  folderId: null,
};

const savedBlock = {
  id: blockId,
  tenant_id: tenant,
  name: "Hero block",
  kind: "block",
  body_html: "<p>Hello</p>",
  body_json: { type: "paragraph" },
  created_at: "2026-08-29T10:00:00Z",
  updated_at: "2026-08-29T10:01:00Z",
  version: 3,
};

const collection = {
  id: collectionId,
  tenant_id: tenant,
  name: "Offers",
  collection_type: "content",
  source_type: "manual",
  data: [],
  row_count: 2,
  created_at: "2026-08-29T10:00:00Z",
  updated_at: "2026-08-29T10:01:00Z",
  version: 5,
};

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
});

describe("asset library exact-version transport", () => {
  it("decodes positive versions and binds rows to the requested workspace", async () => {
    mocks.get.mockResolvedValue({
      items: [asset],
      counts: { all: 1, recent: 1, inUse: 0, unused: 0, large: 0 },
      nextCursor: null,
    });

    await expect(
      listAssets({ tenantId: tenant, limit: 20 }),
    ).resolves.toMatchObject({
      items: [{ id: assetId, version: 7, tenantId: tenant }],
    });

    mocks.get.mockResolvedValueOnce({
      items: [{ ...asset, tenantId: "00000000-0000-4000-8000-000000000099" }],
      counts: { all: 1, recent: 1, inUse: 0, unused: 0, large: 0 },
      nextCursor: null,
    });
    await expect(listAssets({ tenantId: tenant })).rejects.toThrow(
      /workspace mismatch/i,
    );
  });

  it("sends create-only zero and exact delete version as online single-attempt writes", async () => {
    mocks.post.mockResolvedValue(asset);
    await uploadAsset({
      tenantId: tenant,
      filename: "hero.png",
      mime: "image/png",
      contentBase64: "iVBORw==",
      idempotencyKey: "upload-key",
    });
    expect(mocks.post).toHaveBeenCalledWith(
      "/api/v1/assets",
      expect.objectContaining({ expected_version: 0 }),
      expect.objectContaining({
        idempotencyKey: "upload-key",
        requireOnline: true,
        maxAttempts: 1,
      }),
    );

    mocks.delete.mockResolvedValue({ ok: true, id: assetId, version: 8 });
    await deleteAsset({
      tenantId: tenant,
      id: assetId,
      expectedVersion: 7,
      force: true,
      idempotencyKey: "delete-key",
    });
    expect(mocks.delete).toHaveBeenCalledWith(
      `/api/v1/assets/${assetId}`,
      expect.objectContaining({
        body: { expected_version: 7, force: true },
        requireOnline: true,
        maxAttempts: 1,
      }),
    );
  });

  it("uses the validated asset or folder id as exactly one path segment", async () => {
    const stop = new Error("stop after path capture");
    mocks.get.mockRejectedValue(stop);
    mocks.patch.mockRejectedValue(stop);
    mocks.post.mockRejectedValue(stop);
    mocks.delete.mockRejectedValue(stop);

    await expect(getAsset({ tenantId: tenant, id: assetId })).rejects.toBe(
      stop,
    );
    await expect(getAssetTags({ tenantId: tenant, id: assetId })).rejects.toBe(
      stop,
    );
    await expect(
      updateAssetAltText({
        tenantId: tenant,
        id: assetId,
        expectedVersion: 7,
        altText: "Hero",
        idempotencyKey: "alt-text",
      }),
    ).rejects.toBe(stop);
    await expect(
      renameAssetFolder({
        tenantId: tenant,
        id: collectionId,
        expectedVersion: 5,
        name: "Campaign art",
        idempotencyKey: "folder-rename",
      }),
    ).rejects.toBe(stop);
    await expect(
      deleteAssetFolder({
        tenantId: tenant,
        id: collectionId,
        expectedVersion: 5,
        idempotencyKey: "folder-delete",
      }),
    ).rejects.toBe(stop);
    await expect(
      moveAsset({
        tenantId: tenant,
        id: assetId,
        expectedVersion: 7,
        folderId: collectionId,
        idempotencyKey: "asset-move",
      }),
    ).rejects.toBe(stop);
    await expect(
      addAssetTags({
        tenantId: tenant,
        id: assetId,
        expectedVersion: 7,
        tags: ["hero"],
        idempotencyKey: "asset-tag-add",
      }),
    ).rejects.toBe(stop);
    await expect(
      removeAssetTag({
        tenantId: tenant,
        id: assetId,
        expectedVersion: 7,
        tag: "hero/banner",
        idempotencyKey: "asset-tag-remove",
      }),
    ).rejects.toBe(stop);

    expect(mocks.get.mock.calls.map(([path]) => path)).toEqual([
      `/api/v1/assets/${assetId}`,
      `/api/v1/assets/${assetId}/tags`,
    ]);
    expect(mocks.patch.mock.calls.map(([path]) => path)).toEqual([
      `/api/v1/assets/${assetId}`,
      `/api/v1/assets/folders/${collectionId}`,
      `/api/v1/assets/${assetId}/folder`,
    ]);
    expect(mocks.post).toHaveBeenCalledWith(
      `/api/v1/assets/${assetId}/tags`,
      expect.any(Object),
      expect.any(Object),
    );
    expect(mocks.delete.mock.calls.map(([path]) => path)).toEqual([
      `/api/v1/assets/folders/${collectionId}`,
      `/api/v1/assets/${assetId}/tags/hero%2Fbanner`,
    ]);

    mocks.get.mockClear();
    await expect(
      getAsset({ tenantId: tenant, id: `${assetId}/blob` }),
    ).rejects.toThrow(/asset id is invalid/i);
    expect(mocks.get).not.toHaveBeenCalled();
  });
});

describe("content-library exact-version transport", () => {
  it("decodes paged saved blocks and collection row_count rather than a fabricated item_count", async () => {
    mocks.get
      .mockResolvedValueOnce({ items: [savedBlock], total: 1 })
      .mockResolvedValueOnce({ items: [collection], total: 1 });

    await expect(listSavedBlocks({ tenantId: tenant })).resolves.toMatchObject({
      total: 1,
      items: [{ id: blockId, version: 3 }],
    });
    await expect(listCollections({ tenantId: tenant })).resolves.toMatchObject({
      total: 1,
      items: [{ id: collectionId, rowCount: 2, version: 5 }],
    });
  });

  it("canonicalises structured data and carries create-only/exact versions", async () => {
    mocks.post.mockResolvedValue({
      ...collection,
      data: [{ code: "A" }],
      row_count: 1,
      version: 1,
    });
    await createCollection({
      tenantId: tenant,
      name: "Offers",
      collectionType: "content",
      sourceType: "manual",
      data: [{ code: "A" }],
      idempotencyKey: "collection-create",
    });
    expect(mocks.post).toHaveBeenCalledWith(
      "/api/v1/collections",
      expect.objectContaining({ expected_version: 0, data: [{ code: "A" }] }),
      expect.objectContaining({ requireOnline: true, maxAttempts: 1 }),
    );

    mocks.delete
      .mockResolvedValueOnce({ ok: true, id: blockId, version: 4 })
      .mockResolvedValueOnce({ ok: true, id: collectionId, version: 6 });
    await deleteSavedBlock({
      tenantId: tenant,
      id: blockId,
      expectedVersion: 3,
      idempotencyKey: "block-delete",
    });
    await deleteCollection({
      tenantId: tenant,
      id: collectionId,
      expectedVersion: 5,
      idempotencyKey: "collection-delete",
    });
    expect(mocks.delete.mock.calls[0]?.[1]).toMatchObject({
      body: { expected_version: 3 },
      requireOnline: true,
      maxAttempts: 1,
    });
    expect(mocks.delete.mock.calls[1]?.[1]).toMatchObject({
      body: { expected_version: 5 },
      requireOnline: true,
      maxAttempts: 1,
    });
  });

  it("uses each validated saved-block or collection id as one path segment", async () => {
    const stop = new Error("stop after path capture");
    mocks.get.mockRejectedValue(stop);
    mocks.patch.mockRejectedValue(stop);

    await expect(getSavedBlock({ tenantId: tenant, id: blockId })).rejects.toBe(
      stop,
    );
    await expect(
      getCollection({ tenantId: tenant, id: collectionId }),
    ).rejects.toBe(stop);
    await expect(
      updateSavedBlock({
        tenantId: tenant,
        id: blockId,
        expectedVersion: 3,
        name: "Hero block",
        kind: "block",
        bodyHtml: "<p>Hello</p>",
        bodyJson: { type: "paragraph" },
        idempotencyKey: "block-update",
      }),
    ).rejects.toBe(stop);
    await expect(
      updateCollection({
        tenantId: tenant,
        id: collectionId,
        expectedVersion: 5,
        name: "Offers",
        collectionType: "content",
        sourceType: "manual",
        data: [],
        idempotencyKey: "collection-update",
      }),
    ).rejects.toBe(stop);

    expect(mocks.get.mock.calls.map(([path]) => path)).toEqual([
      `/api/v1/blocks/saved/${blockId}`,
      `/api/v1/collections/${collectionId}`,
    ]);
    expect(mocks.patch.mock.calls.map(([path]) => path)).toEqual([
      `/api/v1/blocks/saved/${blockId}`,
      `/api/v1/collections/${collectionId}`,
    ]);

    mocks.get.mockClear();
    await expect(
      getSavedBlock({ tenantId: tenant, id: `${blockId}/other` }),
    ).rejects.toThrow(/saved-block id is invalid/i);
    expect(mocks.get).not.toHaveBeenCalled();
  });
});

describe("library RFC3339 timestamps", () => {
  it.each(["+05:30", "-07:00", "Z"])(
    "accepts Go timestamps with %s timezone",
    async (offset) => {
      const created = `2026-10-24T10:00:00.123456${offset}`;
      const updated = `2026-10-24T10:01:00.123456${offset}`;
      mocks.get.mockResolvedValue({
        asset: { ...asset, createdAt: created, updatedAt: updated },
        usage: [],
      });
      await expect(
        getAsset({ tenantId: tenant, id: assetId }),
      ).resolves.toMatchObject({ asset: { createdAt: created } });
      mocks.post.mockResolvedValueOnce({
        ...savedBlock,
        created_at: created,
        updated_at: updated,
      });
      await expect(
        createSavedBlock({
          tenantId: tenant,
          name: "QA block",
          kind: "block",
          bodyHtml: "<p>QA</p>",
          bodyJson: {},
          idempotencyKey: "timezone-block",
        }),
      ).resolves.toMatchObject({ createdAt: created });
      mocks.post.mockResolvedValueOnce({
        ...collection,
        created_at: created,
        updated_at: updated,
      });
      await expect(
        createCollection({
          tenantId: tenant,
          name: "QA collection",
          collectionType: "content",
          sourceType: "manual",
          data: [],
          idempotencyKey: "timezone-collection",
        }),
      ).resolves.toMatchObject({ createdAt: created });
    },
  );

  it.each([
    "2026-10-24T10:00:00",
    "2026-10-24T10:00:00+24:00",
    "2026-10-24T10:00:00+05:60",
  ])(
    "rejects a timestamp without a valid absolute timezone: %s",
    async (value) => {
      mocks.get.mockResolvedValueOnce({ ...savedBlock, created_at: value });
      await expect(
        getSavedBlock({ tenantId: tenant, id: blockId }),
      ).rejects.toThrow(/created time is invalid/i);
      mocks.get.mockResolvedValueOnce({
        asset: { ...asset, createdAt: value },
        usage: [],
      });
      await expect(getAsset({ tenantId: tenant, id: assetId })).rejects.toThrow(
        /created time is invalid/i,
      );
    },
  );
});
