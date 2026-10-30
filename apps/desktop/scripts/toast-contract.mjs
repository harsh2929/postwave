import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

const ALLOWED_METHODS = new Set([
  "success",
  "error",
  "info",
  "soon",
  "progress",
  "critical",
  "resolveCritical",
]);
const CONTROL_RE = /[\u0000-\u001f\u007f]/u;

function propertyName(node) {
  if (!node) return null;
  if (ts.isIdentifier(node) || ts.isStringLiteral(node)) return node.text;
  return null;
}

function isToastModule(specifier) {
  return /(?:^|\/)Toast$/u.test(specifier);
}

function lineOf(sourceFile, node) {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

function objectProperty(object, name) {
  if (!object || !ts.isObjectLiteralExpression(object)) return null;
  return (
    object.properties.find(
      (candidate) =>
        ts.isPropertyAssignment(candidate) &&
        propertyName(candidate.name) === name,
    ) ?? null
  );
}

function isZero(expression) {
  return ts.isNumericLiteral(expression) && Number(expression.text) === 0;
}

function isTrue(expression) {
  return expression.kind === ts.SyntaxKind.TrueKeyword;
}

function validateCall(call, method, catalogCodes, sourceFile, findings) {
  const location = `${sourceFile.fileName}:${lineOf(sourceFile, call)}`;
  if (!ALLOWED_METHODS.has(method)) {
    findings.push(`${location}: unsupported toast method ${method}`);
    return;
  }
  const first = call.arguments[0];
  if (method === "critical" || method === "resolveCritical") {
    if (!first || !ts.isStringLiteral(first)) {
      findings.push(`${location}: toast.${method} requires a literal catalog code`);
    } else if (!catalogCodes.has(first.text)) {
      findings.push(`${location}: unknown critical notice code ${first.text}`);
    }
    if (call.arguments.length !== 1) {
      findings.push(`${location}: toast.${method} accepts exactly one code argument`);
    }
    return;
  }
  if (!first) {
    findings.push(`${location}: toast.${method} requires notice input`);
    return;
  }
  const persistent = objectProperty(first, "persistent");
  if (persistent && isTrue(persistent.initializer)) {
    findings.push(
      `${location}: arbitrary persistent copy is forbidden; use toast.critical(catalogCode)`,
    );
  }
  const duration = objectProperty(first, "duration");
  if (duration && isZero(duration.initializer)) {
    findings.push(
      `${location}: duration 0 bypasses critical classification; use toast.critical(catalogCode)`,
    );
  }
}

export function auditToastSourceText({
  sourceText,
  fileName,
  catalogCodes,
}) {
  const sourceFile = ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const bindings = new Set();
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    if (!ts.isStringLiteral(statement.moduleSpecifier)) continue;
    if (!isToastModule(statement.moduleSpecifier.text)) continue;
    const imports = statement.importClause?.namedBindings;
    if (!imports || !ts.isNamedImports(imports)) continue;
    for (const element of imports.elements) {
      if ((element.propertyName ?? element.name).text === "toast") {
        bindings.add(element.name.text);
      }
    }
  }

  const findings = [];
  const calls = [];
  const handledIdentifiers = new Set();
  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      bindings.has(node.expression.expression.text)
    ) {
      const method = node.expression.name.text;
      handledIdentifiers.add(node.expression.expression);
      calls.push({
        file: fileName,
        line: lineOf(sourceFile, node),
        method,
      });
      validateCall(node, method, catalogCodes, sourceFile, findings);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  const inspectUse = (node) => {
    if (ts.isIdentifier(node) && bindings.has(node.text)) {
      if (
        handledIdentifiers.has(node) ||
        ts.isImportSpecifier(node.parent)
      ) {
        // Direct method calls and their import declarations are covered.
      } else {
        findings.push(
          `${sourceFile.fileName}:${lineOf(sourceFile, node)}: toast must be called directly; aliases/destructuring bypass classification`,
        );
      }
    }
    ts.forEachChild(node, inspectUse);
  };
  inspectUse(sourceFile);
  return { calls, findings };
}

export function validateCriticalNoticeCatalog(catalog) {
  const findings = [];
  if (!catalog || typeof catalog !== "object" || Array.isArray(catalog)) {
    return ["critical notice catalog must be an object"];
  }
  for (const [code, copy] of Object.entries(catalog)) {
    if (!/^[a-z][a-z0-9-]{2,79}$/u.test(code)) {
      findings.push(`invalid critical notice code ${code}`);
    }
    if (!copy || typeof copy !== "object" || Array.isArray(copy)) {
      findings.push(`${code}: catalog entry must be an object`);
      continue;
    }
    for (const [field, max] of [
      ["message", 120],
      ["detail", 280],
    ]) {
      const value = copy[field];
      if (
        typeof value !== "string" ||
        value.length === 0 ||
        value.length > max ||
        value.trim() !== value ||
        CONTROL_RE.test(value)
      ) {
        findings.push(`${code}: ${field} must be clean, trimmed, and <= ${max} characters`);
      }
    }
    const unknown = Object.keys(copy).filter(
      (field) => field !== "message" && field !== "detail",
    );
    if (unknown.length > 0) {
      findings.push(`${code}: unsupported catalog fields ${unknown.join(", ")}`);
    }
  }
  return findings;
}

async function sourceFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "__tests__") files.push(...(await sourceFiles(absolute)));
      continue;
    }
    if (!/\.(?:ts|tsx)$/u.test(entry.name)) continue;
    if (/\.(?:test|stories)\.(?:ts|tsx)$/u.test(entry.name)) continue;
    files.push(absolute);
  }
  return files.sort();
}

export async function auditToastCallers({ sourceRoot, catalogPath }) {
  const catalog = JSON.parse(await readFile(catalogPath, "utf8"));
  const catalogFindings = validateCriticalNoticeCatalog(catalog);
  const catalogCodes = new Set(Object.keys(catalog));
  const calls = [];
  const findings = [...catalogFindings];
  for (const file of await sourceFiles(sourceRoot)) {
    const result = auditToastSourceText({
      sourceText: await readFile(file, "utf8"),
      fileName: path.relative(path.dirname(sourceRoot), file),
      catalogCodes,
    });
    calls.push(...result.calls);
    findings.push(...result.findings);
  }
  return { calls, findings: findings.sort() };
}

function summarize(calls) {
  const counts = new Map([...ALLOWED_METHODS].map((method) => [method, 0]));
  for (const call of calls) counts.set(call.method, (counts.get(call.method) ?? 0) + 1);
  const modules = new Set(calls.map((call) => call.file)).size;
  const detail = [...counts].map(([method, count]) => `${method}=${count}`).join(", ");
  return `${calls.length} calls across ${modules} production modules (${detail})`;
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) {
  const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
  const desktopRoot = path.dirname(scriptDirectory);
  const result = await auditToastCallers({
    sourceRoot: path.join(desktopRoot, "src"),
    catalogPath: path.join(
      desktopRoot,
      "src/lib/toast-critical-notice-catalog.json",
    ),
  });
  if (result.findings.length > 0) {
    console.error(["Toast contract failed:", ...result.findings].join("\n"));
    process.exitCode = 1;
  } else {
    console.log(`Toast contract OK: ${summarize(result.calls)}.`);
  }
}
