import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const selectionAsync = vi.fn(async () => {});
const notificationAsync = vi.fn(async (_type: number) => {});
const impactAsync = vi.fn(async (_style: number) => {});

vi.mock("expo-haptics", () => ({
  selectionAsync: (...args: unknown[]) => selectionAsync(...(args as [])),
  notificationAsync: (type: number) => notificationAsync(type),
  impactAsync: (style: number) => impactAsync(style),
  NotificationFeedbackType: { Success: 1, Warning: 2, Error: 3 },
  ImpactFeedbackStyle: { Light: 0, Medium: 1, Heavy: 2, Rigid: 3, Soft: 4 },
}));

// eslint-disable-next-line import/first
import { error, impact, success, tap, warning } from "./haptics";

describe("mobile haptics wrapper", () => {
  beforeEach(() => {
    selectionAsync.mockClear();
    notificationAsync.mockClear();
    impactAsync.mockClear();
  });

  afterEach(() => {
    selectionAsync.mockReset();
    notificationAsync.mockReset();
    impactAsync.mockReset();
    selectionAsync.mockResolvedValue(undefined);
    notificationAsync.mockResolvedValue(undefined);
    impactAsync.mockResolvedValue(undefined);
  });

  it("tap() triggers a selection tick", () => {
    tap();
    expect(selectionAsync).toHaveBeenCalledTimes(1);
  });

  it("success/warning/error map to the matching notification types", () => {
    success();
    warning();
    error();
    expect(notificationAsync).toHaveBeenNthCalledWith(1, 1);
    expect(notificationAsync).toHaveBeenNthCalledWith(2, 2);
    expect(notificationAsync).toHaveBeenNthCalledWith(3, 3);
  });

  it("impact() defaults to a medium style", () => {
    impact();
    expect(impactAsync).toHaveBeenCalledWith(1);
  });

  it("swallows a rejected native call (unsupported device) without throwing", async () => {
    selectionAsync.mockRejectedValueOnce(new Error("no haptics motor"));
    expect(() => tap()).not.toThrow();
    // let the swallowed rejection settle without surfacing
    await Promise.resolve();
  });

  it("swallows a synchronous throw from the native module", () => {
    notificationAsync.mockImplementationOnce(() => {
      throw new Error("native module missing");
    });
    expect(() => success()).not.toThrow();
  });
});
