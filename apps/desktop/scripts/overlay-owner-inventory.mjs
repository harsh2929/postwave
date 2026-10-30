import { readdirSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";

import ts from "typescript";

const ROOT = resolve(import.meta.dirname, "../src");
const BEHAVIOR_MARKERS = [
  "<Modal",
  "<SlideoverShell",
  "useDialogStack",
  "useOnboardingDialogBehavior",
  "useSlideoverBehavior",
];

function productionTsxFiles(directory = ROOT) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      return ["__tests__", "stories"].includes(entry.name)
        ? []
        : productionTsxFiles(path);
    }
    return entry.isFile() && entry.name.endsWith(".tsx") ? [path] : [];
  });
}

function jsxAttribute(node, name) {
  return node.attributes.properties.find(
    (attribute) => ts.isJsxAttribute(attribute) && attribute.name.text === name,
  );
}

function staticValue(attribute) {
  if (!attribute || !ts.isJsxAttribute(attribute) || !attribute.initializer) {
    return null;
  }
  if (ts.isStringLiteral(attribute.initializer)) return attribute.initializer.text;
  if (
    ts.isJsxExpression(attribute.initializer) &&
    attribute.initializer.expression &&
    ts.isStringLiteral(attribute.initializer.expression)
  ) {
    return attribute.initializer.expression.text;
  }
  return null;
}

const findings = [];
for (const path of productionTsxFiles()) {
  const contents = readFileSync(path, "utf8");
  const sourceFile = ts.createSourceFile(
    path,
    contents,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const visit = (node) => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = node.tagName.getText(sourceFile);
      const role = staticValue(jsxAttribute(node, "role"));
      if (/^[a-z]/u.test(tag) && ["alertdialog", "dialog"].includes(role)) {
        const point = sourceFile.getLineAndCharacterOfPosition(node.getStart());
        findings.push({
          file: relative(ROOT, path),
          line: point.line + 1,
          tag,
          role,
          modal: staticValue(jsxAttribute(node, "aria-modal")),
          behaviorMarkers: BEHAVIOR_MARKERS.filter((marker) =>
            contents.includes(marker),
          ),
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
}

const owners = new Set(findings.map((finding) => finding.file));
const unmarked = findings.filter(
  (finding) => finding.behaviorMarkers.length === 0,
);
const result = {
  renderedDialogSites: findings.length,
  ownerCount: owners.size,
  unmarkedBehaviorSites: unmarked.length,
  findings,
};

if (process.argv.includes("--json")) {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} else {
  process.stdout.write(
    [
      `Rendered dialog/alertdialog sites: ${result.renderedDialogSites}`,
      `Production owners: ${result.ownerCount}`,
      `Sites without an in-file shared behavior marker: ${result.unmarkedBehaviorSites}`,
      "",
      ...findings.map(
        (finding) =>
          `${finding.file}:${finding.line} ${finding.role} modal=${finding.modal ?? "unspecified"} behavior=${finding.behaviorMarkers.join(",") || "unmarked"}`,
      ),
      "",
    ].join("\n"),
  );
}
