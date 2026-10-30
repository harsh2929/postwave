// SPDX-License-Identifier: MIT
import { z } from "zod";
import type { PostwaveClient } from "@postwave/sdk";

import type { AnyToolDef } from "../lib/register.js";

const VoiceDriftSchema = z.object({
  html: z
    .string()
    .min(1)
    .max(500_000)
    .describe("The draft email body (HTML or MJML-rendered HTML) to score."),
  text: z
    .string()
    .max(500_000)
    .optional()
    .describe("Optional plain-text rendition of the body, used when present instead of stripping HTML."),
  profile_id: z
    .string()
    .trim()
    .max(200)
    .optional()
    .describe("Voice profile to compare against. Defaults to the tenant's active profile."),
});

export function voiceDriftTools(client: PostwaveClient): AnyToolDef[] {
  return [
    {
      name: "voice_drift_check",
      description:
        "Pre-send voice-fidelity check. Scores a draft body (0-100) against the tenant's voice profile and returns a severity ('ok' | 'warn' | 'critical') plus an optional reason, per-component breakdown, and suggestions. Advisory only — do not gate sends on it. Runs heuristic-only when no embedding client is configured.",
      schema: VoiceDriftSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
      handler: async ({ html, text, profile_id }) => {
        try {
          return await client.voiceDrift.check({ html, text, profile_id });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          throw new Error(`voice_drift_check: ${msg}`);
        }
      },
    },
  ];
}
