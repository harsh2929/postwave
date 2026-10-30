import { readFileSync } from "node:fs";
import { join } from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

import { EN_MESSAGES } from "./messagesEn";

/**
 * THE RATCHET FOR THE i18n SEAM (LOVE#22).
 *
 * A `t()`/`msg()` function and a catalogue are worth nothing on their own: the
 * next contributor writes `<Text>Save changes</Text>`, nothing complains, and
 * six months later the catalogue covers 3 modules out of 200 while the audit
 * finding reads "closed". Every seam this codebase has kept alive — reduce
 * motion, dynamic type, offline gating — is kept alive by a test that fails
 * the build, not by a convention. This is that test.
 *
 * IT IS DELIBERATELY NOT WHOLE-APP. Covering all ~1,260 <Text> nodes in one
 * round would mean either a catalogue nobody reviewed or an exemption list
 * longer than the rule. Instead COVERED names the files that have actually
 * been converted; the set is expected to grow one surface at a time, and a
 * file only enters it when its strings are in the catalogue.
 *
 * The three founding members are chosen to prove the seam on all three shapes
 * a string can take in this app:
 *   - a pure copy module whose sentences are assembled from counts
 *     (subscriberCountLine — the finding's own named anchor),
 *   - a pure copy module with a plural AND an agreeing pronoun
 *     (offlineBannerCopy),
 *   - a JSX component, where literals hide in children and in props
 *     (DisplayPreferencesSection).
 *
 * THE FIRST WHOLE SURFACE (DASHBOARD#83) is the dashboard: the screen's own
 * chrome, its freshness badge and its entire load-failure taxonomy. That
 * finding's complaint was that "'Dashboard', 'Subscribers', 'Open rate',
 * 'Sent 30d', "What's happening", 'No recent activity.', 'Live'/'Idle' and all
 * error copy are inline literals" on the FIRST screen anybody opens. The
 * screen's chrome and both of its copy-owning pure modules
 * (`dashboardLiveness`, `dashboardFailure`) are now in the catalogue and
 * pinned here, together with the six stat tiles — labels, destinations, the
 * movement lines and the four whole VoiceOver frames (`statTiles.ts`). The
 * individual CARDS below the grid (goals, anomalies, inbox health, insights,
 * recent campaigns) are NOT yet: the set grows one surface at a time, and
 * claiming files this test does not check would be the exact rot the ratchet
 * exists to prevent.
 *
 * WHAT COUNTS AS AN OFFENCE is narrow on purpose, because a noisy guard gets
 * an exemption bolted on rather than obeyed:
 *   R1  JSX text containing a letter.
 *   R2  a string/template literal reaching a user-facing JSX prop.
 *   R3  a string/template literal anywhere else that reads as a SENTENCE —
 *       two or more letter-words, or terminal punctuation.
 * Enum tokens ("compact"), style values ("uppercase"), a11y roles ("button")
 * and import paths are all single words or module specifiers, so none of them
 * trip it. That is the line: a word is data, a phrase is copy.
 */

const mobileRoot = process.cwd();

/** Files whose user-facing strings live in the catalogue. Grows; never shrinks. */
const COVERED = [
  "src/lib/subscriberCountLine.ts",
  "src/lib/offlineBannerCopy.ts",
  "src/components/settings/DisplayPreferencesSection.tsx",
  // The dashboard surface (DASHBOARD#83).
  "app/(tabs)/dashboard.tsx",
  "src/components/dashboard/DashboardSectionHeading.tsx",
  "src/components/dashboard/DashboardFailureNotice.tsx",
  "src/components/dashboard/LiveDot.tsx",
  "src/lib/dashboardLiveness.ts",
  "src/lib/dashboardFailure.ts",
  "src/components/dashboard/DashboardStatGrid.tsx",
  "src/components/dashboard/statTiles.ts",
  "src/lib/dashboardTileSpeech.ts",
  // The in-flight send strip (DASHBOARD#45), joined to the surface it was
  // built onto rather than left beside it: a new dashboard file that is not
  // held to the catalogue is exactly how a covered surface starts leaking.
  "src/components/dashboard/ActiveSendStrip.tsx",
  "src/lib/activeSend.ts",
  // The bounce mix (DASHBOARD#35), same reasoning.
  "src/components/dashboard/BounceMixCard.tsx",
  "src/lib/dashboardBounceMix.ts",
  // The deliverability cluster's two owned screens (DELIVERABILITY#52). The
  // finding's own anchors: both had every string inline, and dmarc.tsx built
  // its share label with `n === 1 ? "this report" : …`. Their child cards are
  // NOT claimed here — the set grows one file at a time, and listing a file
  // this test does not actually clean is the rot the ratchet exists to stop.
  "app/(tabs)/dmarc.tsx",
  "app/(tabs)/custom-domains.tsx",
  "src/components/deliverability/DomainsHeaderActions.tsx",
  // The campaigns list's chrome and its filter bar (CAMPAIGNS#75). The finding
  // named "Search by name or subject…" specifically; it lives in the filter
  // bar, which is why both files enter together rather than the route alone.
  "app/(tabs)/campaigns/index.tsx",
  "src/components/campaigns/CampaignFilterBar.tsx",
  // The More menu's honesty block (MAP#73) and the offline queue's status
  // line (SHELL#67's other named anchor). Both are pure copy modules, which
  // is the shape this seam converts most cheaply — and the status line was
  // the app's last hand-assembled counted phrase, so bringing it in closes
  // the finding's own example rather than adding coverage beside it.
  "src/lib/desktopOnlyCapabilities.ts",
  "src/lib/offlineQueueStatusLine.ts",
  // The governance surfaces' shared first-run copy (GOVERNANCE#30). Six
  // screens read it, so it is the highest-leverage single file in the app to
  // hold to the catalogue.
  "src/lib/governanceEmptyStates.ts",
  // Its offline twin (GOVERNANCE#33). Same argument, same six screens: the
  // failure mode for governance copy is DRIFT, and a catalogue that holds the
  // first-run sentences but not the offline ones would let the two halves of
  // one contract diverge in exactly the way the ratchet exists to prevent.
  "src/lib/governanceOfflineStates.ts",
] as const;

