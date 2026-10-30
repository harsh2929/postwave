import { describe, expect, it, vi } from "vitest";

import { navigateSubscriberDetailRow } from "../../pages/subscribers/SubscribersPageOverlays";

const rows = [
  { id: "subscriber-1", email: "one@example.test" },
  { id: "subscriber-2", email: "two@example.test" },
];

describe("subscriber detail row navigation", () => {
  it("does not move directory focus when lifecycle review cancels", async () => {
    const setFocusedRowIndex = vi.fn();
    const navigate = vi.fn().mockResolvedValue("cancelled");

    await navigateSubscriberDetailRow({
      rows,
      currentIndex: 0,
      delta: 1,
      navigate,
      setFocusedRowIndex,
    });

    expect(navigate).toHaveBeenCalledWith(rows[1]);
    expect(setFocusedRowIndex).not.toHaveBeenCalled();
  });

  it("moves focus only after the exact detail route proceeds", async () => {
    const setFocusedRowIndex = vi.fn();
    await navigateSubscriberDetailRow({
      rows,
      currentIndex: 0,
      delta: 1,
      navigate: vi.fn().mockResolvedValue("proceeded"),
      setFocusedRowIndex,
    });

    expect(setFocusedRowIndex).toHaveBeenCalledWith(1);
  });
});
