// SPDX-License-Identifier: AGPL-3.0-only
//
// The iOS privacy manifest must agree with the store disclosure register.
//
// THE PROBLEM. What this app collects is declared three times: here in
// apps/mobile/app.json (compiled into PrivacyInfo.xcprivacy at prebuild), in
// Apple's App Privacy nutrition labels, and in Google Play's Data safety form.
// Only the first is version-controlled, so the other two could say anything and
// nothing would notice. Apple treats a nutrition label that contradicts the
// binary as grounds for removal, and Play treats an inaccurate Data safety
// declaration as a policy violation — both are distribution risks, not
// paperwork risks.
//
// THE FIX. docs/compliance-2026-09/store-data-disclosure.json is the single
// source. This test proves the one declaration a machine can read — the privacy
// manifest — is a faithful projection of it, in BOTH directions:
//
//   * every register entry appears in the manifest with matching linkage,
//     tracking flag and purposes; and
//   * the manifest declares nothing the register does not know about.
//
// The second direction is the one that matters most. A one-way check passes
// while someone quietly adds a collected data type to app.json, which is
// exactly how a nutrition label goes stale.
//
// WHAT THIS CANNOT DO. It cannot reach into App Store Connect or Play Console.
// A human still transcribes the answers. What it can do is make the thing they
// transcribe from reviewable, diffable, and impossible to contradict silently.

import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const MOBILE_ROOT = path.join(__dirname, "..", "..");
const REPO_ROOT = path.join(MOBILE_ROOT, "..", "..");

type AppleDeclaration = {
  /** The App Privacy section App Store Connect files `type` under. */
  category: string;
  type: string;
  linked: boolean;
  tracking: boolean;
  purposes: string[];
};

type RegisterEntry = {
  id: string;
  what: string;
  evidence: string[];
  apple: AppleDeclaration;
  play: {
    category: string;
    type: string;
    collected: boolean;
    shared: boolean;
    optional: boolean;
    purposes: string[];
    ephemeral: boolean;
  };
};

type Register = {
  version: string;
  why_this_file_exists: string;
  tracking: { apple_nsprivacytracking: boolean; play_shared_for_advertising: boolean };
  platform_assurances: { deletion_request_url: string; in_app_deletion: string };
  data_types: RegisterEntry[];
  deliberately_not_collected: { what: string; note: string }[];
};

type ManifestEntry = {
  NSPrivacyCollectedDataType: string;
  NSPrivacyCollectedDataTypeLinked: boolean;
  NSPrivacyCollectedDataTypeTracking: boolean;
  NSPrivacyCollectedDataTypePurposes: string[];
};

const register: Register = JSON.parse(
  readFileSync(
    path.join(REPO_ROOT, "docs", "compliance-2026-09", "store-data-disclosure.json"),
    "utf8",
  ),
);

const appConfig = JSON.parse(readFileSync(path.join(MOBILE_ROOT, "app.json"), "utf8"));
const manifest = appConfig.expo?.ios?.privacyManifests;

const sorted = (xs: string[]): string[] => [...xs].sort();

describe("the iOS privacy manifest is a projection of the store disclosure register", () => {
  it("both documents exist and are non-trivial", () => {
    // A guard that runs against an empty register reports green for the wrong
    // reason, which is the failure mode being fixed rather than a version of it
    // to reintroduce here.
    expect(register.data_types.length).toBeGreaterThan(0);
    expect(manifest, "app.json has no ios.privacyManifests block").toBeTruthy();
    expect(Array.isArray(manifest.NSPrivacyCollectedDataTypes)).toBe(true);
  });

  it("declares the same tracking posture in both places", () => {
    expect(manifest.NSPrivacyTracking).toBe(register.tracking.apple_nsprivacytracking);
  });

  it("declares no tracking domains while NSPrivacyTracking is false", () => {
    // A non-empty NSPrivacyTrackingDomains with NSPrivacyTracking false is
    // internally contradictory and Apple rejects the build for it.
    const domains = manifest.NSPrivacyTrackingDomains ?? [];
    if (!manifest.NSPrivacyTracking) {
      expect(domains).toEqual([]);
    }
  });

  it.each(register.data_types)("$id is declared in the manifest as the register describes", (entry) => {
    const declared: ManifestEntry | undefined = manifest.NSPrivacyCollectedDataTypes.find(
      (m: ManifestEntry) => m.NSPrivacyCollectedDataType === entry.apple.type,
    );
    expect(
      declared,
      `${entry.id} (${entry.apple.type}) is in the register but not in ios.privacyManifests`,
    ).toBeTruthy();
    const found = declared as ManifestEntry;
    expect(found.NSPrivacyCollectedDataTypeLinked, `${entry.id} linkage`).toBe(entry.apple.linked);
    expect(found.NSPrivacyCollectedDataTypeTracking, `${entry.id} tracking`).toBe(entry.apple.tracking);
    expect(sorted(found.NSPrivacyCollectedDataTypePurposes), `${entry.id} purposes`).toEqual(
      sorted(entry.apple.purposes),
    );
  });

  it("declares nothing the register has not accounted for", () => {
    // The direction that catches the real drift: someone adds a collected type
    // to app.json, ships, and the nutrition label in App Store Connect no
    // longer describes the binary.
    const known = new Set(register.data_types.map((d) => d.apple.type));
    const undeclared = manifest.NSPrivacyCollectedDataTypes.map(
      (m: ManifestEntry) => m.NSPrivacyCollectedDataType,
    ).filter((t: string) => !known.has(t));
    expect(
      undeclared,
      "These types are in the privacy manifest but not in the store disclosure " +
        "register, so the Apple nutrition label and Play Data safety answers " +
        "cannot be derived from the register any more. Add them to " +
        "docs/compliance-2026-09/store-data-disclosure.json.",
    ).toEqual([]);
  });
});

