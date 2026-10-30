#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const specPath = resolve(here, "..", "openapi.yaml");
const check = process.argv.includes("--check");

const input = readFileSync(specPath, "utf8");
const descriptionResult = addMissingOperationDescriptions(input);
const tagResult = addMissingTagDefinitions(descriptionResult.output);
const output = tagResult.output;

if (check) {
  if (output !== input) {
    console.error(
      `openapi metadata is incomplete: ${descriptionResult.added} operation description(s), ` +
        `${tagResult.added} tag definition(s) would be added.`,
    );
    process.exit(1);
  }
  console.log("openapi metadata is complete.");
  process.exit(0);
}

if (output !== input) writeFileSync(specPath, output, "utf8");
console.log(
  `openapi metadata: added ${descriptionResult.added} operation description(s) and ` +
    `${tagResult.added} tag definition(s).`,
);

function addMissingOperationDescriptions(source) {
  const lines = source.split(/\r?\n/u);
  const insertions = [];
  let inPaths = false;
  let currentPath = "";
  let operation = null;

  const finishOperation = () => {
    if (!operation || operation.hasDescription) {
      operation = null;
      return;
    }
    const at = operation.insertAt ?? operation.fallbackAt;
    if (at === undefined) {
      throw new Error(
        `cannot place description for ${operation.method.toUpperCase()} ${operation.path}`,
      );
    }
    insertions.push({
      at,
      lines: [
        "      description: |",
        `        ${operationDescription(operation.method, operation.path)}`,
      ],
    });
    operation = null;
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const indent = line.match(/^(\s*)/u)?.[1].length ?? 0;
    const trimmed = line.trim();

    if (!inPaths) {
      if (trimmed === "paths:" && indent === 0) inPaths = true;
      continue;
    }
    if (trimmed && indent === 0) {
      finishOperation();
      break;
    }

    const pathMatch = line.match(/^ {2}(\/\S+):\s*$/u);
    if (pathMatch) {
      finishOperation();
      currentPath = pathMatch[1];
      continue;
    }

    const methodMatch = line.match(
      /^ {4}(get|post|put|patch|delete|head|options|trace):\s*$/iu,
    );
    if (methodMatch) {
      finishOperation();
      operation = {
        method: methodMatch[1].toLowerCase(),
        path: currentPath,
        hasDescription: false,
        insertAt: undefined,
        fallbackAt: undefined,
      };
      continue;
    }

    if (!operation) continue;
    if (trimmed && indent <= 4) {
      finishOperation();
      continue;
    }
    if (/^ {6}description:\s*/u.test(line)) {
      operation.hasDescription = true;
    }
    if (
      operation.insertAt === undefined &&
      /^ {6}(?:tags|security|x-required-scopes|x-required-scope-mode|x-postwave-source|parameters|requestBody|responses):/u.test(
        line,
      )
    ) {
      operation.insertAt = index;
    }
    if (operation.fallbackAt === undefined && /^ {6}\S/u.test(line)) {
      operation.fallbackAt = index + 1;
    }
  }
  finishOperation();

  for (const insertion of insertions.sort((a, b) => b.at - a.at)) {
    lines.splice(insertion.at, 0, ...insertion.lines);
  }
  return { output: lines.join("\n"), added: insertions.length };
}

function operationDescription(method, path) {
  const route = `\`${method.toUpperCase()} ${path}\``;
  switch (method) {
    case "get":
    case "head":
      return `Retrieves the current representation exposed by ${route}.`;
    case "post":
      return `Executes the operation exposed by ${route}.`;
    case "put":
      return `Creates or replaces the representation addressed by ${route}.`;
    case "patch":
      return `Applies a partial update through ${route}.`;
    case "delete":
      return `Deletes or deactivates the resource addressed by ${route}.`;
    case "options":
      return `Returns protocol capabilities for ${route}.`;
    default:
      return `Implements the ${route} API operation.`;
  }
}

function addMissingTagDefinitions(source) {
  const lines = source.split(/\r?\n/u);
  const defined = new Set();
  const used = new Set();
  let inGlobalTags = false;
  let inPaths = false;
  let tagsEnd = -1;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();
    const indent = line.match(/^(\s*)/u)?.[1].length ?? 0;

    if (trimmed === "tags:" && indent === 0) {
      inGlobalTags = true;
      continue;
    }
    if (inGlobalTags && trimmed && indent === 0) {
      inGlobalTags = false;
      tagsEnd = index;
    }
    if (inGlobalTags) {
      const definition = line.match(/^ {2}- name:\s*(.+?)\s*$/u);
      if (definition) defined.add(unquote(definition[1]));
      continue;
    }

    if (trimmed === "paths:" && indent === 0) {
      inPaths = true;
      continue;
    }
    if (inPaths && trimmed && indent === 0) {
      inPaths = false;
    }
    if (!inPaths) continue;

    const inline = line.match(/^ {6}tags:\s*\[(.*)\]\s*$/u);
    if (inline) {
      for (const rawTag of inline[1].split(",")) {
        const tag = unquote(rawTag.trim());
        if (tag) used.add(tag);
      }
    }
  }

  if (tagsEnd < 0)
    throw new Error("cannot find the end of the global tags block");
  const missing = [...used].filter((tag) => !defined.has(tag)).sort();
  if (missing.length === 0) return { output: source, added: 0 };

  const additions = missing.flatMap((tag) => [
    `  - name: ${JSON.stringify(tag)}`,
    `    description: ${JSON.stringify(`${tag} API operations.`)}`,
  ]);
  lines.splice(tagsEnd, 0, ...additions);
  return { output: lines.join("\n"), added: missing.length };
}

function unquote(value) {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}
