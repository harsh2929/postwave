import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const deliverability = readFileSync(
  new URL(
    "../../components/deliverability/DeliverabilityHubWorkspace.tsx",
    import.meta.url,
  ),
  "utf8",
);
const campaigns = readFileSync(
  new URL("../../pages/campaigns/CampaignsPresentation.tsx", import.meta.url),
  "utf8",
);

describe("reply mailbox desktop mounts", () => {
  it("mounts management in the deliverability identity workspace", () => {
    expect(deliverability).toContain(
      'import { ReplyMailboxCard } from "./ReplyMailboxCard";',
    );
    expect(deliverability).toContain("<ReplyMailboxCard />");
  });

  it("mounts management beside the tenant reply overview", () => {
    expect(campaigns).toContain(
      'import { ReplyMailboxCard } from "../../components/deliverability/ReplyMailboxCard";',
    );
    expect(campaigns).toContain("<RepliesOverviewCard");
    expect(campaigns).toContain("<ReplyMailboxCard />");
  });
});
