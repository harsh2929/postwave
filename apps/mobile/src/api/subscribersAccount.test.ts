/**
 * The account-link transport: the FK PATCH is conditional on the profile
 * revision the operator saw and refuses to run without one; unlink sends an
 * explicit null (absence would mean "leave it alone").
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { rawRequest } = vi.hoisted(() => ({ rawRequest: vi.fn() }));
vi.mock("@/api/request", () => ({ rawRequest }));

// eslint-disable-next-line import/first
import {
  createAccount,
  listAccounts,
  setSubscriberAccount,
} from "./subscribersAccount";

beforeEach(() => rawRequest.mockReset());

describe("account-link transport", () => {
  it("PATCH sends {account_id} with If-Match", async () => {
    rawRequest.mockResolvedValue({ data: { id: "sub-1" }, error: null });
    await setSubscriberAccount("sub-1", "acc-2", '"v4"');
    expect(rawRequest.mock.calls[0]).toEqual([
      "PATCH",
      "/api/v1/subscribers/sub-1/account",
      { account_id: "acc-2" },
      { headers: { "If-Match": '"v4"' } },
    ]);
  });

  it("unlink is an EXPLICIT null, never an omitted key", async () => {
    rawRequest.mockResolvedValue({ data: { id: "sub-1" }, error: null });
    await setSubscriberAccount("sub-1", null, '"v4"');
    const body = rawRequest.mock.calls[0]![2] as Record<string, unknown>;
    expect("account_id" in body).toBe(true);
    expect(body.account_id).toBeNull();
  });

  it("refuses the PATCH without a revision token", async () => {
    await expect(setSubscriberAccount("sub-1", "acc-2", "")).rejects.toThrow(
      /can't be changed safely/,
    );
    expect(rawRequest).not.toHaveBeenCalled();
  });

  it("create returns the new id and refuses an idless response", async () => {
    rawRequest.mockResolvedValue({ data: { id: "acc-9" }, error: null });
    await expect(createAccount({ name: "Acme" })).resolves.toEqual({
      id: "acc-9",
    });
    rawRequest.mockResolvedValue({ data: {}, error: null });
    await expect(createAccount({ name: "Acme" })).rejects.toThrow(
      /did not return the new account's id/,
    );
  });

  it("list unwraps the envelope and errors throw", async () => {
    rawRequest.mockResolvedValue({
      data: null,
      error: { message: "nope", status: 403 },
    });
    await expect(listAccounts()).rejects.toMatchObject({ status: 403 });
  });
});