describe("the register is answerable in both consoles", () => {
  it.each(register.data_types)("$id carries a complete Play answer", (entry) => {
    expect(entry.play.category.length).toBeGreaterThan(0);
    expect(entry.play.type.length).toBeGreaterThan(0);
    expect(entry.play.purposes.length).toBeGreaterThan(0);
    expect(typeof entry.play.collected).toBe("boolean");
    expect(typeof entry.play.shared).toBe("boolean");
    expect(typeof entry.play.optional).toBe("boolean");
  });

  it.each(register.data_types)("$id names the App Store Connect section it is filed under", (entry) => {
    // App Store Connect lists "Photos or Videos" under User Content, not under
    // its manifest key. Without the section the Apple answer cannot be typed in
    // from the register alone.
    expect(entry.apple.category, `${entry.id} has no apple.category`).toMatch(/\S/);
  });

  it("points its reader only at keys the register has", () => {
    // why_this_file_exists tells the operator where the console answers come
    // from. It once named `apple_nutrition_label` and `play_data_safety`,
    // sections that never existed, so the pointer led nowhere.
    const named = [...register.why_this_file_exists.matchAll(/`([a-z_]+)`/g)].map((m) => m[1] ?? "");
    expect(named.length, "why_this_file_exists names no register key").toBeGreaterThan(0);
    const keys = new Set([
      ...Object.keys(register),
      ...register.data_types.flatMap((row) => Object.keys(row)),
    ]);
    expect(named.filter((key) => !keys.has(key))).toEqual([]);
  });

  it.each(register.data_types)("$id says where in the code it is collected", (entry) => {
    // An entry with no evidence anchor is an assertion, not a finding: nobody
    // can re-check it later, which is how the previous declarations rotted.
    expect(entry.evidence.length, `${entry.id} has no evidence`).toBeGreaterThan(0);
    expect(entry.what.length).toBeGreaterThan(20);
  });

  it("shares nothing while claiming to share nothing", () => {
    // Play's "shared" question is answered per data type. If any type were
    // shared, the register's top-level advertising claim and Apple's tracking
    // flag would both need re-examining, so keep the two consistent.
    const shared = register.data_types.filter((d) => d.play.shared).map((d) => d.id);
    if (register.tracking.play_shared_for_advertising === false) {
      expect(
        shared,
        "A data type marked shared contradicts play_shared_for_advertising: false",
      ).toEqual([]);
    }
  });

  it("points the deletion URL at the published page, not an app-only path", () => {
    // Play requires a deletion route reachable WITHOUT installing the app.
    expect(register.platform_assurances.deletion_request_url).toMatch(
      /^https:\/\/postwave\.com\/legal\/account-deletion$/,
    );
  });
});

describe("the not-collected list stays true", () => {
  it("has a reason for every exclusion", () => {
    for (const row of register.deliberately_not_collected) {
      expect(row.note.length, `"${row.what}" is excluded with no reason`).toBeGreaterThan(20);
    }
  });

  it("does not exclude a category the manifest declares", () => {
    // Claiming in the register that location is not collected while the
    // manifest declares NSPrivacyCollectedDataTypePreciseLocation would be a
    // false statement in a store console.
    const declaredTypes: string[] = manifest.NSPrivacyCollectedDataTypes.map(
      (m: ManifestEntry) => m.NSPrivacyCollectedDataType,
    );
    // Keyed by the register row's EXACT `what`. The old keys ("Audio: ",
    // "Contacts") matched no row, so nothing tied a check to the claim it was
    // meant to protect, and a renamed or deleted row went unnoticed.
    const excludedKeywords: Record<string, string[]> = {
      "Precise or coarse location": ["Location", "PreciseLocation", "CoarseLocation"],
      Audio: ["AudioData"],
      "Contacts, calendar, SMS and call logs": ["Contacts"],
    };
    const excluded = new Set(register.deliberately_not_collected.map((row) => row.what));
    for (const [claim, keywords] of Object.entries(excludedKeywords)) {
      expect(
        excluded.has(claim),
        `"${claim}" names no deliberately_not_collected row, so this check guards nothing`,
      ).toBe(true);
      const conflicting = declaredTypes.filter((t) => keywords.some((k) => t.includes(k)));
      expect(conflicting, `register says "${claim}" is not collected`).toEqual([]);
    }
  });
});

