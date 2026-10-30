#!/usr/bin/env node

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(scriptDir, "..");
const defaultBaselinePath = join(scriptDir, "source-budgets.json");

// `--baseline <path>` checks the tree against another baseline file; the
// ratchet's own test drives the CLI this way. A flag without a path is a usage
// error rather than a silent fall-back to the committed file.
function baselinePathFromArgs(args) {
  const flag = args.indexOf("--baseline");
  if (flag === -1) return defaultBaselinePath;
  const value = args[flag + 1];
  if (value === undefined || value.startsWith("--")) {
    console.error(
      "[postwave-mobile] usage: check-source-budgets.mjs [--print-baseline] [--baseline <path>]",
    );
    process.exit(2);
  }
  return resolve(value);
}

const baselinePath = baselinePathFromArgs(process.argv.slice(2));
const baselineLabel =
  baselinePath === defaultBaselinePath
    ? "scripts/source-budgets.json"
    : baselinePath;
const hardLimits = Object.freeze({
  fileLines: 450,
  functionLines: 300,
  cyclomaticComplexity: 25,
});

function sourceFiles(root) {
  const result = [];
  for (const entry of readdirSync(root).sort()) {
    const absolute = join(root, entry);
    const stat = statSync(absolute);
    if (stat.isDirectory()) {
      result.push(...sourceFiles(absolute));
      continue;
    }
    if (![".ts", ".tsx"].includes(extname(entry))) continue;
    if (/\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(entry)) continue;
    if (entry.endsWith(".d.ts")) continue;
    result.push(absolute);
  }
  return result;
}

