import { beforeEach, describe, expect, it, vi } from "vitest";

import { fetchSmsCreditBalance } from "./spendControls";

const { rawRequest } = vi.hoisted(() => ({ rawRequest: vi.fn() }));
vi.mock("./request", () => ({ rawRequest }));

beforeEach(() => rawRequest.mockReset());

describe("mobile SMS financial ledger hold", () => {
  it("returns the stable hold locally with zero network request", async () => {
    await expect(fetchSmsCreditBalance()).rejects.toMatchObject({
      status: 503,
      code: "sms_financial_ledger_release_held",
    });
    expect(rawRequest).not.toHaveBeenCalled();
  });
});
