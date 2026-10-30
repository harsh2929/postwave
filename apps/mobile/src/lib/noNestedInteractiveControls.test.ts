import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

const mobileRoot = process.cwd();
const interactiveTags = new Set([
  "Button",
  "MoveButton",
  "Pressable",
  "TextLink",
  "TouchableHighlight",
  "TouchableNativeFeedback",
  "TouchableOpacity",
  "TouchableWithoutFeedback",
]);

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.isFile() &&
      path.endsWith(".tsx") &&
      !path.endsWith(".test.tsx")
      ? [path]
      : [];
  });
}

function nestedInteractiveControls(path: string): string[] {
  const source = ts.createSourceFile(
    path,
    readFileSync(path, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const findings: string[] = [];

  function visit(node: ts.Node, interactiveAncestors: string[]): void {
    if (ts.isJsxElement(node)) {
      const tag = node.openingElement.tagName.getText(source);
      const nextAncestors = interactiveTags.has(tag)
        ? [...interactiveAncestors, tag]
        : interactiveAncestors;
      if (interactiveTags.has(tag) && interactiveAncestors.length > 0) {
        const line =
          source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
        findings.push(
          `${relative(mobileRoot, path)}:${line} ${interactiveAncestors.at(-1)} > ${tag}`,
        );
      }
      for (const child of node.children) visit(child, nextAncestors);
      return;
    }
    if (ts.isJsxFragment(node)) {
      for (const child of node.children) visit(child, interactiveAncestors);
      return;
    }
    ts.forEachChild(node, (child) => visit(child, interactiveAncestors));
  }

  visit(source, []);
  return findings;
}

describe("mobile interaction semantics", () => {
  // Whole-repo AST scan: 5s is the wrong budget for it, and `--coverage` adds
  // ~10x of v8 instrumentation on top. A coverage gate that cannot be run green
  // is a gate nobody ratchets — see vitest.config.ts thresholds.
  it("has no directly nested button/pressable controls", { timeout: 60_000 }, () => {
    const files = [
      ...sourceFiles(join(mobileRoot, "app")),
      ...sourceFiles(join(mobileRoot, "src")),
    ];
    const findings = files.flatMap(nestedInteractiveControls);
    expect(findings, findings.join("\n")).toEqual([]);
  });
});
