import { getClient } from "@/api/client";
import { normalizeAssuranceOverrideReason } from "@/lib/campaignAssuranceOverride";
import { newOfflineOperationId } from "@/lib/offlineMutations";

export interface RecordCampaignAssuranceOverrideInput {
  campaignId: string;
  runId: string;
  findingId: string;
  decision: "allow_send" | "reject";
  reason: string;
}

export async function recordCampaignAssuranceOverride(
  input: RecordCampaignAssuranceOverrideInput,
): Promise<void> {
  const reason = normalizeAssuranceOverrideReason(input.reason);
  const { client } = getClient();
  await client.campaignAssurance.overrideFinding(
    input.campaignId,
    input.runId,
    input.findingId,
    {
      request_id: newOfflineOperationId(),
      decision: input.decision,
      reason,
    },
  );
}
