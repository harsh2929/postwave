/**
 * The pure half of the Subject Lab's generator.
 *
 * Two jobs, and both of them are about not lying to the person holding the
 * phone: refuse a request the server will refuse anyway (so the Generate
 * button is never a button that can only fail), and read a model's answer
 * defensively (so "six variants" is checked rather than assumed).
 */
import { describe, expect, it } from "vitest";

import {
  canGenerateFromSeed,
  clampVariantCount,
  isSubjectLabAxis,
  readSubjectVariants,
  scorableFrom,
  subjectSeedHint,
  SUBJECT_LAB_AXES,
  SUBJECT_LAB_SEED_MIN,
  SUBJECT_LAB_VARIANT_DEFAULT,
  SUBJECT_LAB_VARIANT_MAX,
  SUBJECT_LAB_VARIANT_MIN,
} from "./subjectLabVariants";

describe("the seed the server will accept", () => {
  it("mirrors subject_lab.go's ≥10 characters, measured after trimming", () => {
    expect(SUBJECT_LAB_SEED_MIN).toBe(10);
    expect(canGenerateFromSeed("123456789")).toBe(false);
    expect(canGenerateFromSeed("1234567890")).toBe(true);
    // Whitespace is not content; the server trims before it counts.
    expect(canGenerateFromSeed("   short      ")).toBe(false);
  });

  it("stays silent on an untouched field and speaks on a rejectable one", () => {
    // A field nobody has typed in yet is not an error, and an input that
    // shouts a rule before you have broken it is noise.
    expect(subjectSeedHint("")).toBeNull();
    expect(subjectSeedHint("   ")).toBeNull();
    expect(subjectSeedHint("A subject line long enough")).toBeNull();
    expect(subjectSeedHint("too short")).toContain("at least 10");
  });
});

describe("the axis vocabulary", () => {
  it("is exactly the four subject_lab.go's validAxis accepts", () => {
    expect(SUBJECT_LAB_AXES.map((a) => a.value)).toEqual([
      "length",
      "emoji",
      "question",
      "personalization",
    ]);
  });

  it("rejects anything else, so a bad_axis 400 is unreachable from here", () => {
    expect(isSubjectLabAxis("length")).toBe(true);
    expect(isSubjectLabAxis("tone")).toBe(false);
    expect(isSubjectLabAxis(undefined)).toBe(false);
  });
});

describe("the count the server will accept", () => {
  it("clamps into 5..8 and treats absent as the server's own default", () => {
    expect(clampVariantCount(undefined)).toBe(SUBJECT_LAB_VARIANT_DEFAULT);
    expect(clampVariantCount(0)).toBe(SUBJECT_LAB_VARIANT_DEFAULT);
    expect(clampVariantCount(1)).toBe(SUBJECT_LAB_VARIANT_MIN);
    expect(clampVariantCount(99)).toBe(SUBJECT_LAB_VARIANT_MAX);
    expect(clampVariantCount(7)).toBe(7);
    expect(clampVariantCount(Number.NaN)).toBe(SUBJECT_LAB_VARIANT_DEFAULT);
  });
});

describe("reading what the composer returned", () => {
  it("keeps the order and the axis the server names", () => {
    const reading = readSubjectVariants({
      variants: ["Short one", "A rather longer one"],
      axis: "length",
    });
    expect(reading.variants).toEqual(["Short one", "A rather longer one"]);
    expect(reading.axis).toBe("length");
  });

  it("drops blanks and duplicates rather than rendering rows nobody can tell apart", () => {
    // A duplicate is not merely ugly: it also burns one of the scorer's
    // sixteen slots downstream for an answer already on screen.
    const reading = readSubjectVariants({
      variants: ["Spring sale", "  ", "spring sale", "", "Summer sale"],
    });
    expect(reading.variants).toEqual(["Spring sale", "Summer sale"]);
  });

  it("survives a body that is not the shape it promised", () => {
    // Two services and a model sit between this and the handler. "It returned
    // an array of strings" is an assumption, not a guarantee.
    expect(readSubjectVariants(null).variants).toEqual([]);
    expect(readSubjectVariants({ variants: "nope" }).variants).toEqual([]);
    expect(readSubjectVariants({ variants: [1, null, {}] }).variants).toEqual([]);
    expect(readSubjectVariants({ variants: [], axis: "sideways" }).axis).toBeNull();
  });
});

describe("handing the results to the scorer", () => {
  it("puts the person's own subject line first", () => {
    // The question is "is any of these better than what I already wrote", and
    // a ranking that omits the incumbent cannot answer it.
    expect(scorableFrom("My original", ["Variant A", "Variant B"])).toBe(
      "My original\nVariant A\nVariant B",
    );
  });

  it("does not repeat the seed when the model returned it back", () => {
    expect(scorableFrom("My original", ["my original", "Variant B"])).toBe(
      "My original\nVariant B",
    );
  });

  it("drops an empty seed instead of emitting a blank first line", () => {
    // A blank line would parse as no candidate at all, but it would still be
    // the first thing in the box someone is about to edit.
    expect(scorableFrom("   ", ["Variant A"])).toBe("Variant A");
  });
});
