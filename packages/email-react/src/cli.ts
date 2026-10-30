#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// postwave-email-render — render a React/JSX email component to MJML or
// to compiled HTML on stdout.
//
// Usage:
//   postwave-email-render ./Welcome.tsx
//   postwave-email-render ./Welcome.tsx --out html
//   postwave-email-render ./Welcome.tsx --out mjml
//
// The component file MUST default-export a React element factory or a
// React element directly. Examples:
//
//   export default <Email>…</Email>;
//   export default function Welcome() { return <Email>…</Email>; }

import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import type { ReactElement } from "react";
import { renderToHtml } from "./render/to-html.js";
import { renderToMjml } from "./render/to-mjml.js";

interface ParsedArgs {
  input?: string;
  out: "html" | "mjml";
  help: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = { out: "html", help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--out") {
      const v = argv[++i];
      if (v !== "html" && v !== "mjml") {
        throw new Error(`--out must be 'html' or 'mjml' (got ${String(v)})`);
      }
      out.out = v;
    } else if (a && !a.startsWith("-") && !out.input) {
      out.input = a;
    }
  }
  return out;
}

function printHelp(): void {
  process.stdout.write(
    [
      "postwave-email-render <Component.tsx> [--out html|mjml]",
      "",
      "Render a React email component to MJML source or to compiled HTML.",
      "The component file must default-export either a React element or a",
      "zero-arg function that returns one.",
      "",
      "Options:",
      "  --out html|mjml   Output format. Default: html.",
      "  -h, --help        Show this message.",
      "",
      "Note: rendering .tsx requires a TypeScript runtime in your project,",
      "such as `tsx` or `ts-node`. Install with: npm i -D tsx",
      "Then run: npx tsx node_modules/.bin/postwave-email-render <file>",
      "",
    ].join("\n"),
  );
}

async function loadDefault(file: string): Promise<unknown> {
  const abs = resolve(process.cwd(), file);
  const url = pathToFileURL(abs).href;
  try {
    const mod = (await import(url)) as { default?: unknown };
    return mod.default;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (file.endsWith(".tsx") || file.endsWith(".ts")) {
      throw new Error(
        `Failed to load ${file}: ${msg}\n\n` +
          `Hint: rendering TypeScript requires a TS runtime such as 'tsx'.\n` +
          `Install it (npm i -D tsx) and re-run via:\n` +
          `  npx tsx node_modules/.bin/postwave-email-render ${file}`,
      );
    }
    throw new Error(`Failed to load ${file}: ${msg}`);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.input) {
    printHelp();
    process.exitCode = args.input ? 0 : 1;
    return;
  }
  const exported = await loadDefault(args.input);
  if (exported === undefined) {
    throw new Error(`${args.input} has no default export`);
  }
  const element = (
    typeof exported === "function" ? (exported as () => unknown)() : exported
  ) as ReactElement;

  if (args.out === "mjml") {
    process.stdout.write(renderToMjml(element));
    process.stdout.write("\n");
    return;
  }
  const { html, errors } = await renderToHtml(element);
  if (errors.length > 0) {
    for (const e of errors) process.stderr.write(`mjml warning: ${e}\n`);
  }
  process.stdout.write(html);
  process.stdout.write("\n");
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`postwave-email-render: ${msg}\n`);
  process.exit(1);
});
