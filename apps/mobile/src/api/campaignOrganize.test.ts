/**
 * The transport seam for the folder CREATE — the one organising write whose
 * ANSWER is consumed immediately (its id is what the follow-up move files
 * into). A parser test cannot see this seam: `rawRequest` resolves to the
 * `{data, error}` ENVELOPE, and handing that envelope to `parseCampaignFolder`
 * would yield null on every real response while body-driven tests stay green
 * (the exact failure src/api/audienceDestinations.test.ts documents).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { rawRequest } = vi.hoisted(() => ({ rawRequest: vi.fn() }));
// The whole module is stubbed: importActual would pull request.ts → sdkClient →
// react-native, which cannot be parsed in the node environment.
// checkedApiResult is reproduced faithfully (reject on envelope error, tagging
// the status; pass through otherwise).
vi.mock("./request", () => ({
  rawRequest,
  checkedApiResult: async (
    promise: Promise<{ error: { message: string; status?: number } | null }>,
  ) => {
    const result = await promise;
    if (result.error) {
      const err = new Error(result.error.message) as Error & {
        status?: number | undefined;
      };
      err.status = result.error.status;
      throw err;
    }
    return result;
  },
}));

const { createCampaignFolder } = await import("./campaignOrganize");

beforeEach(() => {
  rawRequest.mockReset();
});

describe("createCampaignFolder", () => {
  it("POSTs {name} to /campaigns/folders and unwraps the envelope", async () => {
    // The exact 201 body the handler writes: the bare Folder row
    // (campaigns/folders.go CreateFolder → writeJSON(folder)).
    rawRequest.mockResolvedValue({
      data: { id: "f1", name: "Newsletters", campaign_count: 3 },
      error: null,
    });
    const folder = await createCampaignFolder("Newsletters");
    expect(rawRequest).toHaveBeenCalledWith(
      "POST",
      "/api/v1/campaigns/folders",
      { name: "Newsletters" },
    );
    expect(folder).toEqual({ id: "f1", name: "Newsletters", campaignCount: 3 });
  });

  it("surfaces an envelope error as a throw, not an empty folder", async () => {
    rawRequest.mockResolvedValue({
      data: null,
      error: { message: "name is required", status: 422 },
    });
    await expect(createCampaignFolder("")).rejects.toThrow("name is required");
  });

  it("refuses a 201 whose body carries no usable folder", async () => {
    // There is no id to file the selection into — half-succeeding silently
    // would leave the move pointed at nothing.
    rawRequest.mockResolvedValue({ data: { ok: true }, error: null });
    await expect(createCampaignFolder("Newsletters")).rejects.toThrow(
      /couldn't be read/i,
    );
  });
});
