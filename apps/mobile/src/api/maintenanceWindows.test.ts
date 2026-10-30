/** Transport seam for the maintenance-window verbs. */
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  cancelMaintenanceWindow,
  createMaintenanceWindow,
  listMaintenanceWindows,
  setMaintenanceWindowStatus,
} from "./maintenanceWindows";

const { rawRequest } = vi.hoisted(() => ({ rawRequest: vi.fn() }));
vi.mock("./request", () => ({ rawRequest }));

beforeEach(() => rawRequest.mockReset());

describe("listMaintenanceWindows", () => {
  it("GETs the list and normalizes {windows}", async () => {
    rawRequest.mockResolvedValue({
      data: {
        windows: [
          {
            id: "w1",
            tenant_id: "t",
            title: "Failover",
            components: ["api"],
            starts_at: "2099-01-01T00:00:00Z",
            ends_at: "2099-01-01T01:00:00Z",
            status: "scheduled",
          },
        ],
      },
      error: null,
    });
    const res = await listMaintenanceWindows();
    expect(rawRequest).toHaveBeenCalledWith("GET", "/api/v1/maintenance-windows");
    expect(res.data?.map((w) => w.id)).toEqual(["w1"]);
  });

  it("passes a 403 through so the card can hide", async () => {
    const error = { status: 403, message: "forbidden" };
    rawRequest.mockResolvedValue({ data: null, error });
    expect(await listMaintenanceWindows()).toEqual({ data: null, error });
  });
});

describe("the write verbs", () => {
  it("POSTs the create body verbatim", async () => {
    rawRequest.mockResolvedValue({ data: { id: "w9" }, error: null });
    const body = {
      title: "Failover",
      description: "",
      components: ["api"],
      starts_at: "2099-01-01T00:00:00.000Z",
      ends_at: "2099-01-01T01:00:00.000Z",
    };
    const res = await createMaintenanceWindow(body);
    expect(rawRequest).toHaveBeenCalledWith(
      "POST",
      "/api/v1/maintenance-windows",
      body,
    );
    expect(res.data?.id).toBe("w9");
  });

  it("PATCHes a status transition and DELETEs to cancel, with the id encoded", async () => {
    rawRequest.mockResolvedValue({ data: { updated: true }, error: null });
    await setMaintenanceWindowStatus("a/b", "in_progress");
    expect(rawRequest).toHaveBeenCalledWith(
      "PATCH",
      "/api/v1/maintenance-windows/a%2Fb",
      { status: "in_progress" },
    );
    rawRequest.mockResolvedValue({ data: { cancelled: true }, error: null });
    await cancelMaintenanceWindow("w1");
    expect(rawRequest).toHaveBeenLastCalledWith(
      "DELETE",
      "/api/v1/maintenance-windows/w1",
    );
  });
});