/**
 * JSX props that a human reads. `accessibilityLabel`/`Hint` are here because a
 * VoiceOver string is user-facing copy in exactly the way visible text is —
 * leaving them out would translate the screen for sighted users only.
 */
const USER_FACING_PROPS = new Set([
  "accessibilityHint",
  "accessibilityLabel",
  "accessibilityValue",
  "body",
  "cta",
  "description",
  "heading",
  "hint",
  "label",
  "legend",
  "message",
  "note",
  "placeholder",
  "subtitle",
  "text",
  "title",
]);

/** The functions that read the catalogue. Their FIRST argument is a key. */
const TRANSLATORS = new Set(["msg", "pluralMsg"]);

interface Offence {
  line: number;
  text: string;
  rule: string;
}

function parse(path: string, text: string): ts.SourceFile {
  return ts.createSourceFile(
    path,
    text,
    ts.ScriptTarget.Latest,
    true,
    path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

/** Two letter-words in a row, or a clause that ends like a sentence. */
function readsLikeCopy(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (/[A-Za-z]{2,}[\s ]+[A-Za-z]{2,}/u.test(trimmed)) return true;
  return /[A-Za-z]{3,}[.?!]$/u.test(trimmed);
}

/** Is this literal the message-key argument of msg()/pluralMsg()? */
function isTranslatorKey(node: ts.Node): boolean {
  const parent = node.parent;
  if (!parent || !ts.isCallExpression(parent)) return false;
  if (parent.arguments[0] !== node) return false;
  const callee = parent.expression;
  return ts.isIdentifier(callee) && TRANSLATORS.has(callee.text);
}

/** Module specifiers, property NAMES, and type positions are not copy. */
function isStructural(node: ts.Node): boolean {
  const parent = node.parent;
  if (!parent) return false;
  if (ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent)) {
    return true;
  }
  if (ts.isPropertyAssignment(parent) && parent.name === node) return true;
  if (ts.isLiteralTypeNode(parent)) return true;
  if (ts.isElementAccessExpression(parent) && parent.argumentExpression === node) {
    return true;
  }
  return false;
}

/** Walk up to the enclosing JSX attribute, if the literal sits inside one. */
function enclosingJsxAttribute(node: ts.Node): ts.JsxAttribute | null {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (ts.isJsxAttribute(current)) return current;
    if (ts.isJsxElement(current) || ts.isJsxSelfClosingElement(current)) {
      return null;
    }
    current = current.parent;
  }
  return null;
}

