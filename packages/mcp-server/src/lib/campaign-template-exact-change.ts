// SPDX-License-Identifier: MIT
import { createHash } from "node:crypto";

export interface ExactChangeTemplate {
  id: string;
  etag?: string;
  body_html?: string;
  body_mjml?: string;
  template_kind?: string;
  capabilities?: { can_edit_directly?: boolean };
}

export interface ExactChangeInput {
  templateId: string;
  ifMatch: string;
  format: "html" | "mjml";
  find: string;
  replace: string;
}

/** Stateless review receipt. The API's If-Match remains the write authority. */
export function planExactTemplateChange(
  template: ExactChangeTemplate,
  input: ExactChangeInput,
) {
  if (template.id !== input.templateId || template.etag !== input.ifMatch) {
    throw new Error("Template changed since it was loaded. Fetch a fresh ETag and preview again.");
  }
  if (template.template_kind === "reference" || template.capabilities?.can_edit_directly === false) {
    throw new Error("This template is not directly editable.");
  }
  const hasMjml = Boolean(template.body_mjml?.trim());
  if ((hasMjml && input.format !== "mjml") || (!hasMjml && input.format !== "html")) {
    throw new Error("The requested format is not the saved source format. No conversion was attempted.");
  }
  const before = hasMjml ? template.body_mjml ?? "" : template.body_html ?? "";
  if (!before || !input.find || input.find === input.replace) {
    throw new Error("A non-empty saved source and a substantive exact change are required.");
  }
  const index = before.indexOf(input.find);
  if (index < 0) throw new Error("The exact target was not found in the saved source.");
  if (before.indexOf(input.find, index + 1) >= 0) {
    throw new Error("The exact target occurs more than once; narrow the selection.");
  }
  const after = before.slice(0, index) + input.replace + before.slice(index + input.find.length);
  const previewHash = createHash("sha256")
    .update(JSON.stringify([template.id, template.etag, input.format, before, after]))
    .digest("hex");
  return {
    format: input.format,
    before,
    after,
    preview_hash: previewHash,
    before_excerpt: before.slice(Math.max(0, index - 160), index + input.find.length + 160),
    after_excerpt: after.slice(Math.max(0, index - 160), index + input.replace.length + 160),
  };
}
