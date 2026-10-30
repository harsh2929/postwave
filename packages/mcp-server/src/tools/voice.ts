// SPDX-License-Identifier: MIT
import { z } from "zod";
import type { PostwaveClient } from "@postwave/sdk";

import { validateUrl } from "../lib/security.js";
import type { AnyToolDef } from "../lib/register.js";

const VoiceSourceTypeEnum = z.enum(["rss", "twitter", "transcript", "paste", "url"]);
const IdSchema = z.string().trim().min(1).max(200);
const VoiceParamsSchema = z.object({
  url: z.string().url().optional(),
  handle: z.string().trim().max(80).optional(),
  text: z.string().trim().max(200_000).optional(),
});
const VoiceSourceAddSchema = z
  .object({
    type: VoiceSourceTypeEnum,
    params: VoiceParamsSchema.describe("Type-specific payload (url for rss/url; handle for twitter; text for paste/transcript)."),
  })
  .superRefine((value, ctx) => {
    if ((value.type === "rss" || value.type === "url") && !value.params.url) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["params", "url"],
        message: "url is required for rss/url voice sources",
      });
    }
    if (value.type === "twitter" && !value.params.handle) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["params", "handle"],
        message: "handle is required for twitter voice sources",
      });
    }
    if ((value.type === "paste" || value.type === "transcript") && !value.params.text) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["params", "text"],
        message: "text is required for paste/transcript voice sources",
      });
    }
  });

export function voiceTools(client: PostwaveClient): AnyToolDef[] {
  return [
    {
      name: "voice_profile_get",
      description:
        "Fetch the tenant's current voice profile. Includes tonality vector, pacing, characteristic phrasings, and the list of ingested sources used to build it.",
      schema: z.object({}),
      handler: async () => client.voiceProfile.get(),
    },
    {
      name: "voice_source_add",
      description:
        "Register a new ingestion source for voice training. URL-bearing sources (rss, url) are SSRF-validated. Pasted text is stored in-place.",
      schema: VoiceSourceAddSchema,
      handler: async ({ type, params }) => {
        if (params.url) validateUrl(params.url);
        return client.voiceProfile.addSource({
          type: type as never,
          params: params as never,
        });
      },
    },
    {
      name: "voice_profile_build",
      description:
        "Re-compute the voice profile from currently-ingested sources. Run after adding new sources via voice_source_add.",
      schema: z.object({}),
      timeoutMs: 60_000,
      handler: async () => client.voiceProfile.build(),
    },
    {
      name: "sequence_generate",
      description:
        "Generate a multi-email sequence from one of the 50 templates, written in the tenant's voice. Returns a full Sequence with per-email fidelity scores.",
      schema: z.object({
        template_id: IdSchema,
        variables: z.record(z.string().min(1).max(80), z.string().max(2_000)).optional(),
        style_controls: z
          .object({
            length: z.enum(["short", "medium", "long"]).optional(),
            formality: z.enum(["casual", "neutral", "formal"]).optional(),
          })
          .optional(),
      }),
      timeoutMs: 60_000,
      handler: async ({ template_id, variables, style_controls }) =>
        client.sequences.generate({
          template_id,
          variables: variables ?? {},
          style_controls: style_controls ?? {},
        } as never),
    },
    {
      name: "sequence_regenerate_email",
      description:
        "Regenerate a single email at the given position within a sequence. Pass an optional hint string to nudge the rewrite (e.g. 'shorter', 'more direct opening').",
      schema: z.object({
        sequence_id: IdSchema,
        position: z.number().int().min(1),
        hint: z.string().max(2_000).optional(),
      }),
      timeoutMs: 60_000,
      handler: async ({ sequence_id, position, hint }) =>
        client.sequences.regenerate(sequence_id, position, { hint } as never),
    },
  ];
}
