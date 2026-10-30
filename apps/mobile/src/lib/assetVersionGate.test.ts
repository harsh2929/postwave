/**
 * The rule every asset write obeys: A VERSION IS READ, NEVER GUESSED.
 *
 * Three separable claims are pinned here, because each one fails differently:
 *
 *   1. The SHAPE guard mirrors `exactPositiveJSONInteger` (handlers.go) and the
 *      `*in.ExpectedVersion <= 0` checks. A number this refuses must never
 *      reach the wire, or a client bug turns into a 428 whose message names a
 *      field the operator never saw.
 *   2. The SENTENCES. A 412 is not a network failure and must not read like
 *      one — nothing was written and a colleague got there first.
 *   3. The LEDGER. Several of these writes bump the row's version without
 *      changing anything the list read shows, so a second write made before the
 *      invalidated read lands must use the number the FIRST write answered
 *      with. Without this, tagging an image twice in a row 412s and blames a
 *      teammate who did nothing.
 *
 * Plus the two parses that make a folder's version reachable at all — a folder
 * row that carries none must come back with NO `version` key, because absence
 * is what the organise sheet reads as "withhold rename and delete".
 */
import { describe, expect, it } from "vitest";

import { parseAssetFolders } from "./assetLibrary";
import { parseAssetFolder } from "./assetOrganize";
import {
  ASSET_CREATE_VERSION,
  ASSET_FOLDER_VERSION_MISSING,
  EMPTY_ASSET_VERSION_LEDGER,
  assetVersionErrorMessage,
  assetWriteBlockNote,
  canOfferAssetWrite,
  forgetRowVersion,
  isAssetRowVersion,
  isAssetStaleVersionError,
  isAssetVersionMissingError,
  ledgerVersion,
  parseAssetWriteVersion,
  recordRowVersion,
} from "./assetVersionGate";

describe("isAssetRowVersion mirrors the server's own guard", () => {
  it("accepts a whole number from 1 to 2^53-1", () => {
    expect(isAssetRowVersion(1)).toBe(true);
    expect(isAssetRowVersion(9007199254740991)).toBe(true);
  });

  it("refuses everything the handler would answer 428 for", () => {
    // `number < 1 || number > 1<<53-1 || number != float64(int64(number))`.
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 9007199254740992]) {
      expect(isAssetRowVersion(bad)).toBe(false);
    }
    for (const bad of ["3", null, undefined, {}, [], true]) {
      expect(isAssetRowVersion(bad)).toBe(false);
    }
  });

  it("keeps the create constant distinct from a row version", () => {
    // Both create routes demand EXACTLY 0, which the row guard must refuse:
    // a create's 0 is a constant, not a number read off a row.
    expect(ASSET_CREATE_VERSION).toBe(0);
    expect(isAssetRowVersion(ASSET_CREATE_VERSION)).toBe(false);
  });
});

describe("the refusals are recognised by code and by status", () => {
  it("reads the 412 either way round", () => {
    expect(isAssetStaleVersionError({ code: "stale_version" })).toBe(true);
    expect(isAssetStaleVersionError({ status: 412 })).toBe(true);
    expect(isAssetStaleVersionError({ status: 409, code: "has_references" })).toBe(false);
  });

  it("reads the 428 either way round", () => {
    expect(isAssetVersionMissingError({ code: "expected_version_required" })).toBe(true);
    expect(isAssetVersionMissingError({ status: 428 })).toBe(true);
    expect(isAssetVersionMissingError(new Error("offline"))).toBe(false);
  });
});

