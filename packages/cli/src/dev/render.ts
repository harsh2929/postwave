// SPDX-License-Identifier: MIT

import { readFile, stat } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { createRequire } from "node:module";

export interface RenderedEmail {
  html: string;
  mjml: string;
  errors: string[];
}

interface RenderToHtmlFn {
  (
    element: unknown,
    opts?: { validationLevel?: "strict" | "soft" | "skip" },
  ): Promise<{
    html: string;
    mjml: string;
    errors: string[];
  }>;
}

interface RenderMjmlToHtmlFn {
  (
    mjml: string,
    opts?: { validationLevel?: "strict" | "soft" | "skip" },
  ): Promise<{
    html: string;
    mjml: string;
    errors: string[];
  }>;
}

interface RendererModule {
  renderToHtml: RenderToHtmlFn;
  renderMjmlToHtml?: RenderMjmlToHtmlFn;
}

let cachedRenderer: RendererModule | null = null;
const MAX_RENDER_SOURCE_BYTES = 2 * 1024 * 1024;

async function loadRenderer(): Promise<RendererModule> {
  if (cachedRenderer) return cachedRenderer;
  cachedRenderer = (await import("@postwave/email-react")) as RendererModule;
  return cachedRenderer;
}

/**
 * Resolve and dynamically import a `*.email.tsx` file from the user's
 * project, then run it through the email-react MJML pipeline. The user
 * is responsible for having `tsx` installed so that Node can load the
 * `.tsx` source.
 */
export async function renderEmailFile(
  filePath: string,
  variables: Record<string, unknown> = {},
): Promise<RenderedEmail> {
  const abs = resolve(filePath);
  await assertRenderableSourceSize(abs);
  if (abs.toLowerCase().endsWith(".mjml")) {
    const mjml = await readFile(abs, "utf8");
    const renderer = await loadRenderer();
    if (!renderer.renderMjmlToHtml) {
      throw new Error(
        "Rendering raw .mjml files requires @postwave/email-react >= 0.1.0.",
      );
    }
    return renderer.renderMjmlToHtml(mjml, { validationLevel: "soft" });
  }

  await ensureTsxLoader(abs);

  let mod: { default?: unknown } & Record<string, unknown>;
  try {
    mod = (await import(pathToFileURL(abs).href)) as typeof mod;
  } catch (err) {
    throw new Error(
      `Failed to import ${abs}. Ensure 'tsx' is installed in your project ` +
        `(npm i -D tsx) and that you are running Node with --import tsx. ` +
        `Underlying error: ${(err as Error).message}`,
    );
  }

  const exportPick = pickEmailExport(mod);
  if (!exportPick) {
    throw new Error(
      `${abs} has no default export and no named export resembling an Email component.`,
    );
  }

  const element = invokeEmail(exportPick, variables);
  const renderer = await loadRenderer();
  return renderer.renderToHtml(element, { validationLevel: "soft" });
}

async function assertRenderableSourceSize(filePath: string): Promise<void> {
  const info = await stat(filePath);
  if (info.size > MAX_RENDER_SOURCE_BYTES) {
    throw new Error(
      `Email source is too large (${info.size} bytes, max ${MAX_RENDER_SOURCE_BYTES}).`,
    );
  }
}

function pickEmailExport(mod: Record<string, unknown>): unknown {
  if (
    typeof mod.default === "function" ||
    (mod.default && typeof mod.default === "object")
  ) {
    return mod.default;
  }
  for (const [, v] of Object.entries(mod)) {
    if (typeof v === "function") return v;
  }
  return null;
}

function invokeEmail(
  exp: unknown,
  variables: Record<string, unknown>,
): unknown {
  if (typeof exp === "function") {
    const factory = exp as (props: Record<string, unknown>) => unknown;
    return factory(variables);
  }
  return exp;
}

async function ensureTsxLoader(filePath: string): Promise<void> {
  if (!filePath.endsWith(".tsx") && !filePath.endsWith(".ts")) return;
  try {
    const req = createRequire(import.meta.url);
    req.resolve("tsx", { paths: [process.cwd()] });
  } catch {
    throw new Error(
      "Loading .email.tsx requires `tsx`. Install it with `npm i -D tsx` " +
        "and re-run `postwave dev` via `node --import tsx node_modules/.bin/postwave dev`.",
    );
  }
}
