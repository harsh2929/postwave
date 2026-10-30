/**
 * revokeThisDeviceTrust — every way retiring THIS phone's remembered-device
 * credential can end, and the single word each ending is reported as.
 *
 * Two callers read the outcome differently. The lock screen's sign-out escape
 * hatch ignores it (a failure must not strand someone on a lock they came to
 * escape). Settings uses it to tell the user, after turning the app lock off,
 * that the phone can still skip a second factor. So the contract under test is
 * not "it doesn't throw" — it is which of "revoked" / "none" / "failed" comes
 * back, and which requests went out on the way.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const listTrustedDevices = vi.hoisted(() => vi.fn());
const revokeTrustedDevice = vi.hoisted(() => vi.fn());

vi.mock("@/api/trustedDevices", () => ({
  listTrustedDevices,
  revokeTrustedDevice,
}));

// eslint-disable-next-line import/first
import { revokeThisDeviceTrust } from "./trustedDeviceRevoke";

const BASE_URL = "https://api.example.test";

function listed(devices: { id: string; current: boolean }[]) {
  return {
    data: {
      devices: devices.map((device) => ({
        ...device,
        trust_days: 180,
        issued_at: "2026-09-10T09:00:00Z",
        expires_at: "2027-03-09T09:00:00Z",
      })),
      allowed: true,
      allowedDurations: [30, 90, 180],
    },
  };
}

const LAPTOP_AND_PHONE = [
  { id: "trust-laptop", current: false },
  { id: "trust-this-phone", current: true },
];

describe("revokeThisDeviceTrust", () => {
  beforeEach(() => {
    listTrustedDevices.mockReset();
    revokeTrustedDevice.mockReset();
    listTrustedDevices.mockResolvedValue(listed(LAPTOP_AND_PHONE));
    revokeTrustedDevice.mockResolvedValue({ data: { revoked: true } });
  });

  it("answers none, and asks nothing, when no workspace is connected", async () => {
    await expect(revokeThisDeviceTrust(null)).resolves.toBe("none");
    await expect(revokeThisDeviceTrust(undefined)).resolves.toBe("none");
    await expect(revokeThisDeviceTrust("")).resolves.toBe("none");
    expect(listTrustedDevices).not.toHaveBeenCalled();
    expect(revokeTrustedDevice).not.toHaveBeenCalled();
  });

  it("answers none when this phone was never remembered", async () => {
    listTrustedDevices.mockResolvedValue(
      listed([{ id: "trust-laptop", current: false }]),
    );

    await expect(revokeThisDeviceTrust(BASE_URL)).resolves.toBe("none");
    expect(listTrustedDevices).toHaveBeenCalledWith(BASE_URL);
    expect(revokeTrustedDevice).not.toHaveBeenCalled();
  });

  it("revokes only the record marked current", async () => {
    await expect(revokeThisDeviceTrust(BASE_URL)).resolves.toBe("revoked");
    expect(revokeTrustedDevice).toHaveBeenCalledTimes(1);
    expect(revokeTrustedDevice).toHaveBeenCalledWith(
      BASE_URL,
      "trust-this-phone",
    );
  });

  it("reads a 404 on the revoke as already gone", async () => {
    // 404 is also the server's answer for an id that is not ours, so the only
    // honest reading is "it is not there any more" — the goal state.
    revokeTrustedDevice.mockResolvedValue({
      error: { status: 404, kind: "http", message: "not found" },
    });

    await expect(revokeThisDeviceTrust(BASE_URL)).resolves.toBe("revoked");
  });

  it("answers failed when the list comes back as an error envelope", async () => {
    listTrustedDevices.mockResolvedValue({
      error: { status: 503, kind: "http", message: "unavailable" },
    });

    await expect(revokeThisDeviceTrust(BASE_URL)).resolves.toBe("failed");
    expect(revokeTrustedDevice).not.toHaveBeenCalled();
  });

  it("answers failed, without rejecting, when the list request throws", async () => {
    listTrustedDevices.mockRejectedValue(new Error("offline"));

    await expect(revokeThisDeviceTrust(BASE_URL)).resolves.toBe("failed");
    expect(revokeTrustedDevice).not.toHaveBeenCalled();
  });

  it("answers failed when the revoke is refused for any reason but 404", async () => {
    for (const status of [401, 403, 500]) {
      revokeTrustedDevice.mockResolvedValueOnce({
        error: { status, kind: "http", message: `HTTP ${status}` },
      });
      await expect(revokeThisDeviceTrust(BASE_URL)).resolves.toBe("failed");
    }
    revokeTrustedDevice.mockResolvedValueOnce({
      error: { kind: "network", message: "Network request failed" },
    });
    await expect(revokeThisDeviceTrust(BASE_URL)).resolves.toBe("failed");
  });

  it("answers failed, without rejecting, when the revoke request throws", async () => {
    revokeTrustedDevice.mockRejectedValue(new Error("socket hang up"));

    await expect(revokeThisDeviceTrust(BASE_URL)).resolves.toBe("failed");
  });
});
