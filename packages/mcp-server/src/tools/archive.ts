// SPDX-License-Identifier: MIT
import { z } from "zod";
import type { PostwaveClient } from "@postwave/sdk";

import type { AnyToolDef } from "../lib/register.js";

export function archiveTools(client: PostwaveClient): AnyToolDef[] {
  return [
    {
      name: "campaign_publish_to_archive",
      description:
        "Mark a sent campaign as publicly visible in the tenant's archive. Optional slug + excerpt control how it shows on the index page.",
      schema: z.object({
        campaign_id: z.string().min(1),
        slug: z.string().optional(),
        excerpt: z.string().optional(),
      }),
      handler: async ({ campaign_id, slug, excerpt }) =>
        client.archive.publish(campaign_id, { slug, excerpt }),
    },
    {
      name: "campaign_unpublish_from_archive",
      description:
        "Hide a previously archived campaign from the public archive. The row is preserved.",
      schema: z.object({ campaign_id: z.string().min(1) }),
      handler: async ({ campaign_id }) => client.archive.unpublish(campaign_id),
    },
    {
      name: "archive_list",
      description:
        "List the tenant's archived campaigns (admin view, cursor-paginated). Optional `q` runs a server-side case-insensitive substring search over subject + slug, so an old issue is reachable without walking every cursor page. Rows carry pinned + viewCount + uniqueVisitors on this admin path.",
      schema: z.object({
        limit: z.number().int().positive().max(100).optional(),
        cursor: z.string().optional(),
        q: z.string().min(1).optional(),
      }),
      handler: async (input) => client.archive.list(input),
    },
  ];
}
