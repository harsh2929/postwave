/**
 * The federation transport: both writes echo the LIST's subscriber_version
 * as If-Match and refuse to run without it; envelope errors THROW.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { rawRequest } = vi.hoisted(() => ({ rawRequest: vi.fn() }));
vi.mock("@/api/request", () => ({ rawRequest }));

// eslint-disable-next-line import/first
import {
  createFederatedLink,
  deleteFederatedLink,
  listFederatedLinks,
} from "./subscribersFederation";

beforeEach(() => rawRequest.mockReset());

describe("federated-links transport", () => {
  it("GET unwraps the envelope", async () => {
    rawRequest.mockResolvedValue({ data: { items: [] }, error: null });
    await expect(listFederatedLinks("sub-1")).resolves.toEqual({ items: [] });
    expect(rawRequest).toHaveBeenCalledWith(
      "GET",
      "/api/v1/subscribers/sub-1/federated-links",
    );
  });

  it("POST carries the body and the If-Match token", async () => {
    rawRequest.mockResolvedValue({ data: { id: "fl-1" }, error: null });
    await createFederatedLink("sub-1", '"v9"', {
      parent_tenant_id: "t",
      master_subscriber_id: "m",
      match_type: "manual",
    });
    expect(rawRequest.mock.calls[0]).toEqual([
      "POST",
      "/api/v1/subscribers/sub-1/federated-links",
      { parent_tenant_id: "t", master_subscriber_id: "m", match_type: "manual" },
      { headers: { "If-Match": '"v9"' } },
    ]);
  });

  it("DELETE addresses the master id and carries If-Match", async () => {
    rawRequest.mockResolvedValue({ data: { deleted: true }, error: null });
    await deleteFederatedLink("sub-1", "master 2", '"v9"');
    expect(rawRequest.mock.calls[0]).toEqual([
      "DELETE",
      "/api/v1/subscribers/sub-1/federated-links/master%202",
      undefined,
      { headers: { "If-Match": '"v9"' } },
    ]);
  });

  it("both writes refuse to run without the token", async () => {
    await expect(
      createFederatedLink("sub-1", "", { parent_tenant_id: "t" }),
    ).rejects.toThrow(/revision is missing/);
    await expect(deleteFederatedLink("sub-1", "m", "")).rejects.toThrow(
      /revision is missing/,
    );
    expect(rawRequest).not.toHaveBeenCalled();
  });
});
