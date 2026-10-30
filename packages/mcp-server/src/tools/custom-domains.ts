// SPDX-License-Identifier: MIT
import { z } from "zod";
import type { PostwaveClient } from "@postwave/sdk";

import type { AnyToolDef } from "../lib/register.js";

const PurposeSchema = z.enum(["forms", "links", "web"]);

export function customDomainTools(client: PostwaveClient): AnyToolDef[] {
  return [
    {
      name: "custom_domain_create",
      description:
        "Register a custom domain for hosted forms, link redirects, or the public archive. Returns DNS records the operator must publish before verification will succeed.",
      schema: z.object({
        domain: z.string().min(3),
        purpose: PurposeSchema,
      }),
      handler: async (input) => client.customDomains.create(input),
    },
    {
      name: "custom_domain_list",
      description: "List every custom domain registered for the current tenant.",
      schema: z.object({}),
      handler: async () => client.customDomains.list(),
    },
    {
      name: "custom_domain_verify",
      description:
        "Recheck the DNS records for a custom domain. Flips the row to verified=true when every record we asked for is present.",
      schema: z.object({ id: z.string().min(1) }),
      handler: async ({ id }) => client.customDomains.verify(id),
    },
    {
      name: "custom_domain_delete",
      description: "Delete a custom domain registration. Idempotent for missing rows.",
      schema: z.object({ id: z.string().min(1) }),
      handler: async ({ id }) => client.customDomains.delete(id),
    },
  ];
}
