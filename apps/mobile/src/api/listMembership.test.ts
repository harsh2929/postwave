/**
 * The list-side membership transport, at the seam (rawRequest mocked — the
 * listsManage idiom): the right verb hits the right path with the body the Go
 * handler reads, and a failed call reaches the error state instead of
 * resolving like a success.
 *
 * The candidate search is the interesting one: it is TWO reads, and a failure
 * on the membership leg must fail the whole search. Rendering candidates whose
 * membership could not be checked is exactly the silent "add someone who is
 * already on the list" the pairing exists to prevent.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  addListMembers,
  fetchListCandidates,
  removeListMember,
} from "./listMembership";

const { rawRequest } = vi.hoisted(() => ({ rawRequest: vi.fn() }));
vi.mock("@/api/request", () => ({ rawRequest }));

const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_B = "22222222-2222-4222-8222-222222222222";

beforeEach(() => rawRequest.mockReset());

const paths = (): string[] =>
  rawRequest.mock.calls.map((call: unknown[]) => String(call[1]));

/**
 * Answer per leg. Written as a BLOCK-bodied implementation on purpose: an
 * expression-bodied `async (m, url) => …` handed to `mockImplementation` in
 * this harness receives `undefined` for its second argument, which reads as a
 * bug in the module under test and is not one.
 */
function routeByPath(answers: {
  subscribers: unknown;
  members: unknown;
}): (method: string, url: string) => Promise<unknown> {
  return async (_method: string, url: string) => {
    if (String(url).startsWith("/api/v1/subscribers")) return answers.subscribers;
    return answers.members;
  };
}

describe("fetchListCandidates", () => {
  it("asks nothing at all without a query — the subscriber table is PII", async () => {
    const result = await fetchListCandidates("7", "   ");
    expect(rawRequest).not.toHaveBeenCalled();
    expect(result).toEqual({ items: [], total: 0, memberIds: new Set() });
  });

  it("searches subscribers AND checks the same query against this list", async () => {
    rawRequest.mockImplementation(
      routeByPath({
        subscribers: {
          data: { items: [{ id: UUID_A, email: "a@example.com" }], total: 1 },
          error: null,
        },
        members: {
          data: { items: [{ id: UUID_B, email: "b@example.com" }] },
          error: null,
        },
      }),
    );
    const result = await fetchListCandidates("7", " dana ");

    expect(paths()).toEqual([
      "/api/v1/subscribers?q=dana&page=1&per_page=25",
      "/api/v1/lists/7/subscribers?query=dana&page=1&per_page=200",
    ]);
    expect(result.items.map((row) => row.email)).toEqual(["a@example.com"]);
    // The list leg's ids are the membership answer, not more candidates.
    expect([...result.memberIds]).toEqual([UUID_B]);
  });

  it("encodes a uuid list id into the membership path", async () => {
    rawRequest.mockResolvedValue({ data: { items: [] }, error: null });
    await fetchListCandidates("a b/c", "dana");
    expect(paths()[1]).toBe(
      "/api/v1/lists/a%20b%2Fc/subscribers?query=dana&page=1&per_page=200",
    );
  });

  it("fails the whole search when the membership check fails", async () => {
    rawRequest.mockImplementation(
      routeByPath({
        subscribers: {
          data: { items: [{ id: UUID_A, email: "a@example.com" }] },
          error: null,
        },
        members: { data: null, error: { message: "list not found", status: 404 } },
      }),
    );
    await expect(fetchListCandidates("7", "dana")).rejects.toMatchObject({
      status: 404,
      message: "list not found",
    });
  });

  it("fails when the candidate search itself fails", async () => {
    rawRequest.mockImplementation(
      routeByPath({
        subscribers: { data: null, error: { message: "forbidden", status: 403 } },
        members: { data: { items: [] }, error: null },
      }),
    );
    await expect(fetchListCandidates("7", "dana")).rejects.toMatchObject({ status: 403 });
  });
});

describe("addListMembers", () => {
  it("POSTs subscriber_ids to the list's membership path", async () => {
    rawRequest.mockResolvedValue({ data: { added: 2, skipped: 1 }, error: null });
    const result = await addListMembers("7", [UUID_A, UUID_B]);
    expect(rawRequest).toHaveBeenCalledWith("POST", "/api/v1/lists/7/subscribers", {
      subscriber_ids: [UUID_A, UUID_B],
    });
    expect(result).toEqual({ added: 2, skipped: 1 });
  });

  it("returns null counts rather than inventing them", async () => {
    rawRequest.mockResolvedValue({ data: {}, error: null });
    await expect(addListMembers("7", [UUID_A])).resolves.toBeNull();
  });

  it("surfaces a refused add instead of resolving like a success", async () => {
    rawRequest.mockResolvedValue({
      data: null,
      error: { message: "forbidden", status: 403 },
    });
    await expect(addListMembers("7", [UUID_A])).rejects.toMatchObject({ status: 403 });
  });
});

describe("removeListMember", () => {
  it("DELETEs the member's own path under the list", async () => {
    rawRequest.mockResolvedValue({ data: null, error: null });
    await removeListMember("7", UUID_A);
    expect(rawRequest).toHaveBeenCalledWith(
      "DELETE",
      `/api/v1/lists/7/subscribers/${UUID_A}`,
    );
  });

  it("surfaces a failed remove instead of resolving", async () => {
    rawRequest.mockResolvedValue({
      data: null,
      error: { message: "forbidden", status: 403 },
    });
    await expect(removeListMember("7", UUID_A)).rejects.toMatchObject({ status: 403 });
  });
});
