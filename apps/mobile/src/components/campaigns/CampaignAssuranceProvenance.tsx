import type {
  CampaignAssuranceEvidence,
  CampaignAssuranceLatest,
} from "@postwave/sdk";
import { View } from "react-native";

import { ReceiptValue } from "@/components/campaigns/CampaignAssurancePrimitives";
import { MOBILE_ASSURANCE_SOURCE_LABELS } from "@/lib/campaignAssurance";
import { useTheme } from "@/lib/theme";

export function CampaignAssuranceProvenance({
  receipt,
  evidence,
}: {
  receipt: CampaignAssuranceLatest;
  evidence: CampaignAssuranceEvidence | null;
}) {
  const { t } = useTheme();
  const run = receipt.detail.run;
  return (
    <View style={{ gap: 7 }}>
      <ReceiptValue label="Run ID" value={run.id} />
      <ReceiptValue label="Frozen revision" value={run.content_revision_id} />
      <ReceiptValue label="Send plan" value={run.send_plan_id} />
      <ReceiptValue label="Source hash" value={run.source_hash} hash />
      <ReceiptValue label="Plan hash" value={run.plan_hash} hash />
      <ReceiptValue
        label="Artifact set hash"
        value={run.artifact_set_hash}
        hash
      />
      <ReceiptValue
        label="Coverage manifest hash"
        value={run.coverage_manifest_hash}
        hash
      />
      <ReceiptValue
        label="Configuration manifest hash"
        value={run.configuration_manifest_hash}
        hash
      />
      <ReceiptValue
        label="Target manifest hash"
        value={run.target_manifest_hash}
        hash
      />
      <ReceiptValue label="Profile" value={run.profile} />
      <ReceiptValue label="Run state" value={run.state} />
      <ReceiptValue label="Gate decision" value={run.gate_decision} />
      <ReceiptValue
        label="Extraction coverage"
        value={`${run.successful_extraction_count}/${run.required_extraction_count} successful · ${run.extraction_error_count} error(s)`}
      />
      <ReceiptValue
        label="Predicted score range"
        value={
          run.overall_score == null
            ? "Unavailable"
            : `${run.overall_score} (${run.score_min ?? "—"}–${run.score_max ?? "—"})`
        }
      />
      <ReceiptValue
        label="Agreement"
        value={run.agreement == null ? "Unavailable" : String(run.agreement)}
      />
      <ReceiptValue
        label="Findings"
        value={`${run.finding_count} total · ${run.blocking_finding_count} blocking`}
      />
      <ReceiptValue label="Renderer" value={run.renderer_version} />
      <ReceiptValue label="Compiler" value={run.compiler_version} />
      <ReceiptValue label="Analyzer suite" value={run.analyzer_suite_version} />
      <ReceiptValue label="Model suite" value={run.model_suite_version} />
      <ReceiptValue label="Prompt suite" value={run.prompt_suite_version} />
      <ReceiptValue label="Normalization" value={run.normalization_version} />
      <ReceiptValue label="Scoring" value={run.scoring_version} />
      <ReceiptValue label="Gate policy" value={run.gate_policy_version} />
      <ReceiptValue label="Methodology" value={run.methodology_version} />
      <ReceiptValue
        label="Modeled cost (µ-units)"
        value={String(run.cost_microunits)}
      />
      <ReceiptValue
        label="Frozen cost ceiling (µ-units)"
        value={String(run.max_modeled_cost_microunits)}
      />
      <ReceiptValue
        label="Provider tokens"
        value={`${run.input_tokens} input · ${run.output_tokens} output`}
      />
      <ReceiptValue label="Latency (ms)" value={String(run.latency_ms)} />
      <ReceiptValue
        label="Frozen artifacts"
        value={String(receipt.detail.manifest.artifacts.length)}
      />
      <ReceiptValue
        label="Analyzer configurations"
        value={String(receipt.detail.manifest.configurations.length)}
      />
      <ReceiptValue
        label="Exact targets"
        value={String(receipt.detail.manifest.targets.length)}
      />
      <ReceiptValue
        label="Governed override receipts"
        value={
          evidence == null
            ? "Unavailable on this read"
            : String(evidence.overrides.total)
        }
      />
      <ReceiptValue label="Created" value={run.created_at} />
      <ReceiptValue label="Updated" value={run.updated_at} />
      <ReceiptValue
        label="Completed"
        value={run.completed_at ?? "Not completed"}
      />
      <ReceiptValue
        label="Applicability basis"
        value={receipt.applicability.basis}
      />
      {evidence?.extractions.items.map((extraction) => (
        <View
          key={extraction.id}
          style={{
            borderTopColor: t.borderSubtle,
            borderTopWidth: 1,
            paddingTop: 7,
            gap: 5,
          }}
        >
          <ReceiptValue
            label={`${MOBILE_ASSURANCE_SOURCE_LABELS[extraction.source_class]} extraction receipt`}
            value={extraction.receipt_hash}
            hash
          />
          {extraction.source_class === "modeled" ? (
            <ReceiptValue
              label="Modeled execution"
              value={`${extraction.model_provider || "provider unavailable"} / ${extraction.model_id || "model unavailable"} / ${extraction.model_version || "version unavailable"} · ${extraction.execution_kind === "cache_reuse" ? "exact-cache reuse" : extraction.execution_kind === "invoked" ? "provider invocation" : "execution lineage unavailable"}`}
            />
          ) : null}
          {extraction.execution_kind === "cache_reuse" &&
          extraction.reused_from_receipt_hash ? (
            <ReceiptValue
              label="Invoked-origin receipt"
              value={extraction.reused_from_receipt_hash}
              hash
            />
          ) : null}
        </View>
      ))}
    </View>
  );
}
