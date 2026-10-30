import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(scriptDirectory, "..");

const LEGACY_CLASS_PATTERNS = {
  legacyNoticeClass:
    /className\s*=\s*(?:\{\s*)?["'`]notice(?:\s|["'`])/g,
  legacyAlertClass:
    /className\s*=\s*(?:\{\s*)?["'`]alert(?:\s|["'`])/g,
  legacyCalloutClass:
    /className\s*=\s*(?:\{\s*)?["'`]callout(?:\s|["'`])/g,
  legacyCardClass: /className\s*=\s*(?:\{\s*)?["'`]card(?:\s|["'`])/g,
  rawSkeletonClass: /className\s*=\s*(?:\{\s*)?["'`]skel(?:\s|["'`])/g,
};

const INLINE_SEMANTIC_PROPERTY =
  /\b(background(?:Color|Image)?|border(?:Color|Radius|Top|Right|Bottom|Left)?|boxShadow|color)\s*:/g;

function occurrences(source, pattern) {
  pattern.lastIndex = 0;
  return Array.from(source.matchAll(pattern)).length;
}

function matchingException(manifest, relativePath, line) {
  return manifest.inlineSemanticStyleExceptions.find(
    (entry) => entry.source === relativePath && line.includes(entry.contains),
  );
}

/** Pure collector used by the executable check and its focused unit tests. */
export function collectDesignSystemFindings(sourceMap, manifest) {
  const findings = [];
  if (manifest.schemaVersion !== 1) {
    findings.push("design-system manifest schemaVersion must be 1");
  }
  for (const key of ["governedSources", "primitiveSources", "storySources"]) {
    const entries = manifest[key] ?? [];
    if (new Set(entries).size !== entries.length) {
      findings.push(`${key} contains duplicate source paths`);
    }
  }
  const exceptionKeys = manifest.inlineSemanticStyleExceptions.map(
    (entry) => `${entry.source}\u0000${entry.contains}`,
  );
  if (new Set(exceptionKeys).size !== exceptionKeys.length) {
    findings.push("inlineSemanticStyleExceptions contains duplicate entries");
  }
  const skeletonOwnerPaths = (manifest.skeletonGroupOwners ?? []).map(
    (entry) => entry.source,
  );
  if (new Set(skeletonOwnerPaths).size !== skeletonOwnerPaths.length) {
    findings.push("skeletonGroupOwners contains duplicate source paths");
  }

  for (const [name, pattern] of Object.entries(LEGACY_CLASS_PATTERNS)) {
    const actual = Array.from(sourceMap.values()).reduce(
      (total, source) => total + occurrences(source, pattern),
      0,
    );
    const expected = manifest.legacyClassBudgets[name];
    if (!Number.isInteger(expected)) {
      findings.push(`legacyClassBudgets.${name} is missing an integer budget`);
    } else if (actual > expected) {
      findings.push(`${name} grew to ${actual}; reviewed maximum is ${expected}`);
    } else if (actual < expected) {
      findings.push(`${name} shrank to ${actual}; ratchet the manifest down from ${expected}`);
    }
  }

  for (const [relativePath, source] of sourceMap) {
    if (relativePath.startsWith("stories/")) continue;
    for (const tag of source.match(/<[A-Za-z][^>]*>/g) ?? []) {
      if (
        /className\s*=\s*(?:\{\s*)?["'`][^"'`]*\bcard\b/.test(tag) &&
        /role\s*=\s*["']button["']/.test(tag)
      ) {
        findings.push(
          `${relativePath} contains an interactive legacy Card wrapper; use an explicit named control inside Card`,
        );
      }
    }
  }

  const exceptionUse = new Map();
  for (const relativePath of manifest.governedSources) {
    const source = sourceMap.get(relativePath);
    if (source == null) {
      findings.push(`governed source is missing: ${relativePath}`);
      continue;
    }

    for (const [lineIndex, line] of source.split(/\r\n|\r|\n/).entries()) {
      INLINE_SEMANTIC_PROPERTY.lastIndex = 0;
      for (const match of line.matchAll(INLINE_SEMANTIC_PROPERTY)) {
        const exception = matchingException(manifest, relativePath, line);
        if (!exception) {
          findings.push(
            `${relativePath}:${lineIndex + 1} owns inline ${match[1]} paint; use a primitive variant or add a reviewed domain exception`,
          );
          continue;
        }
        const key = `${exception.source}\u0000${exception.contains}`;
        exceptionUse.set(key, (exceptionUse.get(key) ?? 0) + 1);
      }
    }

    for (const [name, pattern] of Object.entries(LEGACY_CLASS_PATTERNS)) {
      const count = occurrences(source, pattern);
      if (count > 0) {
        findings.push(
          `${relativePath} contains ${count} ${name} occurrence(s); governed sources must compose a typed primitive`,
        );
      }
    }
  }

  for (const exception of manifest.inlineSemanticStyleExceptions) {
    if (!exception.reason?.trim()) {
      findings.push(
        `${exception.source} exception “${exception.contains}” has no review reason`,
      );
    }
    if (
      !Number.isSafeInteger(exception.maxOccurrences) ||
      exception.maxOccurrences < 1
    ) {
      findings.push(
        `${exception.source} exception “${exception.contains}” needs a positive integer maximum`,
      );
    }
    const key = `${exception.source}\u0000${exception.contains}`;
    const actual = exceptionUse.get(key) ?? 0;
    if (actual > exception.maxOccurrences) {
      findings.push(
        `${exception.source} exception “${exception.contains}” grew to ${actual}; maximum is ${exception.maxOccurrences}`,
      );
    } else if (actual < exception.maxOccurrences) {
      findings.push(
        `${exception.source} exception “${exception.contains}” shrank to ${actual}; ratchet maximum ${exception.maxOccurrences}`,
      );
    }
  }

  const skeletonOwnerUse = new Map();
  for (const [relativePath, source] of sourceMap) {
    if (relativePath.startsWith("stories/")) continue;
    const skeletonTags = source.match(/<Skeleton\b[\s\S]*?\/>/g) ?? [];
    const unnamedCount = skeletonTags.filter(
      (tag) => !tag.includes("aria-label="),
    ).length;
    if (unnamedCount === 0) continue;
    const owner = (manifest.skeletonGroupOwners ?? []).find(
      (entry) => entry.source === relativePath,
    );
    if (!owner) {
      findings.push(
        `${relativePath} has ${unnamedCount} unlabelled Skeleton(s) without a reviewed group owner`,
      );
      continue;
    }
    skeletonOwnerUse.set(relativePath, unnamedCount);
    if (!owner.requiresAny.some((evidence) => source.includes(evidence))) {
      findings.push(
        `${relativePath} Skeleton group is missing required owner evidence (${owner.requiresAny.join(" or ")})`,
      );
    }
  }

  for (const owner of manifest.skeletonGroupOwners ?? []) {
    if (!owner.reason?.trim()) {
      findings.push(`${owner.source} Skeleton owner has no review reason`);
    }
    if (!Array.isArray(owner.requiresAny) || owner.requiresAny.length === 0) {
      findings.push(`${owner.source} Skeleton owner has no required evidence`);
    }
    if (!skeletonOwnerUse.has(owner.source)) {
      findings.push(`${owner.source} Skeleton group-owner entry is stale`);
    }
  }

  for (const relativePath of manifest.primitiveSources) {
    const source = sourceMap.get(relativePath);
    if (source == null) {
      findings.push(`primitive source is missing: ${relativePath}`);
      continue;
    }
    if (!source.includes("PrimitiveLayoutStyle")) {
      findings.push(`${relativePath} does not use the layout-only style API`);
    }
    if (/#[\da-f]{3,8}\b|\brgba?\(|\bhsla?\(/i.test(source)) {
      findings.push(`${relativePath} contains a hard-coded color`);
    }
  }

  for (const relativePath of manifest.storySources) {
    if (!sourceMap.has(relativePath)) {
      findings.push(`primitive story is missing: ${relativePath}`);
    }
  }

  return findings;
}

async function readProductionSources(root) {
  const sourceRoot = path.join(root, "src");
  const result = new Map();
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (
        entry.isDirectory() &&
        (entry.name === "__tests__" || entry.name === "stories")
      ) {
        continue;
      }
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(absolute);
      } else if (/\.tsx?$/.test(entry.name)) {
        const relative = path.relative(sourceRoot, absolute).split(path.sep).join("/");
        result.set(relative, await readFile(absolute, "utf8"));
      }
    }
  }
  await walk(sourceRoot);

  // Stories are excluded from the production budgets but still need to exist.
  const storyDirectory = path.join(sourceRoot, "stories");
  for (const entry of await readdir(storyDirectory, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".tsx")) {
      result.set(
        `stories/${entry.name}`,
        await readFile(path.join(storyDirectory, entry.name), "utf8"),
      );
    }
  }
  return result;
}

export async function checkDesignSystem(root = desktopRoot) {
  const manifest = JSON.parse(
    await readFile(path.join(root, "design-system-guardrails.json"), "utf8"),
  );
  const findings = collectDesignSystemFindings(
    await readProductionSources(root),
    manifest,
  );
  if (findings.length > 0) {
    throw new Error(findings.join("\n"));
  }
  return manifest;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const manifest = await checkDesignSystem();
    console.log(
      `[design-system] OK: ${manifest.governedSources.length} governed sources, ${manifest.inlineSemanticStyleExceptions.length} reviewed domain-style exceptions`,
    );
  } catch (error) {
    console.error(`[design-system] FAIL\n${error.message}`);
    process.exitCode = 1;
  }
}