/**
 * Source with its comments removed, so a mention in prose neither trips nor
 * satisfies a rule. Whole-line `//` comments go FIRST: a `/*` inside one (a
 * MIME glob such as image/* in a sentence) would otherwise open a "block" that
 * swallows the real code after it.
 */
function codeOf(rel: string): string {
  return readFileSync(path.join(MOBILE_ROOT, rel), "utf8")
    .replace(/^[ \t]*\/\/.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");
}

type PluginEntry = string | [string, Record<string, unknown>?];

function pluginOptions(name: string): Record<string, unknown> | undefined {
  const plugins: PluginEntry[] = appConfig.expo?.plugins ?? [];
  const tuple = plugins.find((p) => Array.isArray(p) && p[0] === name);
  return Array.isArray(tuple) ? (tuple[1] ?? {}) : undefined;
}

/**
 * PO-5. The register is only as true as the code it describes. The Assets
 * screen sends a picked or photographed image to the server
 * (src/lib/assetCapture.ts with base64 on, then uploadAsset's content_base64),
 * and the server keeps it in the asset library. The register used to exclude
 * "Photos and videos" and say no camera frame is transmitted. Both consoles are
 * typed from the register, so both answers were false. No test read the code.
 */
describe("the manifest follows the code", () => {
  // Anchored on these two files, NOT a scan of app/: app/(tabs)/scan.tsx also
  // calls launchImageLibraryAsync, but only to decode a QR code in-process, and
  // nothing it picks leaves the device.
  const capture = codeOf("src/lib/assetCapture.ts");
  const assetsApi = codeOf("src/api/assets.ts");
  const uploadsUserImages =
    /\blaunch(?:ImageLibrary|Camera)Async\s*\(/.test(capture) &&
    /\bcontent_base64\s*:/.test(assetsApi);

  it("a user image that leaves the device is declared as Photos or Videos, and only then", () => {
    const declared: ManifestEntry | undefined = manifest.NSPrivacyCollectedDataTypes.find(
      (m: ManifestEntry) =>
        m.NSPrivacyCollectedDataType === "NSPrivacyCollectedDataTypePhotosorVideos",
    );
    expect(
      Boolean(declared),
      uploadsUserImages
        ? "Assets uploads a picked or photographed image, but ios.privacyManifests does not declare NSPrivacyCollectedDataTypePhotosorVideos"
        : "ios.privacyManifests declares NSPrivacyCollectedDataTypePhotosorVideos, but no code path uploads a user image any more",
    ).toBe(uploadsUserImages);
    if (!uploadsUserImages) return;

    const found = declared as ManifestEntry;
    expect(found.NSPrivacyCollectedDataTypeLinked, "an uploaded asset belongs to the workspace").toBe(true);
    expect(found.NSPrivacyCollectedDataTypeTracking).toBe(false);
    expect(found.NSPrivacyCollectedDataTypePurposes).toEqual([
      "NSPrivacyCollectedDataTypePurposeAppFunctionality",
    ]);

    const row = register.data_types.find(
      (d) => d.apple.type === "NSPrivacyCollectedDataTypePhotosorVideos",
    );
    expect(row, "the register has no data_types row for the uploaded image").toBeTruthy();
    expect(row?.play.category).toBe("Photos and videos");

    const exclusions = register.deliberately_not_collected.map((r) => r.what);
    expect(exclusions, "the register still says photos are not collected").not.toContain(
      "Photos and videos",
    );
    expect(exclusions, "the register still says no camera image is transmitted").not.toContain(
      "Camera imagery",
    );
  });

  it("the camera purpose string names every use the code makes of the camera", () => {
    if (!/\blaunchCameraAsync\s*\(/.test(capture)) return;
    // One Info.plist key, written by three places. Config plugins run in
    // reverse order, so which string ships depends on where each plugin sits
    // in app.json unless all three say the same thing.
    const purposes = {
      "ios.infoPlist.NSCameraUsageDescription": appConfig.expo?.ios?.infoPlist?.NSCameraUsageDescription,
      "expo-camera cameraPermission": pluginOptions("expo-camera")?.cameraPermission,
      "expo-image-picker cameraPermission": pluginOptions("expo-image-picker")?.cameraPermission,
    };
    const distinct = [...new Set(Object.values(purposes))];
    expect(distinct, JSON.stringify(purposes, null, 2)).toHaveLength(1);
    const [shipped] = distinct;
    expect(typeof shipped).toBe("string");
    expect(shipped, "the QR scanner is the camera's first use").toMatch(/QR/);
    expect(shipped, "Assets photographs an image with the camera and uploads it").toMatch(
      /photograph/i,
    );
  });
});

const REGISTER_PATH = "docs/compliance-2026-09/store-data-disclosure.json";

/**
 * App Store Connect's label for an Apple key, minus `prefix`:
 * NSPrivacyCollectedDataTypePhotosorVideos → "Photos or Videos",
 * NSPrivacyCollectedDataTypePurposeAppFunctionality → "App Functionality".
 */
function appleLabel(key: string, prefix: string): string {
  return key
    .slice(prefix.length)
    .replace(/or(?=[A-Z])/g, " or ") // Apple spells PhotosorVideos with a lower-case "or"
    .replace(/([a-z])([A-Z])/g, "$1 $2");
}

/** One App Privacy answer, as the App Store Connect checklist must list it. */
function appleAnswer({ apple }: RegisterEntry): string {
  const purposes = apple.purposes.map((p) => appleLabel(p, "NSPrivacyCollectedDataTypePurpose"));
  return (
    `${apple.category} → ${appleLabel(apple.type, "NSPrivacyCollectedDataType")} ` +
    `(${apple.linked ? "linked" : "not linked"}, ${apple.tracking ? "tracking" : "not tracking"}; ` +
    `${purposes.join(", ")})`
  );
}

/** One Data safety answer, as the Play Console checklist must list it. */
function playAnswer({ play }: RegisterEntry): string {
  return (
    `${play.category} → ${play.type} ` +
    `(${play.collected ? "collected" : "not collected"}, ${play.shared ? "shared" : "not shared"}, ` +
    `${play.optional ? "optional" : "required"}, ${play.ephemeral ? "ephemeral" : "not ephemeral"}; ` +
    `${play.purposes.join(", ")})`
  );
}

type ChecklistItem = { text: string; answers: string[] };

/**
 * The README checklist item under `heading` that says its answers come from
 * the register, with its nested bullets. A `- [ ]` line opens an item, an
 * indented `- ` line is one of its bullets, and any other indented line
 * continues its text.
 */
function transcriptionItem(heading: string): ChecklistItem {
  const lines = readFileSync(path.join(MOBILE_ROOT, "README.md"), "utf8").split("\n");
  const from = lines.indexOf(heading);
  expect(from, `apps/mobile/README.md has no "${heading}" section`).toBeGreaterThanOrEqual(0);
  const items: ChecklistItem[] = [];
  for (const line of lines.slice(from + 1)) {
    if (/^#{1,6} /.test(line)) break;
    const opened = /^- \[[ xX]\] (.*)$/.exec(line)?.[1];
    const bullet = /^\s+- (.*)$/.exec(line)?.[1];
    const current = items[items.length - 1];
    if (opened !== undefined) items.push({ text: opened, answers: [] });
    else if (bullet !== undefined && current) current.answers.push(bullet.trim());
    else if (/^\s+\S/.test(line) && current) current.text += ` ${line.trim()}`;
  }
  const pointing = items.filter((item) => item.text.includes(REGISTER_PATH));
  expect(
    pointing.map((item) => item.text),
    `no "${heading}" item says its answers are transcribed from ${REGISTER_PATH}`,
  ).toHaveLength(1);
  return pointing[0] as ChecklistItem;
}

/**
 * The operator types the console answers from the README checklists, not from
 * the register. When the register gained photos_or_videos, both checklists
 * still listed six types, so following them left Photos or Videos out of both
 * consoles. Each checklist now lists the register's rows in order, and this
 * holds the list to the register in both directions.
 */
describe("the submission checklists are the register, row by row", () => {
  it("the App Store Connect checklist lists every App Privacy answer and nothing else", () => {
    const { answers } = transcriptionItem("## App Store Connect (iOS) checklist");
    expect(answers).toEqual(register.data_types.map(appleAnswer));
  });

  it("the Play Console checklist lists every Data safety answer and nothing else", () => {
    const { answers } = transcriptionItem("## Google Play Console (Android) checklist");
    expect(answers).toEqual(register.data_types.map(playAnswer));
  });
});
