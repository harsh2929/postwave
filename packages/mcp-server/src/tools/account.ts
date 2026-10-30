// SPDX-License-Identifier: MIT
import { z } from "zod";
import type { PostwaveClient } from "@postwave/sdk";

import type { AnyToolDef } from "../lib/register.js";

// The tenant sending-identity lives on the workspace-settings surface
// (PATCH /api/v1/settings/workspace), NOT on /api/v1/me (which is
// GET-only). Its mutable from-identity fields are display_name (the
// outbound "from" display name) and default_reply_to. A verified sending
// DOMAIN is provisioned separately through the DKIM wizard
// (/api/v1/sending-identities), so it is intentionally not a field here.
const AccountUpdateSchema = z
  .object({
    display_name: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .optional()
      .describe("Display name on outbound mail, e.g. 'Acme Team'."),
    default_reply_to: z
      .string()
      .trim()
      .email()
      .max(320)
      .optional()
      .describe("Default reply-to address for outbound mail."),
  })
  .refine(
    (v) => v.display_name !== undefined || v.default_reply_to !== undefined,
    { message: "supply at least one of display_name, default_reply_to" },
  );

export function accountTools(client: PostwaveClient): AnyToolDef[] {
  return [
    {
      name: "account_whoami",
      description:
        "Return the identity the configured API key resolves to: the tenant and (when the key is user-scoped) the user. Use this to confirm which workspace you are operating against before making changes.",
      schema: z.object({}),
      annotations: { readOnlyHint: true },
      handler: async () => {
        try {
          return await client.account.me();
        } catch (err) {
          throw wrapErr("account_whoami", err);
        }
      },
    },
    {
      name: "account_sending_identity_update",
      description:
        "Update the tenant's sending identity (workspace defaults): display_name (the outbound 'from' display name) and/or default_reply_to (default reply-to address). Supply only the fields you want to change. Returns the updated workspace settings. To add or verify a sending DOMAIN, use the sending-identities (DKIM) wizard instead.",
      schema: AccountUpdateSchema,
      annotations: { idempotentHint: true },
      handler: async (input) => {
        try {
          return await client.account.update(input);
        } catch (err) {
          throw wrapErr("account_sending_identity_update", err);
        }
      },
    },
  ];
}

function wrapErr(tool: string, err: unknown): Error {
  const msg = err instanceof Error ? err.message : String(err);
  return new Error(`${tool}: ${msg}`);
}
