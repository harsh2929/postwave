import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = join(desktopRoot, "src");

function productionSources(directory = sourceRoot) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (
      entry.isDirectory() &&
      (entry.name === "__tests__" || entry.name === "stories")
    ) {
      return [];
    }
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return productionSources(path);
    return entry.isFile() && /\.(?:css|mjs|ts|tsx)$/.test(entry.name)
      ? [path]
      : [];
  });
}

function varCalls(source) {
  const calls = [];
  for (let start = source.indexOf("var("); start >= 0; start = source.indexOf("var(", start + 4)) {
    let depth = 1;
    let end = start + 4;
    for (; end < source.length && depth > 0; end += 1) {
      if (source[end] === "(") depth += 1;
      else if (source[end] === ")") depth -= 1;
    }
    if (depth === 0) calls.push({ start, content: source.slice(start + 4, end - 1) });
  }
  return calls;
}

function hasTopLevelFallback(content) {
  let depth = 0;
  for (const character of content) {
    if (character === "(") depth += 1;
    else if (character === ")") depth -= 1;
    else if (character === "," && depth === 0) return true;
  }
  return false;
}

test("every fallback-free desktop CSS token reference has a source definition", () => {
  const files = productionSources();
  const definitions = new Set();
  for (const path of files.filter((candidate) => candidate.endsWith(".css"))) {
    const source = readFileSync(path, "utf8");
    for (const match of source.matchAll(/(--pw-[a-z0-9-]+)\s*:/giu)) {
      definitions.add(match[1]);
    }
  }

  const findings = [];
  for (const path of files) {
    const source = readFileSync(path, "utf8");
    for (const call of varCalls(source)) {
      const token = /^\s*(--pw-[a-z0-9-]+)/iu.exec(call.content)?.[1];
      if (!token || definitions.has(token) || hasTopLevelFallback(call.content)) {
        continue;
      }
      const line = source.slice(0, call.start).split(/\r\n|\r|\n/u).length;
      findings.push(`${relative(sourceRoot, path)}:${line} references undefined ${token}`);
    }
  }

  assert.deepEqual(findings, []);
});

test("the focus-shadow token is never substituted where a color is required", () => {
  const findings = [];
  for (const path of productionSources().filter((candidate) => candidate.endsWith(".css"))) {
    const source = readFileSync(path, "utf8");
    for (const [index, line] of source.split(/\r\n|\r|\n/u).entries()) {
      if (
        /(?:outline|border(?:-color)?|color)\s*:[^;]*var\(--pw-focus-ring\)/u.test(
          line,
        )
      ) {
        findings.push(`${relative(sourceRoot, path)}:${index + 1}`);
      }
    }
  }
  assert.deepEqual(findings, []);
});
