// SPDX-License-Identifier: MIT
import { z } from "zod";
import type { PostwaveClient } from "@postwave/sdk";

import type { AnyToolDef } from "../lib/register.js";

const PreviewSchema = z.object({
  template: z.string().min(1),
  vars: z.record(z.string(), z.unknown()).optional(),
});

export function templateRenderTools(client: PostwaveClient): AnyToolDef[] {
  return [
    {
      name: "template_preview",
      description:
        "Render a conditional MJML/HTML template with the supplied vars. Supports {{#if a == \"x\"}}...{{else}}...{{/if}} and {{#if has subscriber.tag \"vip\"}}...{{/if}}.",
      schema: PreviewSchema,
      handler: async (input) =>
        client.templatePreview.preview({
          template: input.template,
          vars: input.vars ?? {},
        }),
    },
    {
      name: "template_render",
      description:
        "Alias of template_preview. Use whichever name reads better in your prompt; both call the same backend.",
      schema: PreviewSchema,
      handler: async (input) =>
        client.templatePreview.render({
          template: input.template,
          vars: input.vars ?? {},
        }),
    },
  ];
}
