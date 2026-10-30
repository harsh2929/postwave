// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import {
  MIN_PASSWORD_LENGTH,
  evaluatePassword,
} from "@/lib/password-strength";

describe("evaluatePassword", () => {
  it("reports an empty password as not meeting the minimum, score 0", () => {
    const a = evaluatePassword("");
    expect(a.length).toBe(0);
    expect(a.lengthMet).toBe(false);
    expect(a.score).toBe(0);
    expect(a.label).toBe("Too short");
    expect(a.percent).toBe(0);
  });

  it("never advertises strength below the minimum length", () => {
    // 11 chars, high variety — still capped at Weak because < 12.
    const a = evaluatePassword("Ab1!Ab1!Ab1"); // length 11
    expect(a.length).toBe(11);
    expect(a.lengthMet).toBe(false);
    expect(a.score).toBeLessThanOrEqual(1);
  });

  it("flips lengthMet at exactly the minimum", () => {
    const a = evaluatePassword("a".repeat(MIN_PASSWORD_LENGTH));
    expect(a.lengthMet).toBe(true);
    // single character class, exactly minimum length → Weak.
    expect(a.score).toBe(1);
    expect(a.label).toBe("Weak");
  });

  it("rewards character-class variety once long enough", () => {
    const a = evaluatePassword("abcdefghij1K"); // 12 chars, lower+upper+digit
    expect(a.lengthMet).toBe(true);
    expect(a.score).toBe(3);
    expect(a.label).toBe("Good");
  });

  it("caps a long, high-variety password at Strong", () => {
    const a = evaluatePassword("Abcdefghij1K!longer"); // >=16, 4 classes
    expect(a.score).toBe(4);
    expect(a.label).toBe("Strong");
    expect(a.percent).toBe(100);
  });

  it("exposes a monotonic percent tied to score", () => {
    expect(evaluatePassword("a".repeat(12)).percent).toBe(25);
    expect(evaluatePassword("abcdefghij1K").percent).toBe(75);
  });
});
