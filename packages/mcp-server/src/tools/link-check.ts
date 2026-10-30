// SPDX-License-Identifier: MIT
import { z } from "zod";
import type { PostwaveClient } from "@postwave/sdk";

import type { AnyToolDef } from "../lib/register.js";

export function linkCheckTools(client: PostwaveClient): AnyToolDef[] {
  return [
    {
      name: "campaign_check_links",
      description:
        "Pre-send link check. Extracts every absolute href from the campaign body and HEAD-requests each (5s timeout, dedupe). Returns one result per URL with its HTTP status.",
      schema: z.object({ campaign_id: z.string().min(1) }),
      timeoutMs: 60_000,
      handler: async ({ campaign_id }) => client.linkCheck.check(campaign_id),
    },
  ];
}