describe("assetVersionErrorMessage says what actually happened", () => {
  it("names the thing on screen and says nothing was changed", () => {
    const message = assetVersionErrorMessage({ code: "stale_version" }, "folder");
    expect(message).toContain("folder");
    expect(message).toMatch(/nothing was changed/i);
    expect(message).toMatch(/someone else/i);
  });

  it("states the 428 as this app's bug, not the workspace's", () => {
    const message = assetVersionErrorMessage({ status: 428 }, "image");
    expect(message).toMatch(/this app couldn't tell the server/i);
  });

  it("declines everything else, so the caller's own sentence survives", () => {
    expect(assetVersionErrorMessage(new Error("network"), "image")).toBeNull();
    expect(assetVersionErrorMessage({ status: 409 }, "image")).toBeNull();
  });
});

describe("assetWriteBlockNote — one note, in the order the operator can act", () => {
  it("offers the write when role, connection and version all allow it", () => {
    expect(assetWriteBlockNote(true, true, true)).toBeNull();
  });

  it("puts the role first, because it outranks the other two", () => {
    expect(assetWriteBlockNote(false, false, false)).toMatch(/editor role/);
  });

  it("explains the offline case as a policy, not a spinner", () => {
    expect(assetWriteBlockNote(true, false, false)).toMatch(/never queued for later/);
  });

  it("says the version case is about overwriting a teammate", () => {
    const note = assetWriteBlockNote(true, true, false);
    expect(note).toMatch(/version every change is checked against/);
    expect(note).toMatch(/overwrite a teammate/);
  });

  it("has a separate sentence for a folder row, whose gate is its own version", () => {
    expect(ASSET_FOLDER_VERSION_MISSING).toMatch(/Renaming and deleting/);
  });
});

describe("canOfferAssetWrite decides, and the note explains the same decision", () => {
  it("offers the write only with role, connection AND a usable version", () => {
    expect(canOfferAssetWrite(true, true, 4)).toBe(true);
    expect(canOfferAssetWrite(false, true, 4)).toBe(false);
    expect(canOfferAssetWrite(true, false, 4)).toBe(false);
    expect(canOfferAssetWrite(true, true, null)).toBe(false);
    expect(canOfferAssetWrite(true, true, undefined)).toBe(false);
  });

  it("refuses the two numbers the write handlers answer 428 for", () => {
    expect(canOfferAssetWrite(true, true, 0)).toBe(false);
    expect(canOfferAssetWrite(true, true, 1.5)).toBe(false);
  });

  it("never leaves an absence unexplained", () => {
    // The button's condition and the note's condition must not drift: every
    // input that hides the control must also produce a sentence, and the one
    // that shows it must produce none.
    for (const canWrite of [true, false]) {
      for (const online of [true, false]) {
        for (const version of [4, 0, null]) {
          const offered = canOfferAssetWrite(canWrite, online, version);
          const note = assetWriteBlockNote(canWrite, online, offered);
          expect(offered ? note === null : typeof note === "string").toBe(true);
        }
      }
    }
  });
});

describe("parseAssetWriteVersion reads the number a write ANSWERED with", () => {
  it("reads {ok,id,version} and {tags,version}", () => {
    expect(parseAssetWriteVersion({ ok: true, id: "a1", version: 7 })).toBe(7);
    expect(parseAssetWriteVersion({ tags: ["hero"], version: 12 })).toBe(12);
  });

  it("answers null for anything that is not a usable version", () => {
    expect(parseAssetWriteVersion({ ok: true })).toBeNull();
    expect(parseAssetWriteVersion({ version: "7" })).toBeNull();
    expect(parseAssetWriteVersion({ version: 0 })).toBeNull();
    expect(parseAssetWriteVersion(null)).toBeNull();
    expect(parseAssetWriteVersion([{ version: 7 }])).toBeNull();
  });
});

describe("the ledger: which number the NEXT write sends", () => {
  it("falls back to the row when nothing has been written yet", () => {
    expect(ledgerVersion(EMPTY_ASSET_VERSION_LEDGER, "a1", 4)).toBe(4);
  });

  it("answers null — never a guess — when neither source has a version", () => {
    expect(ledgerVersion(EMPTY_ASSET_VERSION_LEDGER, "a1", null)).toBeNull();
    expect(ledgerVersion(EMPTY_ASSET_VERSION_LEDGER, "a1", undefined)).toBeNull();
    expect(ledgerVersion(EMPTY_ASSET_VERSION_LEDGER, "a1", 0)).toBeNull();
  });

  it("prefers the write's answer over a list read that started before it", () => {
    // The real sequence: add a tag (version 4 → 5), then add a second one
    // before the invalidated library read has landed and still reports 4.
    const after = recordRowVersion(EMPTY_ASSET_VERSION_LEDGER, "a1", 5);
    expect(ledgerVersion(after, "a1", 4)).toBe(5);
  });

  it("prefers a fresher ROW version, because a teammate's edit outranks our own", () => {
    const after = recordRowVersion(EMPTY_ASSET_VERSION_LEDGER, "a1", 5);
    expect(ledgerVersion(after, "a1", 9)).toBe(9);
  });

  it("keeps rows apart, so a folder's number never reaches an asset write", () => {
    const led = recordRowVersion(EMPTY_ASSET_VERSION_LEDGER, "f1", 3);
    expect(ledgerVersion(led, "a1", null)).toBeNull();
    expect(ledgerVersion(led, "f1", null)).toBe(3);
  });

  it("ignores a body that carried no version rather than forgetting a real one", () => {
    const led = recordRowVersion(EMPTY_ASSET_VERSION_LEDGER, "a1", 5);
    expect(recordRowVersion(led, "a1", undefined)).toBe(led);
    expect(recordRowVersion(led, "a1", "6")).toBe(led);
    expect(ledgerVersion(recordRowVersion(led, "a1", 0), "a1", null)).toBe(5);
  });

  it("forgets a deleted row, so a reused id cannot inherit its number", () => {
    const led = recordRowVersion(EMPTY_ASSET_VERSION_LEDGER, "f1", 3);
    expect(ledgerVersion(forgetRowVersion(led, "f1"), "f1", null)).toBeNull();
    // And leaves everything else alone.
    expect(forgetRowVersion(led, "missing")).toBe(led);
  });

  it("never mutates the ledger it was handed", () => {
    const led = recordRowVersion(EMPTY_ASSET_VERSION_LEDGER, "a1", 5);
    recordRowVersion(led, "a2", 2);
    forgetRowVersion(led, "a1");
    expect(led).toEqual({ a1: 5 });
  });
});

describe("a folder row carries its own version, or carries no version key", () => {
  it("reads it off the list envelope", () => {
    const [folder] = parseAssetFolders({
      folders: [{ id: "f1", name: "Brand", assetCount: 2, version: 6 }],
    });
    expect(folder?.version).toBe(6);
  });

  it("reads it off the bare row the create/rename answer with", () => {
    expect(parseAssetFolder({ id: "f1", name: "Brand", version: 6 })?.version).toBe(6);
  });

  it("omits the KEY entirely when the payload carried none", () => {
    // Not null, not 0: absence is what the organise sheet reads as "withhold
    // rename and delete", and it is also what keeps a version-less payload
    // structurally equal to the row it used to parse into.
    const [folder] = parseAssetFolders({
      folders: [{ id: "f1", name: "Brand", assetCount: 2 }],
    });
    expect(folder).not.toHaveProperty("version");
    expect(parseAssetFolder({ id: "f1", name: "Brand" })).not.toHaveProperty(
      "version",
    );
  });

  it("omits a version the rename would be refused for", () => {
    for (const bad of [0, -2, "6", 1.5]) {
      expect(
        parseAssetFolders({
          folders: [{ id: "f1", name: "Brand", assetCount: 0, version: bad }],
        })[0],
      ).not.toHaveProperty("version");
      expect(parseAssetFolder({ id: "f1", name: "Brand", version: bad })).not.toHaveProperty(
        "version",
      );
    }
  });
});
