// SPDX-License-Identifier: MIT
import { z } from "zod";
import type { PostwaveClient } from "@postwave/sdk";

import type { AnyToolDef } from "../lib/register.js";

export function referralTools(client: PostwaveClient): AnyToolDef[] {
  return [
    {
      name: "referral_program_get",
      description:
        "Inspect the tenant's last active referral-program configuration. This is historical configuration data; live attribution, program changes, subscriber links, and reward operations remain release-gated.",
      schema: z.object({}),
      handler: async () => client.referrals.getProgram(),
    },
  ];
}
