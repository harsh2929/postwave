// SPDX-License-Identifier: MIT

declare module "@postwave/email-react" {
  export interface RenderToHtmlOptions {
    validationLevel?: "strict" | "soft" | "skip";
  }

  export interface RenderToHtmlResult {
    html: string;
    mjml: string;
    errors: string[];
  }

  export function renderToHtml(
    element: unknown,
    opts?: RenderToHtmlOptions,
  ): Promise<RenderToHtmlResult>;

  export function renderMjmlToHtml(
    mjml: string,
    opts?: RenderToHtmlOptions,
  ): Promise<RenderToHtmlResult>;
}
