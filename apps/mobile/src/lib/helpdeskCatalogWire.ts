/**
 * The service-suite catalog.
 *
 * Every capability, guardrail, channel and agent-run type is compared against
 * the value this client release was written for, and a mismatch throws. The
 * catalog is the server telling mobile what is HELD; accepting an unknown
 * shape would turn a held capability into an inferred one.
 */
import { exactObject, stringList, token } from "@/lib/helpdeskContract";
import {
  HELPDESK_CONVERSATION_STATUSES,
  HelpdeskContractError,
  type CapabilityStatus,
  type HelpdeskCatalog,
} from "@/lib/helpdeskTypes";

function capability(
  value: unknown,
  label: string,
  expectedStatus: string,
  expectedCode: string | null,
  expectedExecutionMode: string | null = null,
): CapabilityStatus {
  const raw = exactObject(value, label, [
    "status",
    ...(expectedCode === null ? [] : ["code"]),
    ...(expectedExecutionMode === null ? [] : ["execution_mode"]),
  ]);
  const status = token(raw["status"], label + ".status", true) as string;
  const code = token(raw["code"], label + ".code");
  const executionMode = token(raw["execution_mode"], label + ".execution_mode");
  if (
    status !== expectedStatus ||
    code !== expectedCode ||
    executionMode !== expectedExecutionMode
  ) {
    throw new HelpdeskContractError(
      label + " does not match this client release",
    );
  }
  return { status, code, executionMode };
}

export function normalizeServiceCatalog(value: unknown): HelpdeskCatalog {
  const raw = exactObject(value, "catalog", [
    "schema_version",
    "provenance",
    "agent_run_types",
    "channels",
    "conversation_statuses",
    "capabilities",
    "guardrail",
  ]);
  if (raw["schema_version"] !== "postwave.service_suite.v2") {
    throw new HelpdeskContractError(
      "service-suite schema version is unsupported",
    );
  }
  const statuses = stringList(
    raw["conversation_statuses"],
    "conversation_statuses",
  ).map((status) => token(status, "conversation_status", true) as string);
  if (
    statuses.length !== HELPDESK_CONVERSATION_STATUSES.length ||
    statuses.some(
      (status, index) => status !== HELPDESK_CONVERSATION_STATUSES[index],
    )
  ) {
    throw new HelpdeskContractError(
      "conversation statuses do not match this client release",
    );
  }
  const capabilities = exactObject(raw["capabilities"], "capabilities", [
    "outbound_reply_delivery",
    "inbound_email_bridge",
    "internal_notes",
    "privacy_lifecycle",
    "customer_hub_runtime",
    "channel_runtime",
    "customer_agent",
    "macro_usage_evidence",
    "spam_assessment_write",
    "resource_creation",
  ]);
  const guardrail = exactObject(raw["guardrail"], "guardrail", [
    "draft_only",
    "provider_executed",
    "customer_mutations",
    "requires_human_review",
  ]);
  const provenance = exactObject(raw["provenance"], "provenance", [
    "tenant_bound",
    "source",
  ]);
  if (
    provenance["tenant_bound"] !== false ||
    provenance["source"] !== "static_server_catalog"
  ) {
    throw new HelpdeskContractError(
      "service-suite catalog provenance is unsupported",
    );
  }
  if (
    guardrail["draft_only"] !== true ||
    guardrail["provider_executed"] !== false ||
    guardrail["customer_mutations"] !== false ||
    guardrail["requires_human_review"] !== true
  ) {
    throw new HelpdeskContractError("service-suite guardrail is unsupported");
  }
  const agentRunTypes = stringList(raw["agent_run_types"], "agent_run_types");
  const expectedAgentRunTypes = ["draft_reply", "triage", "handoff", "summary"];
  if (
    agentRunTypes.length !== expectedAgentRunTypes.length ||
    agentRunTypes.some(
      (runType, index) => runType !== expectedAgentRunTypes[index],
    )
  ) {
    throw new HelpdeskContractError(
      "agent run types do not match this client release",
    );
  }
  const expectedChannels = [
    ["web_chat", "Web chat"],
    ["email", "Email"],
    ["sms", "SMS"],
    ["instagram", "Instagram"],
    ["whatsapp", "WhatsApp"],
    ["facebook", "Facebook"],
  ] as const;
  const channels = raw["channels"];
  if (!Array.isArray(channels) || channels.length !== expectedChannels.length) {
    throw new HelpdeskContractError(
      "catalog channels do not match this client release",
    );
  }
  channels.forEach((value, index) => {
    const channel = exactObject(value, `channels[${index}]`, [
      "key",
      "label",
      "runtime_status",
    ]);
    const expected = expectedChannels[index];
    if (
      !expected ||
      channel["key"] !== expected[0] ||
      channel["label"] !== expected[1] ||
      channel["runtime_status"] !== "held"
    ) {
      throw new HelpdeskContractError(
        "catalog channels do not match this client release",
      );
    }
  });
  // Mobile has no channel runtime or agent-run action surface. These frozen
  // arrays are validation-only so a changed catalog fails closed instead of
  // becoming an inferred client capability.
  return {
    schemaVersion: "postwave.service_suite.v2",
    provenance: {
      tenantBound: false,
      source: "static_server_catalog",
    },
    statuses,
    capabilities: {
      outboundReplyDelivery: capability(
        capabilities["outbound_reply_delivery"],
        "outbound_reply_delivery",
        "held",
        "helpdesk_delivery_unavailable",
      ),
      inboundEmailBridge: capability(
        capabilities["inbound_email_bridge"],
        "inbound_email_bridge",
        "held",
        null,
      ),
      internalNotes: capability(
        capabilities["internal_notes"],
        "internal_notes",
        "available",
        null,
      ),
      privacyLifecycle: capability(
        capabilities["privacy_lifecycle"],
        "privacy_lifecycle",
        "held",
        null,
      ),
      customerHubRuntime: capability(
        capabilities["customer_hub_runtime"],
        "customer_hub_runtime",
        "held",
        "customer_hub_runtime_unavailable",
      ),
      channelRuntime: capability(
        capabilities["channel_runtime"],
        "channel_runtime",
        "held",
        "helpdesk_channel_runtime_unavailable",
      ),
      customerAgent: capability(
        capabilities["customer_agent"],
        "customer_agent",
        "held",
        "customer_agent_draft_write_held",
        "deterministic_template_only",
      ),
      macroUsageEvidence: capability(
        capabilities["macro_usage_evidence"],
        "macro_usage_evidence",
        "held",
        "macro_usage_evidence_unavailable",
      ),
      spamAssessmentWrite: capability(
        capabilities["spam_assessment_write"],
        "spam_assessment_write",
        "held",
        "spam_assessment_write_held",
      ),
      resourceCreation: capability(
        capabilities["resource_creation"],
        "resource_creation",
        "held",
        "helpdesk_create_replay_unavailable",
      ),
    },
    guardrail: {
      draftOnly: true,
      providerExecuted: false,
      customerMutations: false,
      requiresHumanReview: true,
    },
  };
}
