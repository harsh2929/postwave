/**
 * The transport seam for the from-name suggestions.
 *
 * `src/lib/fromNamePicker.test.ts` pins the parse rules against a BODY, and the
 * render test pins the chips against parsed ROWS. Between them sits the one
 * line that decides whether either ever runs against real data: `rawRequest`
 * resolves to the `{data, error}` ENVELOPE, and handing that envelope to
 * `parseFromNameSuggestions` instead of `res.data` returns `[]` for every real
 * response — the strip simply never appears, which is indistinguishable from a
 * workspace with too little history. Nothing else in the tree would catch it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { rawRequest } = vi.hoisted(() => ({ rawRequest: vi.fn() }));
// Stubbed whole: importActual would pull request.ts → sdkClient →
// react-native, which the node environment cannot parse. checkedApiResult is
// reproduced faithfully (reject on an envelope error, pass through otherwise).
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

import { fetchFromNameSuggestions } from "./fromNamePicker";

beforeEach(() => {
  rawRequest.mockReset();
});

describe("fetchFromNameSuggestions", () => {
  it("GETs the picker route and unwraps the envelope before parsing", async () => {
    rawRequest.mockResolvedValue({
      data: {
        window_days: 180,
        min_campaigns: 2,
        count: 2,
        from_names: [
          { from_name: "Jane from Acme", campaigns_using: 6, open_rate: 0.41, rank: 1 },
          { from_name: "Acme Marketing", campaigns_using: 11, open_rate: 0.29, rank: 2 },
        ],
      },
      error: null,
    });
    const rows = await fetchFromNameSuggestions();
    expect(rawRequest).toHaveBeenCalledWith("GET", "/api/v1/from-name-picker");
    expect(rows.map((row) => row.fromName)).toEqual([
      "Jane from Acme",
      "Acme Marketing",
    ]);
    expect(rows[0]?.openRate).toBe(0.41);
  });

  it("answers [] — never placeholders — for a workspace under the server's floor", async () => {
    rawRequest.mockResolvedValue({
      data: { window_days: 180, min_campaigns: 2, count: 0, from_names: [] },
      error: null,
    });
    await expect(fetchFromNameSuggestions()).resolves.toEqual([]);
  });

  it("rejects on a transport failure rather than reporting an empty history", async () => {
    rawRequest.mockResolvedValue({
      data: null,
      error: { status: 403, message: "insufficient_role" },
    });
    await expect(fetchFromNameSuggestions()).rejects.toThrow("insufficient_role");
  });
});
