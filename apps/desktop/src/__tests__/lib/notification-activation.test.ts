// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  navigateResource: vi.fn(),
  navigateSection: vi.fn(),
  listen: vi.fn(),
  takePending: vi.fn(),
  vaultGet: vi.fn(),
  vaultSet: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));
vi.mock("../../lib/desktop-router", () => ({
  navigateDesktopSectionResource: mocks.navigateResource,
  navigateDesktopSection: mocks.navigateSection,
}));
vi.mock("../../lib/secure-vault", () => ({
  vaultGetJSON: mocks.vaultGet,
  vaultSetJSON: mocks.vaultSet,
}));
vi.mock("../../lib/tauri", () => ({
  isTauri: () => true,
  tauriApi: {
    takePendingNotificationActivations: mocks.takePending,
  },
}));

import {
  processNativeNotificationActivationForTests,
  resetNotificationActivationForTests,
  synchronizeNativeNotificationActivations,
} from "../../lib/notification-activation";
import {
  configureNotificationCenterIdentity,
  getNotificationCenterSnapshot,
  ingestNotification,
  resetNotificationCenterForTests,
} from "../../lib/notification-center";

beforeEach(async () => {
  resetNotificationCenterForTests();
  resetNotificationActivationForTests();
  mocks.navigateResource.mockReset();
  mocks.navigateSection.mockReset();
  mocks.listen.mockReset().mockResolvedValue(() => undefined);
  mocks.takePending.mockReset().mockResolvedValue([]);
  mocks.vaultGet.mockReset().mockResolvedValue(null);
  mocks.vaultSet.mockReset().mockResolvedValue(undefined);
  await configureNotificationCenterIdentity("user-1", "tenant-1");
});

async function addCampaign(): Promise<string> {
  const result = await ingestNotification({
    topic: "campaign.sent",
    title: "Campaign sent",
    body: "A campaign finished sending. Open Moosewave for delivery details.",
    occurredAt: "2026-07-16T10:00:00Z",
    eventIdentity: "campaign-42:2026-07-16T10:00:00Z",
    deepLink: "moosewave://campaign/campaign-42",
  });
  if (!result.id) throw new Error("notification was not admitted");
  return result.id;
}

describe("native notification activation boundary", () => {
  it("resolves an opaque id only through the active encrypted center", async () => {
    const id = await addCampaign();

    expect(
      processNativeNotificationActivationForTests({ activationId: id }),
    ).toBe(true);
    expect(mocks.navigateResource).toHaveBeenCalledWith(
      "campaigns",
      "campaign-42",
      { source: "deep-link" },
    );
    expect(getNotificationCenterSnapshot().unreadCount).toBe(0);
  });

  it("is idempotent across the native live-event and queue-drain pair", async () => {
    const id = await addCampaign();
    expect(
      processNativeNotificationActivationForTests({ activationId: id }),
    ).toBe(true);
    expect(
      processNativeNotificationActivationForTests({ activationId: id }),
    ).toBe(false);
    expect(mocks.navigateResource).toHaveBeenCalledTimes(1);
  });

  it("contains a navigation fault without consuming the retained retry", async () => {
    const id = await addCampaign();
    mocks.navigateResource.mockImplementationOnce(() => {
      throw new Error("router temporarily unavailable");
    });

    expect(
      processNativeNotificationActivationForTests({ activationId: id }),
    ).toBe(false);
    expect(
      processNativeNotificationActivationForTests({ activationId: id }),
    ).toBe(true);
    expect(mocks.navigateResource).toHaveBeenCalledTimes(2);
  });

  it("attaches the live listener before draining retained cold-start state", async () => {
    const id = await addCampaign();
    const callOrder: string[] = [];
    const liveHandlers: Array<(event: { payload: unknown }) => void> = [];
    mocks.listen.mockImplementation(
      async (
        _event: string,
        handler: (event: { payload: unknown }) => void,
      ) => {
        callOrder.push("listen");
        liveHandlers.push(handler);
        return () => undefined;
      },
    );
    mocks.takePending.mockImplementation(async () => {
      callOrder.push("drain");
      return [{ activationId: id }];
    });

    await synchronizeNativeNotificationActivations();
    expect(callOrder).toEqual(["listen", "drain"]);
    expect(mocks.navigateResource).toHaveBeenCalledTimes(1);

    // Rust emits live and retains until drain. Seeing both representations of
    // the same click must not route twice.
    liveHandlers[0]?.({ payload: { activationId: id } });
    expect(mocks.navigateResource).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed, resource-shaped and cross-identity activations", async () => {
    const oldIdentityId = await addCampaign();
    expect(
      processNativeNotificationActivationForTests({
        activationId: "campaign-42",
      }),
    ).toBe(false);
    expect(
      processNativeNotificationActivationForTests({
        activationId: "0123456789ABCDEf",
      }),
    ).toBe(false);

    await configureNotificationCenterIdentity("user-2", "tenant-2");
    expect(
      processNativeNotificationActivationForTests({
        activationId: oldIdentityId,
      }),
    ).toBe(false);
    expect(mocks.navigateResource).not.toHaveBeenCalled();
    expect(mocks.navigateSection).not.toHaveBeenCalled();
  });
});
