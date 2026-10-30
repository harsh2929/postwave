import { beforeEach, describe, expect, it, vi } from "vitest";

import { ReducedMotionModal } from "./ReducedMotionModal";

const motionPreference = vi.hoisted(() => ({ reduced: false }));

vi.mock("react-native", () => ({ Modal: "Modal" }));
vi.mock("react-native-reanimated", () => ({
  useReducedMotion: () => motionPreference.reduced,
}));

function resolvedAnimation(
  requested?: "none" | "slide" | "fade",
): unknown {
  const props = requested === undefined ? {} : { animationType: requested };
  return ReducedMotionModal(props).props.animationType;
}

describe("ReducedMotionModal", () => {
  beforeEach(() => {
    motionPreference.reduced = false;
  });

  it.each(["fade", "slide"] as const)(
    "preserves the requested %s transition when motion is allowed",
    (animationType) => {
      expect(resolvedAnimation(animationType)).toBe(animationType);
    },
  );

  it.each(["fade", "slide"] as const)(
    "resolves %s to none when the OS asks to reduce motion",
    (animationType) => {
      motionPreference.reduced = true;
      expect(resolvedAnimation(animationType)).toBe("none");
    },
  );

  it("defaults to no native transition", () => {
    expect(resolvedAnimation()).toBe("none");
  });
});
