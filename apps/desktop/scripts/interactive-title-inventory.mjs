import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

const ROOT = resolve(import.meta.dirname, "../src");
const INTERACTIVE_TAGS = new Set([
  "a",
  "button",
  "input",
  "option",
  "select",
  "summary",
  "textarea",
]);
const INTERACTIVE_ROLE =
  /^(?:button|checkbox|link|menuitem(?:checkbox|radio)?|option|radio|switch|tab)$/u;
const INTERACTION_ATTRIBUTES = new Set([
  "contentEditable",
  "onClick",
  "onKeyDown",
  "onKeyUp",
  "tabIndex",
]);

function productionTsxFiles(directory) {
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

function attributeName(attribute, sourceFile) {
  return ts.isJsxAttribute(attribute) ? attribute.name.getText(sourceFile) : "";
}

function staticAttributeValue(attribute, sourceFile) {
  if (!attribute || !ts.isJsxAttribute(attribute) || !attribute.initializer) {
    return null;
  }
  if (ts.isStringLiteral(attribute.initializer))
    return attribute.initializer.text;
  if (
    ts.isJsxExpression(attribute.initializer) &&
    attribute.initializer.expression &&
    ts.isStringLiteral(attribute.initializer.expression)
  ) {
    return attribute.initializer.expression.text;
  }
  return attribute.initializer.getText(sourceFile);
}

function isInteractive(tag, attributes, sourceFile) {
  if (INTERACTIVE_TAGS.has(tag)) return true;
  const role = attributes.find(
    (attribute) => attributeName(attribute, sourceFile) === "role",
  );
  const roleValue = staticAttributeValue(role, sourceFile);
  if (roleValue && INTERACTIVE_ROLE.test(roleValue)) return true;
  return attributes.some((attribute) =>
    INTERACTION_ATTRIBUTES.has(attributeName(attribute, sourceFile)),
  );
}

export function inventoryIntrinsicTitles(root = ROOT) {
  const findings = [];
  for (const path of productionTsxFiles(root)) {
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
        if (/^[a-z]/u.test(tag)) {
          const attributes = node.attributes.properties;
          const title = attributes.find(
            (attribute) => attributeName(attribute, sourceFile) === "title",
          );
          if (title) {
            const point = sourceFile.getLineAndCharacterOfPosition(
              title.getStart(),
            );
            findings.push({
              file: relative(root, path),
              line: point.line + 1,
              tag,
              title:
                staticAttributeValue(title, sourceFile) ?? "<boolean title>",
              interactive: isInteractive(tag, attributes, sourceFile),
              disabled: attributes.some((attribute) =>
                ["aria-disabled", "disabled"].includes(
                  attributeName(attribute, sourceFile),
                ),
              ),
            });
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return findings;
}

export function inventory(root = ROOT) {
  return inventoryIntrinsicTitles(root)
    .filter((finding) => finding.interactive)
    .map(({ interactive: _interactive, ...finding }) => finding);
}

export function summarize(findings) {
  const owners = new Map();
  for (const finding of findings) {
    const current = owners.get(finding.file) ?? { total: 0, disabled: 0 };
    current.total += 1;
    if (finding.disabled) current.disabled += 1;
    owners.set(finding.file, current);
  }
  return [...owners.entries()]
    .map(([file, count]) => ({ file, ...count }))
    .sort(
      (left, right) =>
        right.total - left.total ||
        right.disabled - left.disabled ||
        left.file.localeCompare(right.file),
    );
}

export function inventorySummary(root = ROOT) {
  const intrinsicFindings = inventoryIntrinsicTitles(root);
  const findings = intrinsicFindings
    .filter((finding) => finding.interactive)
    .map(({ interactive: _interactive, ...finding }) => finding);
  const nonInteractiveFindings = intrinsicFindings.filter(
    (finding) => !finding.interactive,
  );
  return {
    intrinsicTitleAttributes: intrinsicFindings.length,
    interactiveTitleAttributes: findings.length,
    nonInteractiveTitleAttributes: nonInteractiveFindings.length,
    disabledInteractiveTitleAttributes: findings.filter((item) => item.disabled)
      .length,
    intrinsicOwnerCount: new Set(intrinsicFindings.map((item) => item.file))
      .size,
    ownerCount: new Set(findings.map((item) => item.file)).size,
    owners: summarize(findings),
    findings,
    nonInteractiveFindings,
  };
}

if (fileURLToPath(import.meta.url) === resolve(process.argv[1] ?? "")) {
  const summary = inventorySummary();
  if (process.argv.includes("--write-budget")) {
    const budgetPath = resolve(
      import.meta.dirname,
      "interactive-title-budgets.json",
    );
    const budgets = Object.fromEntries(
      summary.owners
        .map((owner) => [
          owner.file,
          { disabled: owner.disabled, total: owner.total },
        ])
        .sort(([left], [right]) => left.localeCompare(right)),
    );
    writeFileSync(
      budgetPath,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          policy:
            "Exact per-owner inventory. Reduce intentionally; never add or transfer interactive native title debt.",
          budgets,
        },
        null,
        2,
      )}\n`,
    );
    process.stdout.write(`Wrote ${relative(process.cwd(), budgetPath)}\n`);
  } else if (process.argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  } else {
    process.stdout.write(
      [
        `All intrinsic native title attributes: ${summary.intrinsicTitleAttributes}`,
        `Interactive native title attributes: ${summary.interactiveTitleAttributes}`,
        `Non-interactive native title attributes: ${summary.nonInteractiveTitleAttributes}`,
        `On potentially disabled controls: ${summary.disabledInteractiveTitleAttributes}`,
        `Production owners: ${summary.ownerCount}`,
        "",
        ...summary.owners.map(
          (owner) =>
            `${owner.file}: ${owner.total} (${owner.disabled} potentially disabled)`,
        ),
        "",
      ].join("\n"),
    );
  }

  if (
    process.argv.includes("--fail-on-any") &&
    summary.interactiveTitleAttributes > 0
  ) {
    process.exitCode = 1;
  }
}
