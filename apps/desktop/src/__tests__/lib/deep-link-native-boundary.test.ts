import { describe, expect, it, vi } from "vitest";

import contractFixtures from "../../../auth-link-v1-contract-fixtures.json";

const native = vi.hoisted(() => ({
  eventCallback: undefined as
    | ((event: { payload: unknown }) => void)
    | undefined,
  order: [] as string[],
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(
    async (
      name: string,
      callback: (event: { payload: unknown }) => void,
    ): Promise<() => void> => {
      native.order.push(`listen:${name}`);
      native.eventCallback = callback;
      return () => undefined;
    },
  ),
}));

vi.mock("../../lib/tauri", () => ({
  isTauri: () => true,
  tauriApi: {
    takePendingDeepLinks: async (): Promise<unknown[]> => {
      native.order.push("drain");
      return [
        "https://attacker.example/",
        "moosewave://user@approval/abc",
        "moosewave://unknown/abc",
        `moosewave://campaign/${"a".repeat(8 * 1024)}`,
        { kind: "opened", url: "moosewave://campaign/cmp_1" },
        {
          kind: "opened",
          url: contractFixtures.cases[0]?.native_url,
        },
        {
          kind: "rejected",
          reason: "unsupported_version",
          flow: "magic",
        },
      ];
    },
  },
}));

import { onDeepLink, onDeepLinkRejection } from "../../lib/deep-link";

describe("native deep-link renderer handshake", () => {
  it("listens before draining and ignores forged native event envelopes", async () => {
    const received: string[] = [];
    const rejected: Array<{ reason: string; flow: string | null }> = [];
    const unsubscribe = onDeepLink((url) => received.push(url));
    const unsubscribeRejections = onDeepLinkRejection((rejection) =>
      rejected.push(rejection),
    );

    await vi.waitFor(() => {
      expect(native.order).toEqual(["listen:deep-link://opened", "drain"]);
    });
    expect(received).toEqual([
      "moosewave://campaign/cmp_1",
      contractFixtures.cases[0]?.native_url,
    ]);
    expect(rejected).toEqual([
      { reason: "unsupported_version", flow: "magic" },
    ]);

    native.eventCallback?.({
      payload: [
        null,
        "javascript:alert(1)",
        "moosewave://approval:443/abc",
        { kind: "opened", url: "moosewave://sequence/seq_1" },
        {
          kind: "opened",
          url: "moosewave://auth/magic?token=legacy-token",
        },
        { kind: "rejected", reason: "wrong_device", flow: "magic" },
        { kind: "rejected", reason: "made_up", flow: "magic" },
        { kind: "rejected", reason: "invalid_link", flow: "other" },
      ],
    });
    expect(received).toEqual([
      "moosewave://campaign/cmp_1",
      contractFixtures.cases[0]?.native_url,
      "moosewave://sequence/seq_1",
    ]);
    expect(rejected).toEqual([
      { reason: "unsupported_version", flow: "magic" },
      { reason: "wrong_device", flow: "magic" },
    ]);

    native.eventCallback?.({ payload: "moosewave://settings" });
    expect(received).toHaveLength(3);
    unsubscribe();
    unsubscribeRejections();
  });
});
