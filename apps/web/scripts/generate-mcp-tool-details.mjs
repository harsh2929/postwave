// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(scriptsDir, "..");
const repoRoot = path.resolve(webRoot, "../..");
const catalogPath = path.join(webRoot, "src/lib/mcp-tools.json");
const apiCatalogPath = path.join(
  repoRoot,
  "apps/api/internal/apikeycalls/tool-catalog.json",
);
const outputPath = path.join(
  webRoot,
  "src/lib/mcp-tool-details.generated.json",
);
const toolsDir = path.join(repoRoot, "packages/mcp-server/src/tools");
const maxToolSourceBytes = 256 * 1024;

function parseToolFile(filePath, fileName) {
  if (statSync(filePath).size > maxToolSourceBytes) {
    throw new Error(`${fileName} exceeds ${maxToolSourceBytes} bytes`);
  }
  const sourceText = readFileSync(filePath, "utf8");
  const matches = [...sourceText.matchAll(/name:\s*"([^"]+)"/gu)].map(
    (match) => ({ name: match[1], index: match.index }),
  );
  const tools = [];

  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    const next = matches[index + 1];
    const block = sourceText.slice(
      match.index,
      next?.index ?? sourceText.length,
    );
    const descriptionMatch =
      /description:\s*((?:`[^`]*`|"(?:[^"\\]|\\.)*"(?:\s*\+\s*"(?:[^"\\]|\\.)*")*|'(?:[^'\\]|\\.)*'(?:\s*\+\s*'(?:[^'\\]|\\.)*')*))/mu.exec(
        block,
      );
    const description = descriptionMatch
      ? descriptionMatch[1]
          .replace(/^`|`$/gu, "")
          .replace(/"\s*\+\s*"/gu, "")
          .replace(/^"|"$/gu, "")
          .replace(/'\s*\+\s*'/gu, "")
          .replace(/^'|'$/gu, "")
          .replace(/\\"/gu, '"')
          .replace(/\\'/gu, "'")
          .replace(/\\n/gu, " ")
          .replace(/\s+/gu, " ")
          .trim()
      : "";

    const schemaIndex = block.search(
      /schema:\s*z\s*\.\s*object\s*\(\s*\{/u,
    );
    let schemaBody = "";
    if (schemaIndex >= 0) {
      const schemaText = block.slice(schemaIndex);
      const open = schemaText.indexOf("{");
      let depth = 0;
      for (let offset = open; offset < schemaText.length; offset += 1) {
        const character = schemaText[offset];
        if (character === "{") depth += 1;
        if (character === "}") {
          depth -= 1;
          if (depth === 0) {
            schemaBody = schemaText.slice(open + 1, offset);
            break;
          }
        }
      }
    }

    tools.push({
      name: match.name,
      description,
      schemaBody,
      hasCustomTimeout: /timeoutMs:\s*\d+_?\d*/u.test(block),
      source: `tools/${fileName}`,
      aliases: collectSchemaAliases(sourceText),
    });
  }

  return tools;
}

/**
 * Module-local Zod aliases, e.g. `const MigrationJobId = z.string().trim()…`.
 *
 * Field kinds were inferred by matching `z.string(` / `z.enum(` directly in the
 * field expression, so anything declared through an alias fell through to
 * "unknown" — 109 fields, the second-most-common kind, including 14 required
 * `source: SourceEnum` and 22 `MigrationJobId`. The skill pages build their
 * example invocation from those kinds, so every one of them rendered the
 * required argument as `null`: a copy-pasteable call that cannot succeed.
 *
 * One level of resolution is enough for every alias in use; aliases defined in
 * terms of other aliases would still read as unknown, which is the honest
 * answer rather than a guess.
 */
function collectSchemaAliases(sourceText) {
  const aliases = new Map();
  for (const m of sourceText.matchAll(
    /^const ([A-Z][A-Za-z0-9_]*)\s*=\s*([\s\S]*?);\s*$/gmu,
  )) {
    aliases.set(m[1], m[2]);
  }
  return aliases;
}

function parseSchemaFields(schemaBody, aliases = new Map()) {
  if (!schemaBody) return [];
  const segments = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < schemaBody.length; index += 1) {
    const character = schemaBody[index];
    if ("{([".includes(character)) depth += 1;
    if ("})]".includes(character)) depth -= 1;
    if (character === "," && depth === 0) {
      segments.push(schemaBody.slice(start, index));
      start = index + 1;
    }
  }
  if (start < schemaBody.length) segments.push(schemaBody.slice(start));

  return segments.flatMap((raw) => {
    const field = /^([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*([\s\S]+)$/u.exec(
      raw.trim(),
    );
    if (!field) return [];
    const [, name, rawExpression] = field;
    // Substitute a module-local alias for its definition so the kind rules
    // below see the underlying z.* call. The original expression is kept for
    // .describe() extraction, which belongs to the field, not the alias.
    const aliasName = /^([A-Z][A-Za-z0-9_]*)\b/u.exec(rawExpression.trim())?.[1];
    const expression =
      aliasName && aliases.has(aliasName)
        ? `${aliases.get(aliasName)}${rawExpression.trim().slice(aliasName.length)}`
        : rawExpression;
    let kind = "unknown";
    let enumValues;
    if (/z\s*\.\s*string\s*\(/u.test(expression)) kind = "string";
    else if (/z\s*\.\s*number\s*\(/u.test(expression)) kind = "number";
    else if (/z\s*\.\s*boolean\s*\(/u.test(expression)) kind = "boolean";
    else if (/z\s*\.\s*array\s*\(/u.test(expression)) kind = "array";
    else if (/z\s*\.\s*(?:object|record)\s*\(/u.test(expression))
      kind = "object";
    else if (/z\s*\.\s*union\s*\(/u.test(expression)) kind = "union";
    // z.literal(true) — the migration tools' ExplicitApproval gate. Nine
    // required `confirm` fields resolved to "unknown" and so rendered as null
    // in the example invocation, when the schema accepts exactly one value.
    else if (/z\s*\.\s*literal\s*\(/u.test(expression)) {
      kind = "literal";
      const literal = /z\s*\.\s*literal\s*\(\s*([^)]+?)\s*\)/u.exec(expression);
      if (literal) enumValues = [literal[1].replace(/^["']|["']$/gu, "")];
    }
    else if (
      /z\s*\.\s*enum\s*\(/u.test(expression) ||
      /Enum\b/u.test(expression)
    ) {
      kind = "enum";
      const enumMatch = /z\s*\.\s*enum\s*\(\s*\[([^\]]+)\]/u.exec(expression);
      if (enumMatch) {
        enumValues = enumMatch[1]
          .split(",")
          .map((value) => value.trim().replace(/^["']|["']$/gu, ""))
          .filter(Boolean);
      }
    }
    const description =
      /\.describe\(\s*["`]([^"`]+)["`]\s*\)/u.exec(rawExpression)?.[1] ??
      /\.describe\(\s*["`]([^"`]+)["`]\s*\)/u.exec(expression)?.[1];
    return [
      {
        name,
        kind,
        optional:
          /\.optional\(\)/u.test(expression) || /\.default\(/u.test(expression),
        ...(description ? { description } : {}),
        ...(enumValues?.length ? { enumValues } : {}),
      },
    ];
  });
}

const catalog = JSON.parse(readFileSync(catalogPath, "utf8"));
const catalogRendered = `${JSON.stringify(catalog, null, 2)}\n`;
const rawTools = new Map();
for (const fileName of readdirSync(toolsDir).sort()) {
  if (!fileName.endsWith(".ts") || fileName === "index.ts") continue;
  for (const tool of parseToolFile(path.join(toolsDir, fileName), fileName)) {
    if (rawTools.has(tool.name)) {
      throw new Error(`duplicate MCP tool definition: ${tool.name}`);
    }
    rawTools.set(tool.name, tool);
  }
}

const missing = catalog
  .map(({ name }) => name)
  .filter((name) => !rawTools.has(name));
if (missing.length > 0) {
  throw new Error(
    `catalog tools missing source definitions: ${missing.join(", ")}`,
  );
}

const catalogNames = new Set(catalog.map(({ name }) => name));
const undocumented = [...rawTools.keys()].filter(
  (name) => !catalogNames.has(name),
);
if (undocumented.length > 0) {
  throw new Error(
    `source tools missing catalog entries: ${undocumented.join(", ")}`,
  );
}

const details = catalog.map((entry) => {
  const raw = rawTools.get(entry.name);
  return {
    ...entry,
    fullDescription: raw.description || entry.description,
    inputFields: parseSchemaFields(raw.schemaBody, raw.aliases),
    hasCustomTimeout: raw.hasCustomTimeout,
    source: raw.source,
    slug: entry.name.replace(/_/gu, "-").toLowerCase(),
  };
});
const rendered = `${JSON.stringify(details, null, 2)}\n`;

if (process.argv.includes("--check")) {
  const current = readFileSync(outputPath, "utf8");
  const currentApiCatalog = readFileSync(apiCatalogPath, "utf8");
  if (current !== rendered || currentApiCatalog !== catalogRendered) {
    process.stderr.write(
      "MCP tool catalogs are stale; run pnpm --filter @postwave/web mcp-catalog:generate.\n",
    );
    process.exit(1);
  }
  process.stdout.write(
    `MCP tool detail catalog OK (${details.length} tools)\n`,
  );
} else {
  writeFileSync(outputPath, rendered);
  writeFileSync(apiCatalogPath, catalogRendered);
  process.stdout.write(
    `Wrote ${outputPath} and ${apiCatalogPath} (${details.length} tools)\n`,
  );
}
