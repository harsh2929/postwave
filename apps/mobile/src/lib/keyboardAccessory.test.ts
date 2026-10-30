import { describe, expect, it } from "vitest";

import {
  accessoryIdFor,
  honoursReturnKey,
  needsDoneAccessory,
} from "./keyboardAccessory";

describe("needsDoneAccessory", () => {
  it("is true for every iOS keyboard that has no return key", () => {
    for (const kind of [
      "number-pad",
      "decimal-pad",
      "numeric",
      "phone-pad",
      "ascii-number-pad",
    ]) {
      expect(needsDoneAccessory(kind, "ios")).toBe(true);
    }
  });

  it("is false for keyboards that already have a return key", () => {
    // `numbers-and-punctuation` is a FULL keyboard — a second Done would be
    // noise, and sending-settings uses it for the retry-schedule fields.
    expect(needsDoneAccessory("numbers-and-punctuation", "ios")).toBe(false);
    expect(needsDoneAccessory("default", "ios")).toBe(false);
    expect(needsDoneAccessory("email-address", "ios")).toBe(false);
    expect(needsDoneAccessory("url", "ios")).toBe(false);
    expect(needsDoneAccessory(undefined, "ios")).toBe(false);
  });

  it("is false on Android, where the system back button dismisses the keyboard", () => {
    expect(needsDoneAccessory("number-pad", "android")).toBe(false);
    expect(needsDoneAccessory("decimal-pad", "web")).toBe(false);
  });
});

describe("honoursReturnKey", () => {
  it("reports that returnKeyType is ignored on iOS number pads", () => {
    expect(honoursReturnKey("number-pad", "ios")).toBe(false);
    expect(honoursReturnKey("decimal-pad", "ios")).toBe(false);
  });

  it("reports it honoured everywhere else", () => {
    expect(honoursReturnKey("number-pad", "android")).toBe(true);
    expect(honoursReturnKey("default", "ios")).toBe(true);
    expect(honoursReturnKey(undefined, "ios")).toBe(true);
  });
});

describe("accessoryIdFor", () => {
  it("produces a distinct id per instance", () => {
    expect(accessoryIdFor(":r1:")).not.toBe(accessoryIdFor(":r2:"));
  });

  it("strips characters React's useId emits that are unsafe as a nativeID", () => {
    expect(accessoryIdFor(":r7:")).toBe("pw-done-r7");
  });
});
