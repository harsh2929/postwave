import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  delete: vi.fn(),
}));
vi.mock("@/lib/api", () => ({ api: mocks }));
import {
  deleteAudienceList,
  listAudienceLists,
  listTags,
  mutateTagMembership,
  updateAudienceList,
  updateTag,
  type TagRecord,
} from "@/lib/audience-admin-api";
const id = "00000000-0000-4000-8000-000000000001";
const tag: TagRecord = {
  id,
  name: "Customer",
  color: "slate",
  description: "",
  group_id: "",
  created_at: "2026-08-30T00:00:00Z",
  updated_at: "2026-08-30T00:00:00Z",
  pii: false,
  version: 2,
  etag: `\"tag:${id}:v2\"`,
  subscriber_count: 3,
};
beforeEach(() => Object.values(mocks).forEach((x) => x.mockReset()));
describe("audience administration contracts", () => {
  it("decodes the production list envelope and rejects duplicate identities", async () => {
    mocks.get.mockResolvedValue({
      data: {
        results: [
          {
            id: 1,
            name: "Newsletter",
            type: "private",
            optin: "double",
            tags: [],
            description: "",
          },
        ],
      },
    });
    await expect(listAudienceLists()).resolves.toHaveLength(1);
    mocks.get.mockResolvedValue({
      data: {
        results: [
          { id: 1, name: "A" },
          { id: 1, name: "B" },
        ],
      },
    });
    await expect(listAudienceLists()).rejects.toThrow(/duplicate/i);
  });
  it("requires a positive tag version and its matching strong ETag", async () => {
    mocks.get.mockResolvedValue({ items: [tag] });
    await expect(listTags()).resolves.toEqual([tag]);
    mocks.get.mockResolvedValue({
      items: [{ ...tag, etag: `\"tag:${id}:v3\"` }],
    });
    await expect(listTags()).rejects.toThrow(/mismatched version/i);
  });
  it("sends If-Match and online-only idempotency for rename", async () => {
    mocks.patch.mockResolvedValue({
      ...tag,
      name: "Buyer",
      version: 3,
      etag: `\"tag:${id}:v3\"`,
    });
    await updateTag(tag, { name: "Buyer" }, "write-1");
    expect(mocks.patch).toHaveBeenCalledWith(
      `/api/v1/tags/${id}`,
      { name: "Buyer" },
      expect.objectContaining({
        headers: { "If-Match": tag.etag },
        requireOnline: true,
        idempotencyKey: "write-1",
      }),
    );
  });
  it("rejects membership receipts that do not account for every requested id", async () => {
    mocks.post.mockResolvedValue({ applied: 1, skipped: 0 });
    await expect(
      mutateTagMembership(
        id,
        [id, "00000000-0000-4000-8000-000000000002"],
        "apply",
        "write-2",
      ),
    ).rejects.toThrow(/receipt/i);
  });

  it("uses one canonical encoded segment for list mutations", async () => {
    mocks.patch.mockResolvedValue(undefined);
    mocks.delete.mockResolvedValue(undefined);

    await updateAudienceList(42, { name: "Readers" }, "list-update");
    await deleteAudienceList(42, "list-delete");

    expect(mocks.patch).toHaveBeenCalledWith(
      "/api/v1/lists/42",
      { name: "Readers" },
      expect.any(Object),
    );
    expect(mocks.delete).toHaveBeenCalledWith(
      "/api/v1/lists/42",
      expect.any(Object),
    );

    mocks.patch.mockClear();
    await expect(
      updateAudienceList("42/admin" as unknown as number, {}, "invalid-list"),
    ).rejects.toThrow(/list id/i);
    expect(mocks.patch).not.toHaveBeenCalled();
  });
});
