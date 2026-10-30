// SPDX-License-Identifier: MIT
import type * as React from "react";
import mjml2html from "mjml";
import { renderToMjml } from "./to-mjml.js";

interface MjmlResult {
  html: string;
  errors?: { formattedMessage?: string; message?: string }[];
}

const MJ_INCLUDE_RE = /<\s*mj-include\b/i;

type MjmlCompiler = (
  mjml: string,
  options: {
    validationLevel: "strict" | "soft" | "skip";
    minify: boolean;
    keepComments: boolean;
    ignoreIncludes: true;
    useMjmlConfigOptions: false;
  },
) => MjmlResult | Promise<MjmlResult>;

export interface RenderToHtmlOptions {
  /** MJML validation level. Defaults to "soft". */
  validationLevel?: "strict" | "soft" | "skip";
  /** Minify the resulting HTML. Defaults to false. */
  minify?: boolean;
  /** Keep MJML comments in the output. Defaults to false. */
  keepComments?: boolean;
}

export interface RenderToHtmlResult {
  /** Compiled, email-safe HTML string. */
  html: string;
  /** The intermediate MJML source (handy for debugging). */
  mjml: string;
  /** Per-error messages from the MJML compiler. Empty array if all OK. */
  errors: string[];
}

/**
 * Render a React tree to email-safe HTML by going through MJML.
 *
 *   const { html, errors } = await renderToHtml(<Email>…</Email>);
 *
 * Returns the HTML and a list of any non-fatal MJML warnings. Throws if
 * the MJML compiler raises an exception (e.g. malformed input).
 */
export async function renderToHtml(
  element: React.ReactElement,
  opts: RenderToHtmlOptions = {},
): Promise<RenderToHtmlResult> {
  const mjml = renderToMjml(element);
  return renderMjmlToHtml(mjml, opts);
}

export async function renderMjmlToHtml(
  mjml: string,
  opts: RenderToHtmlOptions = {},
): Promise<RenderToHtmlResult> {
  // MJML 4.x can resolve <mj-include> paths from the compiler host. This
  // package accepts caller-provided MJML, so reject includes before invoking
  // the compiler and also disable both include resolution and config options
  // as defense in depth even on patched MJML releases.
  if (MJ_INCLUDE_RE.test(mjml)) {
    throw new Error("mj-include is not supported");
  }

  const result = await (mjml2html as unknown as MjmlCompiler)(mjml, {
    validationLevel: opts.validationLevel ?? "soft",
    minify: opts.minify ?? false,
    keepComments: opts.keepComments ?? false,
    ignoreIncludes: true,
    useMjmlConfigOptions: false,
  });
  const errors = (result.errors ?? []).map(
    (e: { formattedMessage?: string; message?: string }) =>
      e.formattedMessage ?? e.message ?? "",
  );
  return { html: result.html, mjml, errors };
}