export function hardcodedCopy(path: string, text: string): Offence[] {
  const source = parse(path, text);
  const offences: Offence[] = [];
  const at = (node: ts.Node): number =>
    source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;

  function record(node: ts.Node, value: string, rule: string): void {
    offences.push({ line: at(node), text: value.trim().slice(0, 80), rule });
  }

  function visit(node: ts.Node): void {
    // R1 — visible text between JSX tags.
    if (ts.isJsxText(node)) {
      if (/[A-Za-z]/u.test(node.text)) record(node, node.text, "jsx-text");
      return;
    }

    const literal =
      ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)
        ? node.text
        : ts.isTemplateExpression(node)
          ? node.getText(source)
          : null;

    if (literal !== null && !isStructural(node) && !isTranslatorKey(node)) {
      const attribute = enclosingJsxAttribute(node);
      const propName = attribute?.name.getText(source);
      if (propName && USER_FACING_PROPS.has(propName)) {
        // R2 — reaching a prop a human reads, even as a single word.
        record(node, literal, `jsx-prop:${propName}`);
      } else if (readsLikeCopy(literal)) {
        // R3 — a sentence anywhere else in the module.
        record(node, literal, "sentence");
      }
    }

    ts.forEachChild(node, visit);
  }

  ts.forEachChild(source, visit);
  return offences;
}

describe("i18n coverage", () => {
  it("has no hardcoded user-facing copy in a covered file", () => {
    const failures: string[] = [];
    for (const rel of COVERED) {
      const text = readFileSync(join(mobileRoot, rel), "utf8");
      for (const offence of hardcodedCopy(rel, text)) {
        failures.push(
          `${rel}:${offence.line} [${offence.rule}] ${JSON.stringify(offence.text)} — ` +
            `move it into src/lib/messagesEn.ts and read it with msg()/pluralMsg().`,
        );
      }
    }
    expect(failures, failures.join("\n")).toEqual([]);
  });

  it("actually FAILS on a new hardcoded literal — the guard is not a no-op", () => {
    // A coverage test that cannot fail is decoration. This runs the detector
    // over each shape of regression it exists to catch.
    const sentenceInLib = hardcodedCopy(
      "src/lib/example.ts",
      `export const copy = "Changes will sync when you're back online.";`,
    );
    expect(sentenceInLib.map((o) => o.rule)).toEqual(["sentence"]);

    const textInJsx = hardcodedCopy(
      "src/components/Example.tsx",
      `export const C = () => <Text>Save changes</Text>;`,
    );
    expect(textInJsx.map((o) => o.rule)).toEqual(["jsx-text"]);

    const propInJsx = hardcodedCopy(
      "src/components/Example.tsx",
      `export const C = () => <Row accessibilityLabel="Open" />;`,
    );
    expect(propInJsx.map((o) => o.rule)).toEqual(["jsx-prop:accessibilityLabel"]);

    const templateInLib = hardcodedCopy(
      "src/lib/example.ts",
      "export const c = (n: number) => `${n} changes waiting to send`;",
    );
    expect(templateInLib.map((o) => o.rule)).toEqual(["sentence"]);
  });

  it("does not fire on data, style values, or catalogue keys", () => {
    // The guard has to be quiet on the things that are NOT copy, or the next
    // contributor exempts the file instead of obeying the rule.
    const clean = hardcodedCopy(
      "src/components/Example.tsx",
      `import { msg } from "@/lib/i18n";
       const DENSITIES = ["comfortable", "compact"] as const;
       export const C = () => (
         <Pressable accessibilityRole="button" accessibilityLabel={msg("display.title")}>
           <Text style={{ textTransform: "uppercase" }}>{msg("display.title")}</Text>
         </Pressable>
       );`,
    );
    expect(clean).toEqual([]);
  });
});

describe("the catalogue itself", () => {
  it("gives every counted message an `other` form", () => {
    // `other` is the only category every language has, so it is the universal
    // fallback for a translator who left one blank.
    const broken = Object.entries(EN_MESSAGES)
      .filter(([, value]) => typeof value !== "string")
      .filter(([, value]) => typeof (value as { other?: string }).other !== "string")
      .map(([key]) => key);
    expect(broken).toEqual([]);
  });

  it("keeps sentence FRAMES whole instead of splitting them across keys", () => {
    // "Showing {loaded} of {total}" must stay one string: assembling it in
    // code freezes English word order, which is the defect this seam exists
    // to remove. A frame that lost its placeholders is that regression.
    expect(EN_MESSAGES["subscribers.count.showing"]).toContain("{loaded}");
    expect(EN_MESSAGES["subscribers.count.showing"]).toContain("{total}");
    expect(EN_MESSAGES["subscribers.count.filtered"].other).toContain("{noun}");
  });

  it("never carries a bare pluralising suffix", () => {
    // `"change(s)"` and `"{count} change{s}"` are the shapes people reach for
    // when the plural entry feels like too much ceremony. They are the exact
    // thing that cannot be translated.
    const suspicious = Object.entries(EN_MESSAGES).flatMap(([key, value]) => {
      const forms = typeof value === "string" ? [value] : Object.values(value);
      return forms.some((form) => /\(s\)|\{s\}/u.test(form)) ? [key] : [];
    });
    expect(suspicious).toEqual([]);
  });
});