function isFunctionLike(node) {
  return (
    ts.isArrowFunction(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  );
}

function functionName(node, source) {
  if (node.name && ts.isIdentifier(node.name)) return node.name.text;
  const parent = node.parent;
  if (
    parent &&
    ts.isVariableDeclaration(parent) &&
    ts.isIdentifier(parent.name)
  ) {
    return parent.name.text;
  }
  if (parent && ts.isPropertyAssignment(parent)) {
    return parent.name.getText(source);
  }
  return "<anonymous>";
}

function complexityOf(root) {
  let complexity = 1;
  function visit(node) {
    if (node !== root && isFunctionLike(node)) return;
    if (
      ts.isIfStatement(node) ||
      ts.isForStatement(node) ||
      ts.isForInStatement(node) ||
      ts.isForOfStatement(node) ||
      ts.isWhileStatement(node) ||
      ts.isDoStatement(node) ||
      ts.isCatchClause(node) ||
      ts.isConditionalExpression(node) ||
      ts.isCaseClause(node)
    ) {
      complexity += 1;
    } else if (
      ts.isBinaryExpression(node) &&
      [
        ts.SyntaxKind.AmpersandAmpersandToken,
        ts.SyntaxKind.BarBarToken,
        ts.SyntaxKind.QuestionQuestionToken,
      ].includes(node.operatorToken.kind)
    ) {
      complexity += 1;
    }
    ts.forEachChild(node, visit);
  }
  if (root.body) visit(root.body);
  return complexity;
}

function inspectFile(absolute) {
  const text = readFileSync(absolute, "utf8");
  const source = ts.createSourceFile(
    absolute,
    text,
    ts.ScriptTarget.Latest,
    true,
    absolute.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const functions = [];
  function visit(node) {
    if (isFunctionLike(node)) {
      const start = source.getLineAndCharacterOfPosition(node.getStart(source));
      const end = source.getLineAndCharacterOfPosition(node.end);
      functions.push({
        name: functionName(node, source),
        line: start.line + 1,
        lines: end.line - start.line + 1,
        complexity: complexityOf(node),
      });
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return {
    path: relative(appRoot, absolute).split(sep).join("/"),
    lines: text === "" ? 0 : text.split(/\r?\n/u).length,
    functions,
    text,
  };
}

function legacyFunctionDebt(file) {
  const long = file.functions.filter(
    (item) => item.lines > hardLimits.functionLines,
  );
  const complex = file.functions.filter(
    (item) => item.complexity > hardLimits.cyclomaticComplexity,
  );
  return {
    longCount: long.length,
    lineExcess: long.reduce(
      (sum, item) => sum + item.lines - hardLimits.functionLines,
      0,
    ),
    maxLines: Math.max(0, ...long.map((item) => item.lines)),
    complexCount: complex.length,
    complexityExcess: complex.reduce(
      (sum, item) => sum + item.complexity - hardLimits.cyclomaticComplexity,
      0,
    ),
    maxComplexity: Math.max(0, ...complex.map((item) => item.complexity)),
  };
}

function makeBaseline(files) {
  const legacyFiles = {};
  const legacyFunctions = {};
  for (const file of files) {
    if (file.lines > hardLimits.fileLines) legacyFiles[file.path] = file.lines;
    const debt = legacyFunctionDebt(file);
    if (debt.longCount > 0 || debt.complexCount > 0) {
      legacyFunctions[file.path] = debt;
    }
  }
  return {
    schemaVersion: 1,
    hardLimits,
    legacyFiles,
    legacyFunctions,
  };
}

const files = [join(appRoot, "app"), join(appRoot, "src")]
  .flatMap(sourceFiles)
  .map(inspectFile);

if (process.argv.includes("--print-baseline")) {
  process.stdout.write(`${JSON.stringify(makeBaseline(files), null, 2)}\n`);
  process.exit(0);
}

const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
const errors = [];

if (JSON.stringify(baseline.hardLimits) !== JSON.stringify(hardLimits)) {
  errors.push(
    "source-budgets.json hardLimits drifted from the executable policy",
  );
}

for (const file of files) {
  const legacyFileLimit = baseline.legacyFiles[file.path];
  const allowedFileLines = legacyFileLimit ?? hardLimits.fileLines;
  if (file.lines > allowedFileLines) {
    errors.push(
      `${file.path}: ${file.lines} lines exceeds its ${allowedFileLines}-line ceiling`,
    );
  }
  // The ratchet is exact: an allowance above the measured size is slack a later
  // change could spend without failing. At or under the hard limit the entry is
  // stale instead (reported below), so it is dropped rather than lowered.
  if (
    legacyFileLimit !== undefined &&
    file.lines > hardLimits.fileLines &&
    file.lines < legacyFileLimit
  ) {
    errors.push(
      `${file.path}: ${file.lines} lines is under its ${legacyFileLimit}-line allowance; lower legacyFiles["${file.path}"] to ${file.lines} in ${baselineLabel}`,
    );
  }

  const debt = legacyFunctionDebt(file);
  const allowedDebt = baseline.legacyFunctions[file.path];
  if (!allowedDebt) {
    for (const item of file.functions) {
      if (item.lines > hardLimits.functionLines) {
        errors.push(
          `${file.path}:${item.line} ${item.name} spans ${item.lines} lines (limit ${hardLimits.functionLines})`,
        );
      }
      if (item.complexity > hardLimits.cyclomaticComplexity) {
        errors.push(
          `${file.path}:${item.line} ${item.name} has cyclomatic complexity ${item.complexity} (limit ${hardLimits.cyclomaticComplexity})`,
        );
      }
    }
  } else {
    // A fully paid-off entry gets the "now clean; remove" error below instead
    // of one "lower it to 0" line per metric.
    const stillInDebt = debt.longCount > 0 || debt.complexCount > 0;
    for (const metric of [
      "longCount",
      "lineExcess",
      "maxLines",
      "complexCount",
      "complexityExcess",
      "maxComplexity",
    ]) {
      if (debt[metric] > allowedDebt[metric]) {
        errors.push(
          `${file.path}: legacy function debt ${metric} increased from ${allowedDebt[metric]} to ${debt[metric]}`,
        );
      }
      if (stillInDebt && debt[metric] < allowedDebt[metric]) {
        errors.push(
          `${file.path}: legacy function debt ${metric} fell from ${allowedDebt[metric]} to ${debt[metric]}; lower legacyFunctions["${file.path}"].${metric} to ${debt[metric]} in ${baselineLabel}`,
        );
      }
    }
  }

  if (
    /\bclient\s+as\s+(?:any|unknown\s+as)[\s\S]{0,240}?\.request|\bas\s+any\s*\)\s*\.request/u.test(
      file.text,
    )
  ) {
    errors.push(
      `${file.path}: untyped SDK transport escape detected; use client.request<Response>() or a typed resource`,
    );
  }
}

const currentPaths = new Set(files.map((file) => file.path));
for (const path of Object.keys(baseline.legacyFiles)) {
  const file = files.find((item) => item.path === path);
  if (!file || file.lines <= hardLimits.fileLines) {
    errors.push(
      `${path}: stale legacy file allowance; remove it from source-budgets.json`,
    );
  }
}
for (const path of Object.keys(baseline.legacyFunctions)) {
  const file = files.find((item) => item.path === path);
  if (!file || !currentPaths.has(path)) {
    errors.push(
      `${path}: stale legacy function allowance; remove it from source-budgets.json`,
    );
    continue;
  }
  const debt = legacyFunctionDebt(file);
  if (debt.longCount === 0 && debt.complexCount === 0) {
    errors.push(
      `${path}: function debt is now clean; remove its legacy allowance`,
    );
  }
}

if (errors.length > 0) {
  console.error("[postwave-mobile] source quality budget failed:");
  for (const error of errors) console.error(`- ${error}`);
  console.error(
    `Refactor the reported source. When a cleanup lowers a value, set it in ${baselineLabel} to the reported number; never raise one.`,
  );
  process.exit(1);
}

const legacyFileCount = Object.keys(baseline.legacyFiles).length;
const legacyFunctionFileCount = Object.keys(baseline.legacyFunctions).length;
console.log(
  `[postwave-mobile] source budgets pass (${files.length} production files; ${legacyFileCount} file and ${legacyFunctionFileCount} function-debt ratchets).`,
);
